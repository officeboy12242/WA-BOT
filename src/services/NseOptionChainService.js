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
const NSE_MAX_RETRIES = 3;
const NSE_RETRY_DELAY_MS = 2000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

const INDEX_SYMBOLS = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'MIDCPNIFTY',
    'NIFTYIT',
    'NIFTYNXT50',
]);

let _cookieCache = { value: '', at: 0 };
/** Serialize NSE warm-up so parallel symbol scans don't stampede cookies. */
let _cookieLock = Promise.resolve();

async function getNseCookie() {
    const run = _cookieLock.then(async () => {
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
    });
    _cookieLock = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

async function nseGet(path, cookie) {
    const res = await axios.get(`https://www.nseindia.com/api/${path}`, {
        headers: { ...BASE_HEADERS, Cookie: cookie },
        timeout: TIMEOUT_MS,
        validateStatus: (s) => s >= 200 && s < 400,
    });
    const data = res.data;
    // NSE sometimes returns HTML (rate-limit page) instead of JSON
    if (typeof data === 'string' && (data.includes('<!DOCTYPE') || data.includes('<html'))) {
        throw new Error('NSE returned HTML (rate limit / bot detection)');
    }
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
        let lastErr = null;
        for (let attempt = 1; attempt <= NSE_MAX_RETRIES; attempt++) {
            try {
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

                // Success — build and return the result
                return this._buildResult(nseSymbol, type, chain, rows);
            } catch (err) {
                lastErr = err;
                const retryable = /rate limit|429|bot detection|HTML|ECONNRESET|ETIMEDOUT|timeout/i.test(err.message);
                logger.warn(`NSE option chain attempt ${attempt}/${NSE_MAX_RETRIES} for ${nseSymbol}: ${err.message}`);
                if (retryable && attempt < NSE_MAX_RETRIES) {
                    const delay = NSE_RETRY_DELAY_MS * attempt;
                    logger.debug(`Retrying NSE in ${delay}ms…`);
                    await sleep(delay);
                    // Invalidate cookie on rate limit so next attempt gets a fresh one
                    if (/rate limit|429|bot detection|HTML/i.test(err.message)) {
                        _cookieCache = { value: '', at: 0 };
                    }
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('NSE option chain failed after retries');
    }

    /**
     * Build the context + snapshot from raw NSE chain data.
     */
    _buildResult(nseSymbol, type, chain, rows) {
        const records = chain?.records;
        const expiry = (chain?.records?.expiryDates || [])[0] || records?.expiry || '';
        const spot = records?.underlyingValue ?? records?.underlying ?? null;
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

        const atmCe = atm?.CE
            ? {
                  strike: atm.strikePrice,
                  ltp: atm.CE.lastPrice ?? null,
                  oi: atm.CE.openInterest ?? null,
                  iv: atm.CE.impliedVolatility ?? null,
                  changeOi: atm.CE.changeinOpenInterest ?? null,
              }
            : null;
        const atmPe = atm?.PE
            ? {
                  strike: atm.strikePrice,
                  ltp: atm.PE.lastPrice ?? null,
                  oi: atm.PE.openInterest ?? null,
                  iv: atm.PE.impliedVolatility ?? null,
                  changeOi: atm.PE.changeinOpenInterest ?? null,
              }
            : null;

        const strikes = rows
            .map((row) => ({
                strike: row.strikePrice,
                ce: row.CE ? { ltp: row.CE.lastPrice ?? null, oi: row.CE.openInterest ?? null, iv: row.CE.impliedVolatility ?? null } : null,
                pe: row.PE ? { ltp: row.PE.lastPrice ?? null, oi: row.PE.openInterest ?? null, iv: row.PE.impliedVolatility ?? null } : null,
            }))
            .filter((s) => Number.isFinite(s.strike));

        return {
            context: lines.join('\n'),
            snapshot: {
                symbol: nseSymbol,
                type,
                expiry,
                spot,
                pcr,
                strikes,
                totalCeOi,
                totalPeOi,
                topCe,
                topPe,
                atmStrike: atm?.strikePrice ?? null,
                atmCe,
                atmPe,
                chainTimestamp: records?.timestamp || null,
                fetchedAt: new Date().toISOString(),
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

/**
 * Live premium for one strike out of a snapshot.
 * @param {object|null} snapshot from fetchOptionContext
 * @param {number} strike
 * @param {'CE'|'PE'} side
 * @returns {{ ltp: number|null, iv: number|null, oi: number|null }|null}
 */
export function findStrikeLeg(snapshot, strike, side) {
    const row = (snapshot?.strikes || []).find((s) => Number(s.strike) === Number(strike));
    if (!row) return null;
    return (String(side).toUpperCase() === 'PE' ? row.pe : row.ce) || null;
}

export const nseOptionChainService = new NseOptionChainService();
export default NseOptionChainService;
