/**
 * SENSEX / BANKEX option chain from BSE.
 *
 * This was previously written off: indexUniverse called SENSEX "a BSE index —
 * the NSE option chain does not cover it" and expiryCalendar said BSE "exposes
 * no usable public API". Both are now out of date.
 *
 * The endpoint is DerivOptionChain_IV/w, named in the Angular controller behind
 * beta.bseindia.com's option-chain page:
 *
 *   https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_IV/w
 *       ?scrip_cd=1&Expiry=03%20Sep%202026&strprice=
 *
 * Three things make this easy to get wrong, all found the hard way:
 *
 *   1. The old Derivative/getOptionChain/w path 302s to error_Bse.html with
 *      "The Page you are looking for has been moved". It returns HTTP 200, so a
 *      status check passes and the JSON parse is what fails.
 *   2. www.bseindia.com answers "Access Denied" to non-browser clients, which
 *      makes this look like IP blocking. api.bseindia.com is fine.
 *   3. The payload is ASYMMETRIC. Call fields carry a C_ prefix
 *      (C_Last_Trd_Price, C_BidPrice, C_Open_Interest); the put fields for the
 *      same strike are UNPREFIXED (Last_Trd_Price, BidPrice, Open_Interest).
 *      Reading P_* returns zeros for every put and looks like a quiet market
 *      rather than a bug.
 *
 * Expiry must be passed exactly as ddlExpiry returns it ("03 Sep 2026").
 * Reformatting to DD/MM/YYYY makes the request fail.
 *
 * The snapshot shape mirrors NseOptionChainService so downstream consumers do
 * not care which exchange a chain came from.
 */

import axios from 'axios';

import { logger } from '../utils/logger.js';

const API_BASE = 'https://api.bseindia.com/BseIndiaAPI/api';

// Referer/Origin must look like the beta site; the API rejects bare requests.
const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    Referer: 'https://beta.bseindia.com/',
    Origin: 'https://beta.bseindia.com',
};

/** BSE scrip codes for the index derivatives. */
export const BSE_SCRIP_CODES = { SENSEX: 1, BANKEX: 12 };

const TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 60_000;
const EXPIRY_TTL_MS = 60 * 60_000;

const chainCache = new Map();
const expiryCache = new Map();

/** Strip thousands separators; empty strings mean "not traded", not zero-ish. */
function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** BSE sends IV to ~14 decimal places; nobody needs that on a phone. */
function pct(v) {
    const n = num(v);
    return n == null ? null : Math.round(n * 100) / 100;
}

function intOrNull(v) {
    const n = num(v);
    return n == null ? null : Math.round(n);
}

async function bseGet(path, params) {
    const { data } = await axios.get(`${API_BASE}/${path}`, {
        params,
        timeout: TIMEOUT_MS,
        headers: HEADERS,
        // The moved endpoint redirects to an HTML error page; following it and
        // then failing on the parse is more confusing than seeing it here.
        maxRedirects: 3,
        validateStatus: (s) => s >= 200 && s < 400,
    });
    if (typeof data === 'string') {
        throw new Error('BSE returned HTML (endpoint moved or blocked)');
    }
    return data;
}

/**
 * Expiries for a BSE index, nearest first.
 * @param {number} scripCd
 * @returns {Promise<string[]>} e.g. ['03 Sep 2026', '10 Sep 2026']
 */
export async function fetchBseExpiries(scripCd = 1) {
    const hit = expiryCache.get(scripCd);
    if (hit && Date.now() - hit.at < EXPIRY_TTL_MS) return hit.value;

    try {
        const data = await bseGet('ddlExpiry/w', {
            scrip_cd: String(scripCd),
            ProductType: 'IO',
        });
        const rows = data?.Table;
        if (!Array.isArray(rows)) return [];
        // The field is spelled eXPIRY in BSE's payload.
        const out = rows
            .map((r) => String(r?.eXPIRY || r?.Expiry || r?.EXPIRY || '').trim())
            .filter(Boolean);
        if (out.length) expiryCache.set(scripCd, { at: Date.now(), value: out });
        return out;
    } catch (err) {
        logger.debug(`BSE expiries ${scripCd}: ${err.message}`);
        return [];
    }
}

/**
 * Option chain snapshot for a BSE index.
 *
 * @param {string} [symbol] SENSEX or BANKEX
 * @param {string} [expiry] defaults to the nearest
 * @returns {Promise<object|null>} snapshot matching NseOptionChainService's shape
 */
export async function fetchBseOptionChain(symbol = 'SENSEX', expiry = null) {
    const key = String(symbol || '').toUpperCase();
    const scripCd = BSE_SCRIP_CODES[key];
    if (!scripCd) {
        logger.debug(`BSE chain: unknown symbol ${symbol}`);
        return null;
    }

    const cacheKey = `${key}:${expiry || 'near'}`;
    const hit = chainCache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let useExpiry = expiry;
    if (!useExpiry) {
        const expiries = await fetchBseExpiries(scripCd);
        useExpiry = expiries[0];
    }
    if (!useExpiry) return null;

    let data;
    try {
        data = await bseGet('DerivOptionChain_IV/w', {
            scrip_cd: String(scripCd),
            Expiry: useExpiry, // exactly as BSE gave it; do not reformat
            strprice: '',
        });
    } catch (err) {
        logger.warn(`BSE option chain ${key}: ${err.message}`);
        return null;
    }

    const rows = data?.Table;
    if (!Array.isArray(rows) || !rows.length) return null;

    let spot = null;
    const strikes = [];
    let totalCeOi = 0;
    let totalPeOi = 0;

    for (const r of rows) {
        const strike = intOrNull(r?.Strike_Price);
        if (!strike) continue;
        // The underlying is repeated on every row rather than sent once.
        if (spot == null) spot = num(r?.UlaValue);

        const ceOi = intOrNull(r?.C_Open_Interest);
        const peOi = intOrNull(r?.Open_Interest);
        totalCeOi += ceOi || 0;
        totalPeOi += peOi || 0;

        strikes.push({
            strike,
            ce: {
                ltp: num(r?.C_Last_Trd_Price),
                bid: num(r?.C_BidPrice),
                ask: num(r?.C_OfferPrice),
                oi: ceOi,
                changeOi: intOrNull(r?.C_Absolute_Change_OI),
                iv: pct(r?.C_IV),
                volume: intOrNull(r?.C_Vol_Traded),
                symbol: r?.C_Series_Code || '',
            },
            // Unprefixed half of the same row.
            pe: {
                ltp: num(r?.Last_Trd_Price),
                bid: num(r?.BidPrice),
                ask: num(r?.OfferPrice),
                oi: peOi,
                changeOi: intOrNull(r?.Absolute_Change_OI),
                iv: pct(r?.IV),
                volume: intOrNull(r?.Vol_Traded),
                symbol: r?.p_Series_Code || '',
            },
        });
    }

    if (!strikes.length) return null;
    strikes.sort((a, b) => a.strike - b.strike);

    const atm = spot
        ? strikes.reduce((best, s) =>
              Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best,
          )
        : null;

    const snapshot = {
        symbol: key,
        exchange: 'BSE',
        type: 'Index',
        expiry: useExpiry,
        spot,
        pcr: totalCeOi > 0 ? Number((totalPeOi / totalCeOi).toFixed(2)) : null,
        strikes,
        totalCeOi,
        totalPeOi,
        atmStrike: atm?.strike ?? null,
        atmCe: atm?.ce ?? null,
        atmPe: atm?.pe ?? null,
        chainTimestamp: data?.ASON?.DT_TM?.trim() || null,
        fetchedAt: new Date().toISOString(),
    };

    chainCache.set(cacheKey, { at: Date.now(), value: snapshot });
    return snapshot;
}

/**
 * Nearest strike on the requested side that trades within a premium band.
 *
 * Untraded strikes carry a null LTP rather than 0, so they are skipped instead
 * of being treated as free.
 *
 * @param {object} snapshot
 * @param {'CE'|'PE'} side
 * @param {{ minPremium?: number, maxPremium?: number }} [opts]
 */
export function pickStrike(snapshot, side = 'CE', opts = {}) {
    if (!snapshot?.strikes?.length || !snapshot.spot) return null;
    const min = opts.minPremium ?? 0;
    const max = opts.maxPremium ?? Number.POSITIVE_INFINITY;
    const leg = side === 'PE' ? 'pe' : 'ce';

    const usable = snapshot.strikes.filter((s) => {
        const ltp = s[leg]?.ltp;
        return Number.isFinite(ltp) && ltp >= min && ltp <= max;
    });
    if (!usable.length) return null;

    return usable.reduce((best, s) =>
        Math.abs(s.strike - snapshot.spot) < Math.abs(best.strike - snapshot.spot)
            ? s
            : best,
    );
}

export function _resetBseChainCache() {
    chainCache.clear();
    expiryCache.clear();
}

export default { fetchBseOptionChain, fetchBseExpiries, pickStrike, BSE_SCRIP_CODES };
