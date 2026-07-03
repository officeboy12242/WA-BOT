/**
 * Live NSE option chain (v3 API) — PCR, OI, IV, top CE/PE strikes.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { stockSymbolResolverService } from './StockSymbolResolverService.js';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE_HEADERS = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.nseindia.com/option-chain',
};

const TIMEOUT_MS = 22_000;
const COOKIE_TTL_MS = 5 * 60 * 1000;

const INDEX_SYMBOLS = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'MIDCPNIFTY',
    'NIFTYIT',
    'NIFTYNXT50',
]);

let _cookieCache = { value: '', at: 0 };

async function getNseCookie() {
    if (_cookieCache.value && Date.now() - _cookieCache.at < COOKIE_TTL_MS) {
        return _cookieCache.value;
    }
    const home = await axios.get('https://www.nseindia.com/option-chain', {
        headers: { ...BASE_HEADERS, Accept: 'text/html,application/xhtml+xml' },
        timeout: TIMEOUT_MS,
    });
    const cookie = home.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ') || '';
    if (cookie) {
        _cookieCache = { value: cookie, at: Date.now() };
    }
    return cookie;
}

async function nseGet(path, cookie) {
    const { data } = await axios.get(`https://www.nseindia.com/api/${path}`, {
        headers: { ...BASE_HEADERS, Cookie: cookie },
        timeout: TIMEOUT_MS,
    });
    return data;
}

function resolveNseType(nseSymbol) {
    const s = String(nseSymbol || '').trim().toUpperCase().replace(/\.NS$/, '');
    if (INDEX_SYMBOLS.has(s) || s === 'NIFTY50') return 'Indices';
    return 'Equity';
}

function topStrikes(rows, leg, n = 5) {
    const list = [];
    for (const row of rows) {
        const legData = row[leg];
        const oi = legData?.openInterest || 0;
        if (!oi) continue;
        list.push({
            strike: row.strikePrice,
            oi,
            changeOi: legData.changeinOpenInterest ?? 0,
            pChangeOi: legData.pchangeinOpenInterest ?? null,
            iv: legData.impliedVolatility ?? null,
            ltp: legData.lastPrice ?? null,
            volume: legData.totalTradedVolume ?? null,
        });
    }
    list.sort((a, b) => b.oi - a.oi);
    return list.slice(0, n);
}

function findAtmRow(rows, spot) {
    if (!rows?.length || spot == null) return null;
    return rows.reduce((best, row) => {
        if (!best) return row;
        return Math.abs(row.strikePrice - spot) < Math.abs(best.strikePrice - spot) ? row : best;
    }, null);
}

function formatLegLine(label, item) {
    const coi =
        item.pChangeOi != null
            ? `, COI ${item.changeOi >= 0 ? '+' : ''}${item.changeOi} (${item.pChangeOi.toFixed(1)}%)`
            : '';
    const iv = item.iv != null ? `, IV ${item.iv}%` : '';
    const ltp = item.ltp != null ? `, LTP ₹${item.ltp}` : '';
    return `  ${label} ${item.strike}: OI ${item.oi}${coi}${iv}${ltp}`;
}

class NseOptionChainService {
    async _fetchChainForNse(nseSymbol, type) {
        const cookie = await getNseCookie();
        const contract = await nseGet(`option-chain-contract-info?symbol=${nseSymbol}`, cookie);
        const expiries = contract?.expiryDates || contract?.records?.expiryDates;
        const expiry = expiries?.[0];
        if (!expiry) {
            logger.debug(`NSE option chain: no expiry for ${nseSymbol}`);
            return null;
        }

        const chain = await nseGet(
            `option-chain-v3?type=${type}&symbol=${encodeURIComponent(nseSymbol)}&expiry=${encodeURIComponent(expiry)}`,
            cookie
        );

        const records = chain?.records;
        const rows = records?.data;
        if (!rows?.length) return null;

        const spot = records.underlyingValue ?? records.underlying ?? null;
        let totalCeOi = 0;
        let totalPeOi = 0;
        for (const row of rows) {
            totalCeOi += row.CE?.openInterest || 0;
            totalPeOi += row.PE?.openInterest || 0;
        }
        const pcr = totalCeOi ? totalPeOi / totalCeOi : null;

        const topCe = topStrikes(rows, 'CE');
        const topPe = topStrikes(rows, 'PE');
        const atm = findAtmRow(rows, spot);

        const lines = [];
        lines.push(`Symbol: ${nseSymbol} (${type})`);
        lines.push(`Expiry: ${expiry}`);
        if (spot != null) lines.push(`NSE underlying: ${spot}`);
        if (pcr != null) lines.push(`PCR (Put OI / Call OI): ${pcr.toFixed(2)}`);
        lines.push(`Total Call OI: ${totalCeOi} | Total Put OI: ${totalPeOi}`);

        if (atm) {
            const ce = atm.CE;
            const pe = atm.PE;
            lines.push(`ATM strike: ${atm.strikePrice}`);
            if (ce) {
                lines.push(
                    `  ATM CE: OI ${ce.openInterest ?? 'n/a'}, IV ${ce.impliedVolatility ?? 'n/a'}%, LTP ₹${ce.lastPrice ?? 'n/a'}, COI ${ce.changeinOpenInterest ?? 'n/a'}`
                );
            }
            if (pe) {
                lines.push(
                    `  ATM PE: OI ${pe.openInterest ?? 'n/a'}, IV ${pe.impliedVolatility ?? 'n/a'}%, LTP ₹${pe.lastPrice ?? 'n/a'}, COI ${pe.changeinOpenInterest ?? 'n/a'}`
                );
            }
        }

        lines.push('Top Call (CE) OI strikes:');
        if (topCe.length) {
            for (const item of topCe) lines.push(formatLegLine('CE', item));
        } else {
            lines.push('  n/a');
        }

        lines.push('Top Put (PE) OI strikes:');
        if (topPe.length) {
            for (const item of topPe) lines.push(formatLegLine('PE', item));
        } else {
            lines.push('  n/a');
        }

        return {
            context: lines.join('\n'),
            snapshot: {
                symbol: nseSymbol,
                type,
                expiry,
                spot,
                pcr,
                totalCeOi,
                totalPeOi,
                topCe,
                topPe,
                atmStrike: atm?.strikePrice ?? null,
            },
        };
    }

    /**
     * @param {string} rawSymbol
     * @returns {Promise<{ context: string, snapshot: object } | null>}
     */
    async fetchOptionContext(rawSymbol) {
        const userSymbol = String(rawSymbol || '').trim().toUpperCase();
        if (!userSymbol) return null;

        try {
            let mapping = await stockSymbolResolverService.resolve(userSymbol);
            let nseSymbol = mapping.nseSymbol;
            let type = resolveNseType(nseSymbol);

            let result = await this._fetchChainForNse(nseSymbol, type);
            if (result) return result;

            mapping = await stockSymbolResolverService.resolve(userSymbol, {
                forceRefresh: true,
                optionChainFailed: true,
                attemptedNse: nseSymbol,
            });
            if (mapping.nseSymbol && mapping.nseSymbol !== nseSymbol) {
                nseSymbol = mapping.nseSymbol;
                type = resolveNseType(nseSymbol);
                result = await this._fetchChainForNse(nseSymbol, type);
                if (result) return result;
            }
        } catch (err) {
            logger.warn(`NSE option chain failed for ${rawSymbol}: ${err.message}`);
        }
        return null;
    }
}

export const nseOptionChainService = new NseOptionChainService();
export default NseOptionChainService;
