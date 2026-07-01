/**
 * Two-step trade intelligence: live feeds → AI research → CE/PE analysis.
 */

import { stockIntelligenceService } from './StockIntelligenceService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import {
    TRADE_RESEARCH_SYSTEM_PROMPT,
    buildResearchUserPrompt,
} from '../prompts/tradeResearchPrompt.js';
import { logger } from '../utils/logger.js';

class TradeResearchService {
    constructor(config = {}) {
        this.nvidia = new NvidiaDeepSeekService(config);
        this.enabled = config.TRADE_TWO_STEP_RESEARCH !== false;
    }

    /** @param {string} symbol @param {{ includeMarketBrief?: boolean }} [opts] */
    async gatherIntel(symbol, opts = {}) {
        return stockIntelligenceService.gatherForSymbol(symbol, opts);
    }

    /**
     * Step 1: AI synthesizes live data into CE/PE research brief.
     * @param {object} intel
     */
    async runResearchBrief(intel) {
        if (!this.enabled || !this.nvidia.isConfigured()) {
            return null;
        }

        const userPrompt = buildResearchUserPrompt({
            symbol: intel.symbol,
            displayName: intel.displayName,
            quoteContext: intel.quoteContext,
            quote: intel.quote,
            optionChainContext: intel.optionChainContext,
            newsContext: intel.newsContext,
            optionsNewsContext: intel.optionsNewsContext,
            marketBrief: intel.marketBrief,
        });

        logger.info(`🔬 AI research brief for ${intel.symbol}…`);
        const brief = await this.nvidia.complete(TRADE_RESEARCH_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 900,
            timeoutMs: 75_000,
        });
        return brief?.trim() || null;
    }
}

export const createTradeResearchService = (config) => new TradeResearchService(config);
export default TradeResearchService;
