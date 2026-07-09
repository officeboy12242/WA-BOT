/**
 * Test morning alert pipeline — shows NSE vs Yahoo source breakdown.
 * Run: node scripts/test-alert-sources.js [--alert SYMBOL]
 */

import 'dotenv/config';
import { config } from '../src/config/config.js';
import { createTradeDiscoveryEngine } from '../src/services/TradeDiscoveryEngine.js';
import { formatTradeScanPreview } from '../src/utils/tradeScanFormatter.js';
import { getIndiaMarketMode } from '../src/utils/indianMarketCalendar.js';
import { marketScanService } from '../src/services/MarketScanService.js';
import { FNO_UNIVERSE } from '../src/services/MarketScanService.js';

function pct(n) {
    if (n == null || !Number.isFinite(n)) return 'n/a';
    return `${n >= 0 ? '+' : ''}${n}%`;
}

function printSourceDiagnostics(intel) {
    const hot = intel.hotSectors?.hot || [];
    const allSectors = intel.hotSectors?.all || [];
    const sectorsWithData = allSectors.filter((s) => s.indexPct != null);
    const sectorStockCount = allSectors.reduce((n, s) => n + (s.gainers?.length || 0), 0);

    const nseMacroOk = Boolean(intel.macro?.nifty?.pct != null || intel.macro?.fiiNet != null);
    const nseSectorsOk = sectorsWithData.length > 0;
    const nseSmartMoneyOk = (intel.smartMoney?.deals?.length || 0) > 0;

    const meta = intel.symbolMeta || [];
    const bySource = { phase4: [], momentum: [], smartMoney: [], mover: [], hiddenGem: [] };
    for (const m of meta) {
        const src = m.sources || ['mover'];
        if (src.includes('phase4')) bySource.phase4.push(m.symbol);
        if (src.includes('momentum')) bySource.momentum.push(m.symbol);
        if (src.includes('smart money')) bySource.smartMoney.push(m.symbol);
        if (src.includes('mover') && !src.includes('phase4') && !src.includes('momentum')) {
            bySource.mover.push(m.symbol);
        }
    }

    const phase4FromSectors = (intel.phase4Picks || []).filter((p) => p.sector).length;
    const phase4FromYahoo = (intel.phase4Picks || []).filter((p) => !p.sector).length;

    const primaryDriver =
        nseSectorsOk && bySource.phase4.length >= 2
            ? 'NSE SECTORS (primary)'
            : bySource.momentum.length >= bySource.phase4.length
              ? 'YAHOO F&O MOVERS + MOMENTUM (primary — NSE sectors weak/missing)'
              : 'MIXED';

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           DATA SOURCE DIAGNOSTICS (test alert)               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const mode = getIndiaMarketMode();
    console.log(`Market mode: ${mode.label} (${mode.mode})`);
    console.log(`Scan time:   ${new Date(intel.scannedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n`);

    console.log('── NSE feeds ──');
    console.log(`  allIndices / macro:  ${nseMacroOk ? '✅ OK' : '❌ empty/failed'}`);
    if (nseMacroOk) {
        console.log(`    NIFTY: ${pct(intel.macro?.nifty?.pct)}  VIX: ${intel.macro?.vix?.last ?? 'n/a'}`);
        console.log(`    FII: ${intel.macro?.fiiNet ?? 'n/a'}  DII: ${intel.macro?.diiNet ?? 'n/a'}`);
        console.log(`    Bias: ${intel.macro?.bias?.emoji} ${intel.macro?.bias?.label} (${intel.macro?.bias?.score})`);
    }
    console.log(`  sector indices:      ${nseSectorsOk ? `✅ OK (${sectorsWithData.length}/14 with %)` : '❌ empty/failed'}`);
    console.log(`  sector gainers:      ${sectorStockCount} stocks from NSE sector APIs`);
    console.log(`  bulk/block deals:    ${nseSmartMoneyOk ? `✅ ${intel.smartMoney.deals.length} symbols` : '❌ none/failed'}\n`);

    console.log('── Yahoo fallback (hardcoded FNO_UNIVERSE) ──');
    console.log(`  universe size:       ${FNO_UNIVERSE.length} symbols`);
    console.log(`  quotes fetched:      ${intel.universeRows?.length ?? 0} with live % change`);
    console.log(`  momentum picks:      ${intel.momentumAlerts?.length ?? 0} (RS vs NIFTY + turnover)\n`);

    console.log('── Watchlist source mix ──');
    console.log(`  PRIMARY DRIVER:      ${primaryDriver}`);
    console.log(`  Phase-4 from sectors: ${phase4FromSectors} picks`);
    console.log(`  Phase-4 from Yahoo:   ${phase4FromYahoo} picks (momentum-only, no sector tag)`);
    console.log(`  By tag on final list:`);
    console.log(`    phase4 / NSE sector: ${bySource.phase4.join(', ') || '—'}`);
    console.log(`    momentum (Yahoo):    ${bySource.momentum.join(', ') || '—'}`);
    console.log(`    smart money (NSE):   ${bySource.smartMoney.join(', ') || '—'}`);
    console.log(`    mover only (Yahoo):  ${bySource.mover.join(', ') || '—'}\n`);

    if (hot.length) {
        console.log('── NSE HOT SECTORS (used for Phase-4) ──');
        for (const sec of hot) {
            const leaders = (sec.gainers || [])
                .slice(0, 4)
                .map((g) => `${g.symbol} ${pct(g.changePct)}`)
                .join(', ');
            console.log(`  ${sec.label} ${pct(sec.indexPct)}  →  ${leaders || 'no gainers'}`);
        }
        console.log('');
    } else {
        console.log('── NSE HOT SECTORS ──');
        console.log('  (none — watchlist built from Yahoo FNO_UNIVERSE movers + momentum)\n');
    }

    console.log('── Final watchlist ──');
    console.log(`  ${intel.symbols?.join(' · ') || 'empty'}\n`);

    const nseWeight =
        bySource.phase4.length + bySource.smartMoney.length;
    const yahooWeight = bySource.momentum.length + bySource.mover.length;
    const total = Math.max(1, nseWeight + yahooWeight);
    console.log('── Source weight (final list) ──');
    console.log(`  NSE-driven slots:   ${nseWeight}/${intel.symbols?.length ?? 0} (${Math.round((nseWeight / total) * 100)}%)`);
    console.log(`  Yahoo-driven slots: ${yahooWeight}/${intel.symbols?.length ?? 0} (${Math.round((yahooWeight / total) * 100)}%)`);
    console.log('');
}

async function maybeRunAlert(symbol) {
    const geminiKey = config.GEMINI_API_KEY;
    if (!geminiKey) {
        console.log('(Skip Gemini alert — no GEMINI_API_KEY)\n');
        return;
    }

    const { createTradeResearchService } = await import('../src/services/TradeResearchService.js');
    const GeminiTradeService = (await import('../src/services/GeminiTradeService.js')).default;
    const { TRADE_ANALYSIS_SYSTEM_PROMPT, buildTradeUserPrompt, wrapTradeAlertMessage } = await import(
        '../src/prompts/tradeAnalysisPrompt.js'
    );
    const { parseTradeSignal } = await import('../src/utils/tradeSignalParser.js');
    const { enforceLiveSpotPrice } = await import('../src/utils/tradeQuoteUtils.js');
    const { injectTradePlans } = await import('../src/utils/tradePlanFormatter.js');

    const gemini = new GeminiTradeService(config);
    const research = createTradeResearchService(config);

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  SAMPLE TRADE ALERT — ${symbol} (Gemini)                      `.slice(0, 64).padEnd(64) + '║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const stockIntel = await research.gatherIntel(symbol);
    const brief = await research.runResearchBrief(stockIntel);
    const userPrompt = buildTradeUserPrompt({
        symbol: stockIntel.symbol,
        displayName: stockIntel.displayName,
        quoteContext: stockIntel.quoteContext,
        quote: stockIntel.quote,
        newsContext: stockIntel.newsContext,
        optionsNewsContext: stockIntel.optionsNewsContext,
        optionChainContext: stockIntel.optionChainContext,
        researchBrief: brief,
        mode: 'daily',
    });

    let body = await gemini.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, { maxTokens: 8192 });
    body = enforceLiveSpotPrice(body, stockIntel.quote);
    body = injectTradePlans(body, symbol, { partials: config.TRADE_PLAN_PARTIALS || [50, 30, 20] });
    const signal = parseTradeSignal(body);

    console.log(
        wrapTradeAlertMessage(symbol, body, {
            isDaily: true,
            meta: {
                entryState: { label: signal.isActionable ? '✅ Valid entry' : '👁️ Watch' },
                freshness: 'live quote',
            },
        })
    );
    console.log(`\n→ ${signal.recommendation} ${signal.confidence}% · actionable: ${signal.isActionable}\n`);
}

async function main() {
    const alertArg = process.argv.indexOf('--alert');
    const alertSymbol = alertArg >= 0 ? process.argv[alertArg + 1]?.toUpperCase() : null;

    console.log('Running live discovery (same as morning /tradelert auto)…\n');
    const engine = createTradeDiscoveryEngine(config, null);
    const intel = await engine.run({ forceRefresh: true });

    printSourceDiagnostics(intel);

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           WHATSAPP SCAN PREVIEW (morning intro)              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    console.log(formatTradeScanPreview({ ...intel, symbols: intel.symbols }));

    const pick =
        alertSymbol ||
        intel.phase4Picks?.[0]?.symbol ||
        intel.momentumAlerts?.[0]?.symbol ||
        intel.symbols?.[0];

    if (pick && process.argv.includes('--full')) {
        await maybeRunAlert(pick);
    } else if (pick) {
        console.log(`Tip: add --full --alert ${pick} for one Gemini trade alert sample.\n`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
