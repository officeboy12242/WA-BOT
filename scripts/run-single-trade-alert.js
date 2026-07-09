import 'dotenv/config';
import { config } from '../src/config/config.js';
import { createTradeResearchService } from '../src/services/TradeResearchService.js';
import GeminiTradeService from '../src/services/GeminiTradeService.js';
import {
    TRADE_ANALYSIS_SYSTEM_PROMPT,
    buildTradeUserPrompt,
    wrapTradeAlertMessage,
} from '../src/prompts/tradeAnalysisPrompt.js';
import { parseTradeSignal } from '../src/utils/tradeSignalParser.js';
import { enforceLiveSpotPrice } from '../src/utils/tradeQuoteUtils.js';
import { injectTradePlans } from '../src/utils/tradePlanFormatter.js';

const sym = process.argv[2] || 'TITAN';
const research = createTradeResearchService(config);
const gemini = new GeminiTradeService(config);
const intel = await research.gatherIntel(sym);
const brief = await research.runResearchBrief(intel);
const prompt = buildTradeUserPrompt({
    symbol: intel.symbol,
    displayName: intel.displayName,
    quoteContext: intel.quoteContext,
    quote: intel.quote,
    newsContext: intel.newsContext,
    optionsNewsContext: intel.optionsNewsContext,
    optionChainContext: intel.optionChainContext,
    researchBrief: brief,
    mode: 'daily',
});
let body = await gemini.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, prompt, { maxTokens: 8192 });
body = enforceLiveSpotPrice(body, intel.quote);
body = injectTradePlans(body, sym, { partials: [50, 30, 20] });
const signal = parseTradeSignal(body);
console.log(
    wrapTradeAlertMessage(sym, body, {
        isDaily: true,
        meta: {
            entryState: { label: signal.isActionable ? '✅ Valid entry' : '👁️ Watch' },
            confluence: 50,
            freshness: 'live quote',
        },
    })
);
console.log(`\n--- ${signal.recommendation} ${signal.confidence}% actionable: ${signal.isActionable}`);
