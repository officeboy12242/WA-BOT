/**
 * Scan liquid NSE F&O names for movers + index context (Yahoo Finance).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { indianStockQuoteService, normalizeYahooSymbol } from './IndianStockQuoteService.js';
import { stockNewsService } from './StockNewsService.js';

const UA = 'Mozilla/5.0 (compatible; SassyBot/1.0)';
const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT_MS = 10_000;
const BATCH = 6;

/** Liquid F&O / Nifty-heavy names for daily AI scan */
export const FNO_UNIVERSE = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN',
    'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'TITAN',
    'SUNPHARMA', 'BAJFINANCE', 'WIPRO', 'HCLTECH', 'ULTRACEMCO', 'ONGC', 'NTPC',
    'POWERGRID', 'TATAMOTORS', 'M&M', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'TATASTEEL',
    'JSWSTEEL', 'HINDALCO', 'INDUSINDBK', 'BPCL', 'GRASIM', 'DIVISLAB', 'CIPLA',
    'DRREDDY', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJFINSV', 'SBILIFE', 'HDFCLIFE',
    'TECHM', 'APOLLOHOSP', 'BRITANNIA', 'NESTLEIND', 'TRENT', 'BEL', 'DLF', 'VEDL',
];

const INDICES = ['NIFTY', 'BANKNIFTY'];

async function fetchQuoteRow(symbol) {
    const yahoo = normalizeYahooSymbol(symbol);
    try {
        const { data } = await axios.get(`${CHART}/${encodeURIComponent(yahoo)}`, {
            params: { interval: '1d', range: '5d' },
            headers: { 'User-Agent': UA },
            timeout: TIMEOUT_MS,
        });
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const price = meta.regularMarketPrice ?? meta.previousClose;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        const changePct =
            price != null && prev ? ((price - prev) / prev) * 100 : null;

        return {
            symbol: String(symbol).replace(/\.NS$/, '').toUpperCase(),
            name: meta.shortName || meta.longName || symbol,
            price,
            changePct: changePct != null ? Number(changePct.toFixed(2)) : null,
            volume: meta.regularMarketVolume ?? null,
        };
    } catch {
        return null;
    }
}

async function mapPool(items, fn, poolSize = BATCH) {
    const results = [];
    for (let i = 0; i < items.length; i += poolSize) {
        const chunk = items.slice(i, i + poolSize);
        const rows = await Promise.all(chunk.map(fn));
        results.push(...rows.filter(Boolean));
    }
    return results;
}

class MarketScanService {
    /**
     * Full market snapshot for AI stock discovery.
     * @returns {Promise<{ context: string, movers: object[], indices: object[], marketNews: string }>}
     */
    async buildDiscoverySnapshot() {
        logger.info('📡 Market scan: fetching indices, movers, live news…');

        const [indexRows, universeRows, marketNews] = await Promise.all([
            mapPool(INDICES, (s) => indianStockQuoteService.fetchQuoteContext(s).then((q) => {
                if (!q) return null;
                return { symbol: s, context: q.context, name: q.displayName };
            })),
            mapPool(FNO_UNIVERSE, fetchQuoteRow),
            stockNewsService.fetchMarketHeadlines(),
        ]);

        const withChange = universeRows.filter((r) => r.changePct != null);
        const sorted = [...withChange].sort((a, b) => b.changePct - a.changePct);
        const gainers = sorted.filter((r) => r.changePct > 0).slice(0, 8);
        const losers = [...withChange].sort((a, b) => a.changePct - b.changePct).slice(0, 8);

        const lines = [];
        lines.push('=== INDICES ===');
        for (const idx of indexRows) {
            lines.push(`[${idx.symbol}] ${idx.context.replace(/\n/g, ' | ')}`);
        }

        lines.push('\n=== TOP GAINERS (% change today) ===');
        for (const g of gainers) {
            lines.push(`${g.symbol} (${g.name}): ${g.price} INR, ${g.changePct >= 0 ? '+' : ''}${g.changePct}%`);
        }

        lines.push('\n=== TOP LOSERS (% change today) ===');
        for (const l of losers) {
            lines.push(`${l.symbol} (${l.name}): ${l.price} INR, ${l.changePct}%`);
        }

        lines.push('\n=== LIVE MARKET NEWS (Google News RSS) ===');
        lines.push(marketNews.context);

        return {
            context: lines.join('\n'),
            movers: { gainers, losers },
            indices: indexRows,
            marketNews: marketNews.context,
        };
    }

    formatMoversBrief(movers) {
        const g = movers.gainers.slice(0, 5).map((x) => `${x.symbol} +${x.changePct}%`).join(', ');
        const l = movers.losers.slice(0, 5).map((x) => `${x.symbol} ${x.changePct}%`).join(', ');
        return `Gainers: ${g || 'n/a'}\nLosers: ${l || 'n/a'}`;
    }
}

export const marketScanService = new MarketScanService();
export default MarketScanService;
