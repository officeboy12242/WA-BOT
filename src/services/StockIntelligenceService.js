/**
 * Aggregate live quote + news + market context for AI trade analysis.
 */

import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { stockNewsService } from './StockNewsService.js';
import { marketScanService } from './MarketScanService.js';

class StockIntelligenceService {
    /**
     * @param {string} symbol
     * @param {{ includeMarketBrief?: boolean }} [opts]
     */
    async gatherForSymbol(symbol, opts = {}) {
        const sym = String(symbol || '').trim().toUpperCase();

        const quotePack = await indianStockQuoteService.fetchQuoteContext(sym);
        const news = await stockNewsService.fetchForSymbol(sym, quotePack?.displayName || sym);

        let marketBrief = null;
        if (opts.includeMarketBrief) {
            const snap = await marketScanService.buildDiscoverySnapshot();
            marketBrief = snap.context;
        }

        return {
            symbol: sym,
            displayName: quotePack?.displayName || sym,
            quoteContext: quotePack?.context || null,
            quote: quotePack?.quote || null,
            newsContext: news.context,
            newsHeadlines: news.headlines,
            marketBrief,
        };
    }
}

export const stockIntelligenceService = new StockIntelligenceService();
export default StockIntelligenceService;
