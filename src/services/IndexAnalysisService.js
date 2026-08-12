/**
 * On-demand index F&O read — NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not issue a directional call. Index opening-range breakouts were
 * measured over 23 sessions on real 5m closes and lost at every setting:
 *
 *   RR 1:1    n=30  win=36.7%  exp=-0.267R
 *   RR 1:2    n=30  win=16.7%  exp=-0.500R
 *   RR 1:2.5  n=30  win=13.3%  exp=-0.533R
 *
 * Long -0.667R, short -0.222R. There is a structural reason: an index is an
 * average of 50 stocks, so idiosyncratic breakouts cancel and what is left
 * mean-reverts. The same breakout logic scored 58.3% on stock selection.
 * A bought CE/PE is worse still, because theta works against the holder all day.
 *
 * So this surfaces what the market is actually pricing — OI walls, PCR, max pain,
 * ATM premiums and the capital each leg costs — and leaves the decision with the
 * reader. When enough graded outcomes exist to justify a directional rule, it can
 * be added here with a number attached. Not before.
 */

import { nseOptionChainService } from './NseOptionChainService.js';
import { indianStockQuoteService } from './IndianStockQuoteService.js';
import { getIndexSpec, INDEX_KEYS, unsupportedIndexReason } from '../data/indexUniverse.js';
import { maxPain } from '../utils/blackScholes.js';
import { logger } from '../utils/logger.js';

const fmt = (n, d = 2) =>
    n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(d).replace(/\.00$/, '');
const inr = (n) =>
    n == null || !Number.isFinite(Number(n)) ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;

/**
 * Where spot sits inside the day's range, 0 = at the low, 1 = at the high.
 * @returns {number|null}
 */
export function rangePosition(spot, low, high) {
    // Number(null) is 0 and Number.isFinite(0) is true, so a missing value would
    // silently read as a real zero — the same trap that let all-zero candles
    // through the Yahoo fetchers and broke the pre-open IEP fallbacks.
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const s = num(spot), lo = num(low), hi = num(high);
    if (s === null || lo === null || hi === null) return null;
    const span = hi - lo;
    if (!(span > 0)) return null;
    return Math.min(1, Math.max(0, (s - lo) / span));
}

/**
 * Nearest OI wall above and below spot. A "wall" is simply the highest-OI strike
 * on the side that would resist price — calls above, puts below.
 * @param {{strike:number, oi:number}[]} topCe
 * @param {{strike:number, oi:number}[]} topPe
 */
export function oiWalls(topCe, topPe, spot) {
    const s = Number(spot);
    const above = (topCe || [])
        .filter((r) => Number.isFinite(r?.strike) && r.strike >= s)
        .sort((a, b) => (b.oi || 0) - (a.oi || 0))[0] || null;
    const below = (topPe || [])
        .filter((r) => Number.isFinite(r?.strike) && r.strike <= s)
        .sort((a, b) => (b.oi || 0) - (a.oi || 0))[0] || null;
    return { resistance: above, support: below };
}

/** PCR read in words. Thresholds are conventional, not fitted to anything. */
export function pcrLabel(pcr) {
    if (pcr == null || !Number.isFinite(Number(pcr))) return null;
    const v = Number(pcr);
    if (v >= 1.3) return 'put-heavy (crowded downside protection)';
    if (v >= 1.0) return 'mildly put-heavy';
    if (v >= 0.7) return 'mildly call-heavy';
    return 'call-heavy (crowded upside)';
}

class IndexAnalysisService {
    /**
     * @param {string} rawSymbol
     * @returns {Promise<object>} analysis payload
     * @throws when the symbol is not a supported index
     */
    async analyze(rawSymbol) {
        const spec = getIndexSpec(rawSymbol);
        if (!spec) {
            const reason = unsupportedIndexReason(rawSymbol);
            throw new Error(
                reason
                    ? `${String(rawSymbol).toUpperCase()}: ${reason}. Supported: ${INDEX_KEYS.join(', ')}`
                    : `Not an F&O index. Supported: ${INDEX_KEYS.join(', ')}`
            );
        }

        const [chainRes, quoteRes] = await Promise.allSettled([
            nseOptionChainService.fetchOptionContext(spec.nse),
            indianStockQuoteService.fetchQuote(spec.nse),
        ]);
        const chain = chainRes.status === 'fulfilled' ? chainRes.value : null;
        const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
        const snap = chain?.snapshot || null;

        if (!snap) {
            throw new Error(`Option chain unavailable for ${spec.label} — NSE may be rate limiting.`);
        }

        // Prefer the chain's own underlyingValue: it is the number the strikes are
        // priced against, so a Yahoo/chain disagreement would misplace the ATM.
        const spot = snap.spot ?? quote?.price ?? null;
        const walls = oiWalls(snap.topCe, snap.topPe, spot);
        const mp = maxPain(
            (snap.topCe || []).map((c) => ({
                strike: c.strike,
                ceOi: c.oi,
                peOi: (snap.topPe || []).find((p) => p.strike === c.strike)?.oi || 0,
            }))
        );

        const lot = spec.lot;
        const ceCapital = snap.atmCe?.ltp != null ? snap.atmCe.ltp * lot : null;
        const peCapital = snap.atmPe?.ltp != null ? snap.atmPe.ltp * lot : null;

        logger.info(`📐 Index read ${spec.nse}: spot ${fmt(spot)} ATM ${snap.atmStrike} exp ${snap.expiry}`);

        return {
            key: spec.nse,
            label: spec.label,
            lot,
            spot,
            changePct: quote?.changePct ?? null,
            // The quote exposes `high`/`low` (session extremes), not dayHigh/dayLow —
            // reading the wrong names made the range line vanish silently.
            dayLow: quote?.low ?? null,
            dayHigh: quote?.high ?? null,
            prevClose: quote?.prevClose ?? null,
            rangePos: rangePosition(spot, quote?.low, quote?.high),
            expiry: snap.expiry ?? null,
            atmStrike: snap.atmStrike ?? null,
            atmCe: snap.atmCe ?? null,
            atmPe: snap.atmPe ?? null,
            ceCapital,
            peCapital,
            pcr: snap.pcr ?? null,
            pcrLabel: pcrLabel(snap.pcr),
            walls,
            maxPain: mp,
            topCe: snap.topCe || [],
            topPe: snap.topPe || [],
        };
    }

    /** WhatsApp card. States what it is not, so nobody reads a call into it. */
    format(a) {
        const L = [];
        L.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
        L.push(`┃  📐 *INDEX F&O READ* 📐  ┃`);
        L.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
        L.push('');
        L.push(`*${a.label}* · lot ${a.lot}`);
        const chg = a.changePct == null ? '' : ` (${a.changePct >= 0 ? '+' : ''}${fmt(a.changePct)}%)`;
        L.push(`Spot: *${fmt(a.spot)}*${chg}`);
        if (a.dayLow != null && a.dayHigh != null) {
            const pos = a.rangePos == null ? '' : ` · ${Math.round(a.rangePos * 100)}% of range`;
            L.push(`Day range: ${fmt(a.dayLow)} – ${fmt(a.dayHigh)}${pos}`);
        }
        L.push(`Expiry: *${a.expiry || '—'}*`);
        L.push('');

        L.push('┌─ *ATM OPTIONS* ─');
        L.push(`│ Strike: *${a.atmStrike ?? '—'}*`);
        if (a.atmCe) {
            L.push(`│ CE ₹${fmt(a.atmCe.ltp)}  ·  1 lot = ${inr(a.ceCapital)}${a.atmCe.iv != null ? `  ·  IV ${fmt(a.atmCe.iv, 1)}%` : ''}`);
        }
        if (a.atmPe) {
            L.push(`│ PE ₹${fmt(a.atmPe.ltp)}  ·  1 lot = ${inr(a.peCapital)}${a.atmPe.iv != null ? `  ·  IV ${fmt(a.atmPe.iv, 1)}%` : ''}`);
        }
        L.push('└────────────────────────────');
        L.push('');

        L.push('┌─ *WHAT THE CHAIN IS PRICING* ─');
        if (a.pcr != null) L.push(`│ PCR: *${fmt(a.pcr)}* — ${a.pcrLabel}`);
        if (a.maxPain != null) L.push(`│ Max pain: *${a.maxPain}*`);
        if (a.walls?.resistance) {
            L.push(`│ Call wall above: *${a.walls.resistance.strike}* (OI ${Number(a.walls.resistance.oi).toLocaleString('en-IN')})`);
        }
        if (a.walls?.support) {
            L.push(`│ Put wall below: *${a.walls.support.strike}* (OI ${Number(a.walls.support.oi).toLocaleString('en-IN')})`);
        }
        L.push('└────────────────────────────');
        L.push('');

        if (a.topCe?.length) {
            L.push(`*Top CE OI:* ${a.topCe.slice(0, 3).map((r) => `${r.strike} (${Number(r.oi).toLocaleString('en-IN')})`).join(' · ')}`);
        }
        if (a.topPe?.length) {
            L.push(`*Top PE OI:* ${a.topPe.slice(0, 3).map((r) => `${r.strike} (${Number(r.oi).toLocaleString('en-IN')})`).join(' · ')}`);
        }
        L.push('');
        L.push('─────────────────────────────');
        L.push('_No direction called by design. Index opening-range breakouts_');
        L.push('_measured 36.7% at 1:1 and 16.7% at 1:2 over 23 sessions —_');
        L.push('_indices mean-revert where single stocks trend. These are the_');
        L.push('_levels the chain is pricing, not a trade._');
        L.push('⚠️ _Not financial advice · education only_');
        return L.join('\n');
    }
}

export const indexAnalysisService = new IndexAnalysisService();
export default IndexAnalysisService;
