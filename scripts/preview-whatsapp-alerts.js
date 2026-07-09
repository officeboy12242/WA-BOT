/**
 * Preview exact WhatsApp messages for daily trade alerts (no send).
 * Run: node scripts/preview-whatsapp-alerts.js [--analyze 2]
 */

import 'dotenv/config';
import { config } from '../src/config/config.js';
import { createTradeDiscoveryEngine } from '../src/services/TradeDiscoveryEngine.js';
import { createTradeResearchService } from '../src/services/TradeResearchService.js';
import GeminiTradeService from '../src/services/GeminiTradeService.js';
import {
    TRADE_ANALYSIS_SYSTEM_PROMPT,
    buildTradeUserPrompt,
    wrapTradeAlertMessage,
} from '../src/prompts/tradeAnalysisPrompt.js';
import { formatDailyScanIntro } from '../src/utils/tradeScanFormatter.js';
import { parseTradeSignal } from '../src/utils/tradeSignalParser.js';
import { enforceLiveSpotPrice } from '../src/utils/tradeQuoteUtils.js';
import { injectTradePlans } from '../src/utils/tradePlanFormatter.js';
import { scoreConfluence, getMinConfluenceScore } from '../src/utils/tradeConfluenceScore.js';
import { getIndiaMarketMode, checkQuoteFreshness } from '../src/utils/indianMarketCalendar.js';
import { computeEntryState, ENTRY_STATES } from '../src/utils/tradeEntryState.js';
import { parsePremium, parseTargets } from '../src/utils/tradePlanFormatter.js';

const analyzeArg = process.argv.indexOf('--analyze');
const maxAnalyze = analyzeArg >= 0 ? Math.max(1, parseInt(process.argv[analyzeArg + 1], 10) || 2) : 2;

function divider(title) {
    console.log('\n' + '═'.repeat(62));
    console.log(`  ${title}`);
    console.log('═'.repeat(62) + '\n');
}

function computeEntryStateFromBody(body, quote, marketMode) {
    const text = String(body || '');
    const ceBlock = text.match(/━━━\s*CALL\s*\(CE\)\s*SETUP[\s\S]*?(?=━━━\s*PUT|Primary Pick:|$)/i)?.[0] || '';
    const entryRaw = ceBlock.match(/Entry:\s*(.+)/i)?.[1] || '';
    const entryNums = entryRaw.match(/(\d+(?:\.\d+)?)/g)?.map(Number) || [];
    const entryLow = entryNums.length ? Math.min(...entryNums) : null;
    const entryHigh = entryNums.length ? Math.max(...entryNums) : null;
    const premiumMatch = ceBlock.match(/Premium:\s*([\d,.]+)/i);
    const entry = premiumMatch ? parsePremium(premiumMatch[1]) : entryLow;
    const targets = parseTargets(ceBlock, entry);
    return computeEntryState({
        marketMode: marketMode.mode,
        quote,
        entryLow: entryLow ?? entry,
        entryHigh: entryHigh ?? entry,
        target1: targets.t1,
    });
}

function passesSendGates({ signal, confluence, entryState, marketMode, discovery }) {
    const gates = discovery?.gates || {};
    const minConf = gates.minConfidence ?? 70;
    const minConv = gates.minConfluence ?? getMinConfluenceScore(config);

    if (marketMode.watchOnly && gates.allowsLiveEntry === false) {
        return { pass: false, reason: 'watch-only session' };
    }
    if (discovery?.freshness?.ok === false) {
        return { pass: false, reason: discovery.freshness.message || 'stale data' };
    }
    if (!signal.isActionable || signal.confidence < minConf) {
        return { pass: false, reason: `AI < ${minConf}%` };
    }
    if (confluence?.blocked) {
        return { pass: false, reason: `catalyst AVOID (${confluence.blockReason})` };
    }
    if (confluence && confluence.score < minConv) {
        return { pass: false, reason: `confluence ${confluence.score} < ${minConv}` };
    }
    if (
        entryState?.state === ENTRY_STATES.ENTRY_MISSED ||
        entryState?.state === ENTRY_STATES.NO_ACTIVE_ENTRY
    ) {
        return { pass: false, reason: entryState.label };
    }
    return { pass: true, reason: null };
}

function formatScanResultLine(entry) {
    const gemTag = entry.isHiddenGem ? ' 💎' : '';
    const confTag = entry.confluence != null ? ` · conf ${entry.confluence}` : '';
    if (entry.posted) {
        return `✅ *${entry.symbol}*${gemTag} — ${entry.recommendation} (${entry.confidence}%)${confTag}`;
    }
    if (entry.isActionable) {
        return `⚠️ ${entry.symbol}${gemTag} — ${entry.recommendation} (${entry.confidence}%)${confTag} · not posted (daily limit)`;
    }
    const why = entry.gateReason ? ` · ${entry.gateReason}` : '';
    return `— ${entry.symbol}${gemTag} — NO TRADE (CE ${entry.ceConfidence}% / PE ${entry.peConfidence}%)${why}`;
}

function selectDailyPosts(actionableRegular, actionableGem, maxTotal) {
    const sortedRegular = [...actionableRegular].sort(
        (a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0)
    );
    if (actionableGem) {
        return [actionableGem, ...sortedRegular.slice(0, maxTotal - 1)];
    }
    return sortedRegular.slice(0, maxTotal);
}

async function analyzeSymbol(gemini, research, symbol, { isHiddenGem = false } = {}) {
    const intel = await research.gatherIntel(symbol);
    const researchBrief = await research.runResearchBrief(intel);
    const userPrompt = buildTradeUserPrompt({
        symbol: intel.symbol,
        displayName: intel.displayName,
        quoteContext: intel.quoteContext,
        quote: intel.quote,
        newsContext: intel.newsContext,
        optionsNewsContext: intel.optionsNewsContext,
        optionChainContext: intel.optionChainContext,
        researchBrief,
        mode: 'daily',
    });

    let body = await gemini.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 8192,
    });
    body = enforceLiveSpotPrice(body, intel.quote);
    body = injectTradePlans(body, intel.symbol, {
        partials: config.TRADE_PLAN_PARTIALS || [50, 30, 20],
    });

    const signal = parseTradeSignal(body);
    const marketMode = getIndiaMarketMode();
    const entryState = computeEntryStateFromBody(body, intel.quote, marketMode);
    const text = wrapTradeAlertMessage(intel.symbol, body, {
        isDaily: true,
        isHiddenGem,
        meta: {
            entryState,
            freshness: intel.quote?.price != null ? 'live quote' : null,
        },
    });

    return { text, signal, entryState, intel };
}

async function main() {
    const gemini = new GeminiTradeService(config);
    if (!gemini.isConfigured()) {
        console.error('❌ Set GEMINI_API_KEY in .env');
        process.exit(1);
    }

    console.log(`Gemini: ${gemini.getModelChain().join(' → ')}`);
    console.log(`Analyzing up to ${maxAnalyze} symbols for sample trade alerts…\n`);

    const engine = createTradeDiscoveryEngine(config, null);
    const research = createTradeResearchService(config);
    const discovery = await engine.run({ forceRefresh: true });

    const symbols = discovery.symbols || [];
    const hiddenGem = discovery.hiddenGem || null;
    const maxSends = config.TRADE_ALERT_MAX_SENDS || 5;

    divider('WHATSAPP MESSAGE 1 — Daily scan intro (sent first)');
    console.log(
        formatDailyScanIntro(discovery, {
            symbols,
            hiddenGem,
            hiddenGemReason: discovery.hiddenGemReason,
            maxSends,
        })
    );

    const toScan = [];
    const seen = new Set();
    for (const sym of symbols) {
        if (seen.has(sym)) continue;
        seen.add(sym);
        toScan.push(sym);
        if (toScan.length >= maxAnalyze) break;
    }

    const marketMode = getIndiaMarketMode();
    const freshness = checkQuoteFreshness(discovery.scannedAt);
    const actionableRegular = [];
    const actionableGem = null;
    const scanResults = [];
    const skipped = [];
    let msgNum = 2;

    for (const symbol of toScan) {
        console.error(`\n⏳ Gemini analyzing ${symbol}…`);
        try {
            const isHiddenGem = Boolean(hiddenGem && symbol === hiddenGem);
            const { text, signal, entryState } = await analyzeSymbol(gemini, research, symbol, { isHiddenGem });

            const metaRow = discovery.symbolMeta?.find((m) => m.symbol === symbol);
            const confluence = metaRow
                ? {
                      score: metaRow.confluence,
                      blocked: metaRow.blocked,
                      blockReason: metaRow.blocked ? 'catalyst' : null,
                      passes: metaRow.confluencePass,
                  }
                : scoreConfluence({
                      symbol,
                      movers: discovery.movers,
                      macro: discovery.macro,
                  });

            const gate = passesSendGates({
                signal,
                confluence,
                entryState,
                marketMode,
                discovery: { ...discovery, freshness },
            });

            const resultEntry = {
                symbol,
                recommendation: signal.recommendation,
                confidence: signal.confidence,
                ceConfidence: signal.ceConfidence,
                peConfidence: signal.peConfidence,
                isActionable: signal.isActionable && gate.pass,
                confluence: confluence.score,
                gateReason: gate.pass ? null : gate.reason,
                isHiddenGem,
                posted: false,
            };

            const onlyBuy = config.TRADE_ALERT_ONLY_BUY_SIGNALS !== false;
            if (onlyBuy && !resultEntry.isActionable) {
                skipped.push(`${symbol} (${gate.pass ? 'NO TRADE' : 'blocked'} · CE ${signal.ceConfidence}% / PE ${signal.peConfidence}%)`);
                scanResults.push(resultEntry);
                divider(`WHATSAPP — ${symbol} SKIPPED (not posted)`);
                console.log(`Gate: ${gate.reason || 'NO TRADE / below threshold'}`);
                console.log(`Signal: ${signal.recommendation} ${signal.confidence}% · CE ${signal.ceConfidence}% · PE ${signal.peConfidence}%`);
                continue;
            }

            const item = { symbol, text, signal, resultEntry };
            actionableRegular.push(item);
            scanResults.push(resultEntry);

            divider(`WHATSAPP MESSAGE ${msgNum} — Trade alert: ${symbol} (would post if gates pass)`);
            msgNum += 1;
            console.log(text);
        } catch (err) {
            console.error(`Failed ${symbol}: ${err.message}`);
            skipped.push(`${symbol} (error)`);
        }
    }

    const toPost = selectDailyPosts(actionableRegular, actionableGem, maxSends);
    for (const item of toPost) {
        item.resultEntry.posted = true;
    }

    const sentCount = toPost.length;
    const actionableSent = toPost.map((p) => (p.resultEntry.isHiddenGem ? `${p.symbol} 💎` : p.symbol));
    const scanSummary = scanResults.length
        ? `\n\n📋 *Scan summary*\n${scanResults.map((e) => formatScanResultLine(e)).join('\n')}`
        : '';

    divider(`WHATSAPP MESSAGE ${msgNum} — Daily scan complete (footer)`);

    if (sentCount > 0) {
        console.log(
            `📈 *Daily F&O scan complete*\n` +
                `Posted *${sentCount}* actionable alert(s): *${actionableSent.join(', ')}*` +
                scanSummary +
                `\n\n_Use \`/tradenow SYMBOL\` anytime for full analysis._`
        );
    } else {
        const skipNote = skipped.length ? `\n_Scanned: ${skipped.slice(0, 8).join('; ')}_` : '';
        console.log(
            `📈 *Daily F&O scan complete*\n` +
                `No high-confidence BUY setups (≥70%) today.${skipNote}` +
                scanSummary +
                `\n\nUse \`/tradenow SYMBOL\` for full analysis including NO TRADE.`
        );
    }

    divider('NOTES');
    console.log(`• Full morning run scans all ${symbols.length} watchlist names (this preview only ran Gemini on ${toScan.length}).`);
    console.log(`• Max ${maxSends} actionable BUY alerts posted per group per day.`);
    console.log(`• After-hours mode: watch-only — live entries may be blocked until next session.`);
    console.log(`• Remaining watchlist: ${symbols.slice(maxAnalyze).join(', ') || 'none'}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
