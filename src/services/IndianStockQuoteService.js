/**
 * Lightweight NSE/BSE spot quotes — Yahoo Finance chart API with retries + fallbacks.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const YAHOO_CHART_HOSTS = [
    'https://query1.finance.yahoo.com/v8/finance/chart',
    'https://query2.finance.yahoo.com/v8/finance/chart',
];

const CHROME_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = 18_000;
const MAX_ATTEMPTS = 3;

const INDEX_MAP = {
    NIFTY: '^NSEI',
    NIFTY50: '^NSEI',
    BANKNIFTY: '^NSEBANK',
    SENSEX: '^BSESN',
    FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
};

/** NSE ticker → Yahoo symbols to try (post-demerger / renames) */
const YAHOO_SYMBOL_FALLBACKS = {
    TATAMOTORS: ['TMPV.NS', 'TMCV.NS', 'TATAMOTORS.NS'],
    TATAMTRDVV: ['TMPV.NS', 'TMCV.NS'],
};

function yahooCandidates(rawSymbol) {
    const raw = String(rawSymbol || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!raw) return [];
    if (INDEX_MAP[raw]) return [INDEX_MAP[raw]];
    if (raw.startsWith('^')) return [raw];
    if (raw.endsWith('.NS') || raw.endsWith('.BO')) return [raw];
    if (YAHOO_SYMBOL_FALLBACKS[raw]) return YAHOO_SYMBOL_FALLBACKS[raw];
    return [`${raw}.NS`];
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} meta Yahoo chart meta
 * @returns {import('./IndianStockQuoteService.js').StockQuote | null}
 */
function metaToQuote(meta, yahooSymbol, rawSymbol) {
    if (!meta) return null;

    const price = meta.regularMarketPrice ?? meta.previousClose;
    if (price == null) return null;

    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const change = prev != null ? price - prev : null;
    const changePct = change != null && prev ? Number(((change / prev) * 100).toFixed(2)) : null;

    return {
        symbol: String(rawSymbol).trim().toUpperCase(),
        yahooSymbol,
        displayName: meta.longName || meta.shortName || rawSymbol,
        price: Number(price),
        change: change != null ? Number(change.toFixed(2)) : null,
        changePct,
        open: meta.regularMarketDayOpen ?? null,
        high: meta.regularMarketDayHigh ?? null,
        low: meta.regularMarketDayLow ?? null,
        prevClose: prev != null ? Number(prev) : null,
        volume: meta.regularMarketVolume ?? null,
        currency: meta.currency || 'INR',
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
        exchange: meta.fullExchangeName || meta.exchangeName || 'NSE',
        marketState: meta.marketState || '',
    };
}

function formatQuoteContext(quote) {
    const lines = [
        `Symbol (Yahoo): ${quote.yahooSymbol}`,
        `Exchange: ${quote.exchange}`,
        `Last price: ${quote.price} ${quote.currency}`,
    ];

    if (quote.change != null && quote.changePct != null) {
        const sign = quote.change >= 0 ? '+' : '';
        lines.push(`Change today: ${sign}${quote.change} (${sign}${quote.changePct}%)`);
    }
    if (quote.open != null) lines.push(`Open: ${quote.open}`);
    if (quote.high != null) lines.push(`Day high: ${quote.high}`);
    if (quote.low != null) lines.push(`Day low: ${quote.low}`);
    if (quote.prevClose != null) lines.push(`Previous close: ${quote.prevClose}`);
    if (quote.volume != null) lines.push(`Volume: ${quote.volume}`);
    if (quote.fiftyTwoWeekHigh != null) lines.push(`52W high: ${quote.fiftyTwoWeekHigh}`);
    if (quote.fiftyTwoWeekLow != null) lines.push(`52W low: ${quote.fiftyTwoWeekLow}`);
    if (quote.marketState) lines.push(`Market state: ${quote.marketState}`);

    return lines.join('\n');
}

async function fetchYahooMeta(yahooSymbol) {
    let lastErr;

    for (const host of YAHOO_CHART_HOSTS) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            try {
                const url = `${host}/${encodeURIComponent(yahooSymbol)}`;
                const { data } = await axios.get(url, {
                    params: { interval: '1d', range: '5d', includePrePost: false },
                    timeout: TIMEOUT_MS,
                    headers: {
                        'User-Agent': CHROME_UA,
                        Accept: 'application/json,text/plain,*/*',
                        'Accept-Language': 'en-IN,en;q=0.9',
                    },
                });

                const meta = data?.chart?.result?.[0]?.meta;
                if (meta?.regularMarketPrice != null || meta?.previousClose != null) {
                    return meta;
                }
                lastErr = new Error('empty chart meta');
            } catch (err) {
                lastErr = err;
                logger.debug(`Yahoo quote attempt failed ${yahooSymbol} @ ${host}: ${err.message}`);
                await sleep(500 * (attempt + 1));
            }
        }
    }

    throw lastErr || new Error(`No quote for ${yahooSymbol}`);
}

export function normalizeYahooSymbol(raw) {
    return yahooCandidates(raw)[0] || '';
}

class IndianStockQuoteService {
    /**
     * @param {string} rawSymbol
     * @returns {Promise<StockQuote | null>}
     */
    async fetchQuote(rawSymbol) {
        const raw = String(rawSymbol || '').trim().toUpperCase();
        const candidates = yahooCandidates(raw);
        if (!candidates.length) return null;

        let lastErr;
        for (const yahooSymbol of candidates) {
            try {
                const meta = await fetchYahooMeta(yahooSymbol);
                return metaToQuote(meta, yahooSymbol, raw);
            } catch (err) {
                lastErr = err;
                logger.debug(`Yahoo fallback ${raw} via ${yahooSymbol}: ${err.message}`);
            }
        }

        logger.warn(`Stock quote failed for ${rawSymbol}: ${lastErr?.message || 'no quote'}`);
        return null;
    }

    /**
     * @param {string} rawSymbol
     * @returns {Promise<{ yahooSymbol: string, displayName: string, context: string, quote: StockQuote } | null>}
     */
    async fetchQuoteContext(rawSymbol) {
        const quote = await this.fetchQuote(rawSymbol);
        if (!quote) return null;

        return {
            yahooSymbol: quote.yahooSymbol,
            displayName: quote.displayName,
            context: formatQuoteContext(quote),
            quote,
        };
    }
}

/** @typedef {object} StockQuote */
export default IndianStockQuoteService;
export const indianStockQuoteService = new IndianStockQuoteService();
