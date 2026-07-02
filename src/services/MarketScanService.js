/**
 * Scan liquid NSE F&O names for movers + index context (Yahoo Finance).
 */

import { logger } from '../utils/logger.js';
import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { stockNewsService } from './StockNewsService.js';

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
    const quote = await indianStockQuoteService.fetchQuote(symbol);
    if (!quote) return null;
    return {
        symbol: quote.symbol,
        name: quote.displayName,
        price: quote.price,
        changePct: quote.changePct,
        volume: quote.volume,
    };
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

    /** Higher score = stronger intraday move (prefers liquid names with volume). */
    scoreMover(row) {
        if (row?.changePct == null) return 0;
        const pct = Math.abs(Number(row.changePct) || 0);
        const vol = Number(row.volume) || 0;
        const volBoost = vol > 1_000_000 ? 1.15 : vol > 300_000 ? 1.08 : 1;
        return pct * volBoost;
    }

    buildMoverScoreMap(movers) {
        const map = new Map();
        for (const row of [...(movers?.gainers || []), ...(movers?.losers || [])]) {
            if (!row?.symbol) continue;
            map.set(row.symbol.toUpperCase(), this.scoreMover(row));
        }
        return map;
    }

    /**
     * Build a full watchlist: AI picks + top movers + indices (always targetCount symbols).
     * @param {string[]} aiSymbols
     * @param {{ gainers: object[], losers: object[] }} movers
     * @param {number} targetCount
     */
    buildDiscoveryWatchlist(aiSymbols, movers, targetCount = 10) {
        const target = Math.max(8, targetCount);
        const ordered = [];
        const seen = new Set();

        const push = (symbol) => {
            const sym = String(symbol || '').trim().toUpperCase();
            if (!sym || seen.has(sym)) return;
            seen.add(sym);
            ordered.push(sym);
        };

        for (const sym of aiSymbols) {
            push(sym);
        }

        const ranked = [...(movers?.gainers || []), ...(movers?.losers || [])]
            .sort((a, b) => this.scoreMover(b) - this.scoreMover(a));

        for (const row of ranked) {
            if (ordered.length >= target) break;
            push(row.symbol);
        }

        push('NIFTY');
        push('BANKNIFTY');

        for (const row of ranked) {
            if (ordered.length >= target) break;
            push(row.symbol);
        }

        return ordered.slice(0, target);
    }

    orderSymbolsByMovers(symbols, movers) {
        const scores = this.buildMoverScoreMap(movers);
        return [...symbols].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));
    }
}

export const marketScanService = new MarketScanService();
export default MarketScanService;
