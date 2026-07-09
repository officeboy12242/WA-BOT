/**
 * Live trade alert preview — real NSE scan + Gemini analysis.
 * Run: node scripts/run-live-trade-preview.js
 * Requires: GEMINI_API_KEY in env or .env
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
import { formatTradeScanPreview, formatDailyScanIntro } from '../src/utils/tradeScanFormatter.js';
import { parseTradeSignal } from '../src/utils/tradeSignalParser.js';
import { enforceLiveSpotPrice } from '../src/utils/tradeQuoteUtils.js';
import { injectTradePlans } from '../src/utils/tradePlanFormatter.js';
import { marketScanService } from '../src/services/MarketScanService.js';
import { parseDiscoveryResult } from '../src/utils/tradeSignalParser.js';
import { STOCK_DISCOVERY_SYSTEM_PROMPT, buildDiscoveryUserPrompt } from '../src/prompts/stockDiscoveryPrompt.js';

const gemini = new GeminiTradeService(config);
const research = createTradeResearchService(config);
const engine = createTradeDiscoveryEngine(config, null);

async function main() {
    if (!gemini.isConfigured()) {
        console.error('❌ Set GEMINI_API_KEY in .env or environment');
        process.exit(1);
    }

    console.log(`Using Gemini models: ${gemini.getModelChain().join(' → ')}\n`);
    console.log('='.repeat(60));
    console.log('STEP 1 — LIVE MARKET SCAN (NSE + sectors + smart money)');
    console.log('='.repeat(60));
    console.log('(This may take 60–120 seconds…)\n');

    const intel = await engine.run({ forceRefresh: true });

    const baseRows = intel.universeRows || [];
    let discovery = { symbols: [], hiddenGem: null, hiddenGemReason: null };
    try {
        const raw = await gemini.completeTrade(
            STOCK_DISCOVERY_SYSTEM_PROMPT,
            buildDiscoveryUserPrompt(intel.context, config.TRADE_ALERT_DISCOVERY_COUNT || 10),
            { maxTokens: 900, timeoutMs: 90_000 }
        );
        discovery = parseDiscoveryResult(raw);
    } catch (err) {
        console.warn(`AI discovery overlay skipped: ${err.message}`);
    }

    const gemPick = marketScanService.pickHiddenGem(
        baseRows,
        intel.movers,
        intel.marketNews,
        discovery.hiddenGem,
        discovery.hiddenGemReason
    );

    let symbols = [...intel.symbols];
    if (gemPick.hiddenGem && !symbols.includes(gemPick.hiddenGem)) {
        symbols = [gemPick.hiddenGem, ...symbols];
    }
    symbols = marketScanService.finalizeWatchlist(symbols, baseRows, config.TRADE_ALERT_DISCOVERY_COUNT || 10);

    const preview = {
        ...intel,
        symbols,
        hiddenGem: gemPick.hiddenGem,
        hiddenGemReason: gemPick.hiddenGemReason,
    };

    console.log(formatTradeScanPreview(preview));

    console.log('\n' + '='.repeat(60));
    console.log('STEP 2 — DAILY GROUP INTRO (first WhatsApp message)');
    console.log('='.repeat(60));
    console.log(
        formatDailyScanIntro(preview, {
            symbols,
            hiddenGem: gemPick.hiddenGem,
            hiddenGemReason: gemPick.hiddenGemReason,
            maxSends: config.TRADE_ALERT_MAX_SENDS || 5,
        })
    );

    const pickSymbol = symbols[0];
    if (!pickSymbol) {
        console.log('\nNo symbols in watchlist — skipping trade analysis.');
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`STEP 3 — GEMINI TRADE ALERT for ${pickSymbol} (sample daily post)`);
    console.log('='.repeat(60));
    console.log('(Research brief + CE/PE analysis ~90–180s…)\n');

    const stockIntel = await research.gatherIntel(pickSymbol);
    const researchBrief = await research.runResearchBrief(stockIntel);

    const userPrompt = buildTradeUserPrompt({
        symbol: stockIntel.symbol,
        displayName: stockIntel.displayName,
        quoteContext: stockIntel.quoteContext,
        quote: stockIntel.quote,
        newsContext: stockIntel.newsContext,
        optionsNewsContext: stockIntel.optionsNewsContext,
        optionChainContext: stockIntel.optionChainContext,
        researchBrief,
        marketBrief: null,
        mode: 'daily',
    });

    let body = await gemini.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 2200,
    });
    body = enforceLiveSpotPrice(body, stockIntel.quote);
    body = injectTradePlans(body, pickSymbol, {
        partials: config.TRADE_PLAN_PARTIALS || [50, 30, 20],
    });

    const signal = parseTradeSignal(body);
    const metaRow = intel.symbolMeta?.find((m) => m.symbol === pickSymbol);
    const alertText = wrapTradeAlertMessage(pickSymbol, body, {
        isDaily: true,
        isHiddenGem: pickSymbol === gemPick.hiddenGem,
        meta: {
            entryState: { label: signal.isActionable ? '✅ Valid entry' : '👁️ Watch' },
            confluence: metaRow?.confluence ?? null,
            freshness: 'live quote',
        },
    });

    console.log(alertText);
    console.log('\n--- Signal summary ---');
    console.log(`Primary: ${signal.recommendation} · ${signal.confidence}%`);
    console.log(`CE ${signal.ceConfidence}% · PE ${signal.peConfidence}% · Actionable: ${signal.isActionable}`);
}

main().catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
});
