/**
 * On-demand index F&O read + sized entry — NIFTY / BANKNIFTY / FINNIFTY / MIDCPNIFTY.
 *
 * THE DIRECTION IS A FADE, NOT A BREAKOUT. That is the whole point.
 *
 * Index opening-range BREAKOUTS were measured over 23 sessions on real 5m closes
 * and lost at every setting: 36.7% at 1:1 (-0.267R), 16.7% at 1:2, long -0.667R.
 * Fading the same move won:
 *
 *   fade VWAP stretch >=1xATR   n=51  win=66.7%  exp=+0.333R
 *   fade a failed range break   n=32  win=65.6%  exp=+0.313R
 *
 * Positive in all four indices and in both directions, and a per-index holdout
 * (fit NIFTY+BANKNIFTY, judge FINNIFTY+MIDCPNIFTY) came out BETTER held out
 * (+0.417R) than fitted (+0.259R). Every other candidate tested collapsed on
 * exactly that check. There is a structural reason it works: an index is an
 * average of 50 stocks, so idiosyncratic breakouts cancel and what remains
 * mean-reverts, where a single stock trends on its own news.
 *
 * WHAT IS NOT ESTABLISHED, and must stay on the card:
 *   - n is 29-51 across 23 sessions of ONE month, so one regime.
 *   - 12 configurations were tried; the numbers above are the UNTUNED variant
 *     (1xATR, RR 1:1, 10:30), deliberately not the best-looking one (1.5xATR at
 *     10:30 showed 75.9%, which is very likely the multiple-comparisons winner).
 *   - It is measured on the INDEX move. A bought CE/PE lags it because theta runs
 *     against the holder, and this is a counter-trend entry, so the position
 *     usually goes against you before it works.
 *
 * Sizing is pinned to the measured ratio: target and stop are both 1R, because
 * 1:1 is where the edge was measured. Sizing up to fill the capital would raise
 * the loss by exactly as much as the profit, so one lot is usually correct —
 * at 1R it yields Rs608 (NIFTY) to Rs912 (FINNIFTY).
 */

import { nseOptionChainService } from './NseOptionChainService.js';
import { fetchYahooIntradayCandles } from '../utils/yahooIntradayCandles.js';
import { config } from '../config/config.js';
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

/**
 * Session VWAP. Indices frequently report zero volume on Yahoo, so a zero-volume
 * bar counts as weight 1 rather than being dropped — otherwise VWAP collapses to
 * NaN on exactly the instruments this is for.
 */
export function sessionVwap(bars) {
    let pv = 0, v = 0;
    for (const b of bars || []) {
        if (![b?.high, b?.low, b?.close].every((x) => Number.isFinite(x))) continue;
        const typical = (b.high + b.low + b.close) / 3;
        const vol = b.volume > 0 ? b.volume : 1;
        pv += typical * vol;
        v += vol;
    }
    return v > 0 ? pv / v : null;
}

/** ATR over the last `n` completed bars. */
export function barAtr(bars, n = 6) {
    if (!Array.isArray(bars) || bars.length < n + 1) return null;
    const s = bars.slice(-(n + 1));
    let t = 0;
    for (let i = 1; i < s.length; i++) {
        t += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - s[i - 1].close), Math.abs(s[i].low - s[i - 1].close));
    }
    const a = t / n;
    return a > 0 ? a : null;
}

/** Measured window. 10:30 was the tested time; 12:30 turned negative. */
export const SIGNAL_WINDOW = { openMin: 10 * 60, bestMin: 10 * 60 + 30, closeMin: 11 * 60 + 30, deadMin: 12 * 60 + 30 };
export const STRETCH_ATR = 1.0;   // the UNTUNED threshold that survived the holdout
const OR_END_MIN = 9 * 60 + 30;

/**
 * Is there a fade signal right now?
 *
 * Two rules, both measured (see the header): price stretched from VWAP, and a
 * failed opening-range break. Direction is always AGAINST the stretch — indices
 * revert where single stocks trend.
 *
 * @param {{high:number,low:number,close:number,volume:number,min:number}[]} bars session bars, ascending
 * @param {number} nowMin current IST minute-of-day
 */
export function evaluateIndexSignal(bars, nowMin) {
    // Clock first, then data. At 09:45 both "too early" and "not enough bars" are
    // true, but the clock is the reason that will not change by waiting for a feed.
    if (nowMin < SIGNAL_WINDOW.openMin) {
        return { side: null, reason: `too early — the rule was measured from ${hhmm(SIGNAL_WINDOW.openMin)}, VWAP is not established before that`, kind: null };
    }
    if (nowMin > SIGNAL_WINDOW.deadMin) {
        return { side: null, reason: `too late — the same rule measured NEGATIVE after ${hhmm(SIGNAL_WINDOW.deadMin)}`, kind: null };
    }
    const session = (bars || []).filter((b) => Number.isFinite(b?.min) && b.min <= nowMin);
    if (session.length < 8) {
        return { side: null, reason: 'not enough bars yet — needs ~40 minutes of trade', kind: null };
    }

    const vwap = sessionVwap(session);
    const atr = barAtr(session);
    if (!vwap || !atr) return { side: null, reason: 'VWAP/ATR unavailable', kind: null };

    const last = session[session.length - 1];
    const stretch = (last.close - vwap) / atr;

    // rule 1 — stretched from VWAP
    if (Math.abs(stretch) >= STRETCH_ATR) {
        return {
            side: stretch > 0 ? 'short' : 'long',
            kind: 'vwap-stretch',
            reason: `${Math.abs(stretch).toFixed(2)}×ATR ${stretch > 0 ? 'above' : 'below'} VWAP — stretched, fade toward VWAP`,
            vwap, atr, stretch,
            degraded: nowMin > SIGNAL_WINDOW.closeMin,
        };
    }

    // rule 2 — failed opening-range break
    const or = session.filter((b) => b.min < OR_END_MIN);
    if (or.length >= 2) {
        const orHigh = Math.max(...or.map((b) => b.high));
        const orLow = Math.min(...or.map((b) => b.low));
        const after = session.filter((b) => b.min >= OR_END_MIN);
        let broke = 0, brokeIdx = -1;
        for (let i = 0; i < after.length; i++) {
            if (after[i].close > orHigh) { broke = 1; brokeIdx = i; break; }
            if (after[i].close < orLow) { broke = -1; brokeIdx = i; break; }
        }
        if (broke) {
            const since = after.slice(brokeIdx + 1);
            const backInside = since.some((b) => b.close < orHigh && b.close > orLow);
            const stillInside = last.close < orHigh && last.close > orLow;
            if (backInside && stillInside) {
                return {
                    side: broke > 0 ? 'short' : 'long',
                    kind: 'failed-break',
                    reason: `broke the opening range ${broke > 0 ? 'up' : 'down'} then closed back inside — failed break, fade it`,
                    vwap, atr, stretch,
                    degraded: nowMin > SIGNAL_WINDOW.closeMin,
                };
            }
        }
    }

    return {
        side: null,
        kind: null,
        reason: `no setup — ${Math.abs(stretch).toFixed(2)}×ATR from VWAP (needs ≥${STRETCH_ATR}) and no failed range break`,
        vwap, atr, stretch,
    };
}

function hhmm(min) {
    return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * Size the trade so ONE R of index movement lands inside the caller's rupee band.
 *
 * The measured edge is at 1:1, so target and risk are the same size — sizing up to
 * fill the capital would push BOTH past the band. ATM delta is taken as 0.5: the
 * strike is at-the-money by construction, where delta is ~0.5 largely regardless
 * of IV and time, so the premium moves about half the index move.
 *
 * @returns {object|null} null when even one lot breaches the capital
 */
export function sizeIndexTrade({ premium, lot, indexAtr, capital, minProfit, maxProfit, delta = 0.5 }) {
    if (!(premium > 0) || !(lot > 0) || !(indexAtr > 0) || !(capital > 0)) return null;

    const premMove = delta * indexAtr;            // premium move for a 1R index move
    const pnlPerLot = premMove * lot;
    const costPerLot = premium * lot;
    if (costPerLot > capital) {
        return { lots: 0, blocked: `one lot costs ₹${Math.round(costPerLot).toLocaleString('en-IN')}, above the ₹${capital.toLocaleString('en-IN')} capital` };
    }

    // Fewest lots that reach minProfit at 1R, then trimmed to respect maxProfit
    // and capital. Never zero — one lot is the floor if it fits.
    let lots = Math.max(1, Math.ceil(minProfit / pnlPerLot));
    while (lots > 1 && (lots * pnlPerLot > maxProfit || lots * costPerLot > capital)) lots--;
    if (lots * costPerLot > capital) {
        return { lots: 0, blocked: `cannot fit a lot inside ₹${capital.toLocaleString('en-IN')}` };
    }

    const qty = lots * lot;
    const t1Prem = Number((premium + premMove).toFixed(2));
    const t2Prem = Number((premium + premMove * 2).toFixed(2));
    const slPrem = Number(Math.max(0.05, premium - premMove).toFixed(2));

    return {
        lots,
        qty,
        capitalUsed: Math.round(lots * costPerLot),
        premEntry: Number(premium.toFixed(2)),
        premStop: slPrem,
        premT1: t1Prem,
        premT2: t2Prem,
        indexRisk: Number(indexAtr.toFixed(2)),
        riskRs: Math.round((premium - slPrem) * qty),
        t1Rs: Math.round((t1Prem - premium) * qty),
        t2Rs: Math.round((t2Prem - premium) * qty),
        pnlPerLotAt1R: Math.round(pnlPerLot),
    };
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

/** IST minute-of-day, so the signal window is evaluated in market time. */
export function istMinuteOfDay(nowMs = Date.now()) {
    const d = new Date(nowMs + 5.5 * 3600e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Bars belonging to the most recent session present in the series. */
export function todaySessionBars(candles) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const dayOf = (ts) => new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10);
    const withMin = candles
        // The 09:15 bar is a zero-volume pre-open placeholder with high === low.
        .filter((c) => Number.isFinite(c?.close) && !(!(c.volume > 0) && c.high === c.low))
        .map((c) => ({ ...c, min: istMinuteOfDay(c.ts), day: dayOf(c.ts) }));
    if (!withMin.length) return [];
    const latest = withMin.reduce((a, b) => (b.day > a ? b.day : a), withMin[0].day);
    return withMin.filter((c) => c.day === latest).sort((a, b) => a.min - b.min);
}

class IndexAnalysisService {
    constructor(cfg = {}) {
        this.capital = cfg.capital ?? config.INDEX_TRADE_CAPITAL ?? 30_000;
        this.minProfit = cfg.minProfit ?? config.INDEX_TRADE_MIN_PROFIT ?? 600;
        this.maxProfit = cfg.maxProfit ?? config.INDEX_TRADE_MAX_PROFIT ?? 1_200;
    }

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

        const [chainRes, quoteRes, barsRes] = await Promise.allSettled([
            nseOptionChainService.fetchOptionContext(spec.nse),
            indianStockQuoteService.fetchQuote(spec.nse),
            fetchYahooIntradayCandles(spec.yahoo, { interval: '5m', range: '5d' }),
        ]);
        const chain = chainRes.status === 'fulfilled' ? chainRes.value : null;
        const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
        const rawBars = barsRes.status === 'fulfilled'
            ? (Array.isArray(barsRes.value) ? barsRes.value : barsRes.value?.candles)
            : null;
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

        // ---- directional read, from the fade rules that survived the holdout ----
        const nowMin = istMinuteOfDay();
        const todayBars = todaySessionBars(rawBars);
        const signal = evaluateIndexSignal(todayBars, nowMin);

        // A fade long buys the CE; a fade short buys the PE.
        const leg = signal.side === 'long' ? snap.atmCe : signal.side === 'short' ? snap.atmPe : null;
        const legName = signal.side === 'long' ? 'CE' : signal.side === 'short' ? 'PE' : null;
        const plan = signal.side && leg?.ltp != null && signal.atr
            ? sizeIndexTrade({
                  premium: leg.ltp,
                  lot,
                  indexAtr: signal.atr,
                  capital: this.capital,
                  minProfit: this.minProfit,
                  maxProfit: this.maxProfit,
              })
            : null;

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
            capital: this.capital,
            nowMin,
            signal,
            legName,
            leg,
            plan,
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

        // ------------------------------------------------------- the verdict
        const s = a.signal || {};
        const p = a.plan;
        if (!s.side) {
            L.push('┌─ *🚫 NO ENTRY* ─');
            L.push(`│ ${s.reason || 'no setup'}`);
            if (s.vwap != null) L.push(`│ VWAP ${fmt(s.vwap)} · spot is ${fmt(Math.abs(s.stretch ?? 0), 2)}×ATR away`);
            L.push('└────────────────────────────');
        } else if (p?.blocked) {
            L.push('┌─ *🚫 NO ENTRY (size)* ─');
            L.push(`│ Setup present (${s.kind}) but ${p.blocked}`);
            L.push('└────────────────────────────');
        } else if (p) {
            const dirWord = s.side === 'long' ? 'BUY CE' : 'BUY PE';
            L.push(`┌─ *✅ ENTER — ${dirWord}* ─`);
            L.push(`│ Why: ${s.reason}`);
            if (s.degraded) L.push(`│ ⚠️ past ${hhmm(SIGNAL_WINDOW.closeMin)} — weaker than the tested window`);
            L.push('│');
            L.push(`│ *${a.atmStrike} ${a.legName}* · ${a.expiry}`);
            L.push(`│ Lots: *${p.lots}* (${p.qty} qty) · capital used *${inr(p.capitalUsed)}* of ${inr(a.capital)}`);
            L.push('│');
            L.push(`│ 🟢 ENTRY  ₹${fmt(p.premEntry)}`);
            L.push(`│ 🎯 EXIT AT ₹${fmt(p.premT1)}  →  profit *${inr(p.t1Rs)}*`);
            L.push(`│ 🛑 STOP   ₹${fmt(p.premStop)}  →  loss *${inr(p.riskRs)}*`);
            L.push(`│ 🏃 runner ₹${fmt(p.premT2)}  →  profit ${inr(p.t2Rs)} _(beyond the tested target)_`);
            L.push('└────────────────────────────');
            L.push('');
            L.push(`_Exit at ₹${fmt(p.premT1)} is the measured target: a ${fmt(p.indexRisk)}-point index move_`);
            L.push(`_toward VWAP, ~half of which reaches the ATM premium. Stop and target are_`);
            L.push('_the same size (1:1) — that is the ratio the edge was measured at, so_');
            L.push('_do not widen one without the other._');
        }
        L.push('');
        L.push('─────────────────────────────');
        L.push('*How this was measured*');
        L.push('_Indices REVERT where single stocks trend. Fading a stretch from VWAP_');
        L.push('_scored *66.7% at 1:1* (n=51) over 23 sessions; the same opening-range_');
        L.push('_BREAKOUT scored 36.7%. Positive in all four indices and both_');
        L.push('_directions, and the held-out pair (FINNIFTY/MIDCPNIFTY) came out_');
        L.push('_better than the fitted pair._');
        L.push('_Caveats: n=51, one month, one regime. Measured on the INDEX move —_');
        L.push('_theta works against a bought option, so the premium lags it._');
        L.push('⚠️ _Not financial advice · education only · size small_');
        return L.join('\n');
    }
}

export const indexAnalysisService = new IndexAnalysisService();
export default IndexAnalysisService;
