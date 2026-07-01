/**
 * Lightweight NSE/BSE spot quotes via Yahoo Finance (best-effort).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT_MS = 12_000;

const INDEX_MAP = {
    NIFTY: '^NSEI',
    NIFTY50: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    SENSEX: '^BSESN',
    FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
};

function normalizeSymbol(raw) {
    const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return '';
    if (INDEX_MAP[s]) return INDEX_MAP[s];
    if (s.startsWith('^')) return s;
    if (s.endsWith('.NS') || s.endsWith('.BO')) return s;
    return `${s}.NS`;
}

function formatQuoteContext(meta, symbol) {
    const price = meta?.regularMarketPrice ?? meta?.previousClose;
    const prev = meta?.previousClose ?? meta?.chartPreviousClose;
    const change = price != null && prev != null ? price - prev : null;
    const changePct = change != null && prev ? ((change / prev) * 100).toFixed(2) : null;
    const currency = meta?.currency || 'INR';

    const lines = [`Symbol (Yahoo): ${symbol}`];
    if (price != null) lines.push(`Last price: ${price} ${currency}`);
    if (change != null) lines.push(`Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct}%)`);
    if (meta?.fiftyTwoWeekHigh) lines.push(`52W high: ${meta.fiftyTwoWeekHigh}`);
    if (meta?.fiftyTwoWeekLow) lines.push(`52W low: ${meta.fiftyTwoWeekLow}`);
    return lines.join('\n');
}

export function normalizeYahooSymbol(raw) {
    return normalizeSymbol(raw);
}

class IndianStockQuoteService {
    /**
     * @param {string} rawSymbol e.g. RELIANCE, NIFTY
     * @returns {Promise<{ yahooSymbol: string, displayName: string, context: string } | null>}
     */
    async fetchQuoteContext(rawSymbol) {
        const yahooSymbol = normalizeSymbol(rawSymbol);
        if (!yahooSymbol) return null;

        try {
            const url = `${YAHOO_CHART}/${encodeURIComponent(yahooSymbol)}`;
            const { data } = await axios.get(url, {
                params: { interval: '1d', range: '5d' },
                timeout: TIMEOUT_MS,
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SassyBot/1.0)' },
            });

            const result = data?.chart?.result?.[0];
            const meta = result?.meta;
            if (!meta) return null;

            const displayName = meta.longName || meta.shortName || rawSymbol;
            return {
                yahooSymbol,
                displayName,
                context: formatQuoteContext(meta, yahooSymbol),
            };
        } catch (err) {
            logger.debug(`Stock quote failed for ${rawSymbol}: ${err.message}`);
            return null;
        }
    }
}

export const indianStockQuoteService = new IndianStockQuoteService();
export default IndianStockQuoteService;
