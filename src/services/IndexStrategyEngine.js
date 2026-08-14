/**
 * Index scalp strategies ported from the user's tgbot2 bot (Python/pandas) —
 * the auto-alert engine that runs NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY F&O
 * scalps "all day + expiry". The goal of the port: `/index` should almost
 * never dead-end with "no trade" — when the measured fade rule is quiet, one
 * of these five usually fires.
 *
 * Strategies (names and self-reported backtests from tgbot2's header):
 *   1. EMA+RSI+OI+VWAP Confluence  (~62-68% WR) — all day
 *   2. ORB (Opening Range Breakout) (~58-65% WR) — 9:30-11:00 window
 *   3. PCR Extreme Reversal         (~58-64% WR) — all day
 *   4. MACD Multi-Timeframe         (~65-72% WR) — 1H + 15m alignment
 *   5. Sideways Scalp (BB+VWAP Mean Reversion)    — low-ADX chop
 *
 * HONESTY: these win rates come from tgbot2's own backtests on NIFTY/BANKNIFTY
 * and are NOT re-verified here. Every card that fires one says so. The math is
 * ported faithfully (see indicators.js for the pandas-semantics notes), but the
 * quality score is reduced — tgbot2 also gates on option-leg volume, bid-ask
 * spread and VIX, none of which this codebase's chain snapshot carries.
 */

import { emaPandas, rsi, macdState, adx, bollinger, lastFinite } from '../utils/indicators.js';

export const STRATEGY_KEYS = {
    CONFLUENCE: 'confluence',
    ORB: 'orb',
    PCR_REVERSAL: 'pcr-reversal',
    MACD_MTF: 'macd-mtf',
    MEAN_REV: 'mean-rev',
};

export const STRATEGY_META = {
    [STRATEGY_KEYS.CONFLUENCE]: { name: 'EMA+RSI+OI+VWAP Confluence', baseWin: 66, rank: 30, tag: '~62-68%' },
    [STRATEGY_KEYS.ORB]: { name: 'ORB (Opening Range Breakout)', baseWin: 62, rank: 25, tag: '~58-65%' },
    [STRATEGY_KEYS.PCR_REVERSAL]: { name: 'PCR Extreme Reversal', baseWin: 61, rank: 20, tag: '~58-64%' },
    [STRATEGY_KEYS.MACD_MTF]: { name: 'MACD Multi-Timeframe (1H+15m)', baseWin: 69, rank: 35, tag: '~65-72%' },
    [STRATEGY_KEYS.MEAN_REV]: { name: 'Sideways Scalp (BB Mean Reversion)', baseWin: 58, rank: 22, tag: '~65-70%' },
};

const DEFAULTS = {
    minLayers: 3,        // FNO_CONFLUENCE_MIN_LAYERS
    orbBreakPct: 0.08,   // ORB_MIN_BREAK_PCT
    minAdx: 16,          // FNO_MIN_ADX
    lastEntryMin: 15 * 60, // FNO_LAST_ENTRY_HOUR=15:00
};

/** IST minute-of-day (market clock, same convention as IndexAnalysisService). */
export function istMinuteOfDay(nowMs = Date.now()) {
    const d = new Date(nowMs + 5.5 * 3600e3);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Session VWAP, same zero-volume-tolerant formula as the fade engine. */
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

/** ATR over the last `n` completed bars (same formula as the fade engine). */
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

/** Resample 5m bars into 15m bars (open dropped — strategies never read it). */
export function resample15m(bars) {
    const out = [];
    for (const b of bars || []) {
        const min = b.min;
        if (!Number.isFinite(min)) continue;
        const slot = Math.floor(min / 15);
        let cur = out[out.length - 1];
        if (!cur || cur.slot !== slot) {
            cur = { slot, min: slot * 15, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
            out.push(cur);
        } else {
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume += b.volume || 0;
        }
    }
    return out;
}

/**
 * Build the technical snapshot the strategies read, from the same feeds the
 * fade engine already uses (5m session bars + full 5d 5m + optional 1h).
 *
 * @param {object} d
 * @param {{min:number,high:number,low:number,close:number,volume:number}[]} d.today5m today's 5m session bars, ascending
 * @param {{min:number,high:number,low:number,close:number,volume:number}[]} d.full5m 5d 5m bars, ascending
 * @param {object|null} d.hourly 1h bars (for MACD-MTF), or null
 * @param {object|null} d.chain NSE chain snapshot (spot, pcr, atmCe, atmPe, topCe, topPe)
 * @param {object|null} d.quote quote service result (prevClose)
 */
export function buildTech({ today5m = [], full5m = [], hourly = null, chain = null, quote = null } = {}) {
    const spot = Number(chain?.spot) || null;
    const fifteen = resample15m(full5m);
    const closes15 = fifteen.map((b) => b.close).filter(Number.isFinite);
    const today15 = resample15m(today5m);
    const todayCloses = today15.map((b) => b.close).filter(Number.isFinite);

    // ORB = the first 15m candle of today (09:15-09:30), same as tgbot2.
    const orbBars = today5m.filter((b) => b.min < 9 * 60 + 30);
    const orbHigh = orbBars.length ? Math.max(...orbBars.map((b) => b.high)) : null;
    const orbLow = orbBars.length ? Math.min(...orbBars.map((b) => b.low)) : null;

    const ema9 = lastFinite(emaPandas(closes15, 9));
    const ema21 = lastFinite(emaPandas(closes15, 21));

    // 4-bar lookback on 15m = 1 hour of momentum (tgbot2's mom_pct).
    let momPct = null;
    if (closes15.length > 5) {
        const ref = closes15[closes15.length - 5];
        if (ref) momPct = ((closes15[closes15.length - 1] - ref) / ref) * 100;
    }

    const prevClose = Number(quote?.prevClose) || null;
    let dayPct = null;
    if (spot != null && prevClose != null && prevClose > 0) {
        dayPct = ((spot - prevClose) / prevClose) * 100;
    }

    const h1Closes = Array.isArray(hourly)
        ? hourly.map((b) => b.close).filter(Number.isFinite)
        : null;
    const mtfMacd = {
        ready: h1Closes != null && h1Closes.length >= 35,
        h1: h1Closes != null ? macdState(h1Closes) : null,
        m15: macdState(closes15, { crossLookback: 3 }),
    };

    return {
        spot,
        vwap: sessionVwap(today5m),
        ema9,
        ema21,
        rsi: rsi(closes15, 7),
        adx: adx({
            high: fifteen.map((b) => b.high),
            low: fifteen.map((b) => b.low),
            close: closes15,
        }),
        bb: bollinger(closes15, 20, 2),
        orbHigh,
        orbLow,
        momPct,
        dayPct,
        atr15: barAtr(today15.length ? today15 : fifteen, 6),
        mtfMacd,
        lastBarMin: today5m.length ? today5m[today5m.length - 1].min : null,
        todayCloses,
    };
}

// ─────────────────────────── STRATEGY 1: Confluence ───────────────────────────

export function checkConfluence(tech, chain, opts) {
    const { spot, vwap, ema9, ema21, rsi: rsiV, momPct, dayPct } = tech;
    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const atmCeChg = Number(chain?.atmCe?.changeOi) || 0;
    const atmPeChg = Number(chain?.atmPe?.changeOi) || 0;
    const support = chain?.walls?.support?.strike != null ? Number(chain.walls.support.strike) : null;
    const resistance = chain?.walls?.resistance?.strike != null ? Number(chain.walls.resistance.strike) : null;

    let votes = 0;
    let layers = 0;
    const reasons = [];

    // VWAP layer
    if (spot != null && vwap != null) {
        if (spot > vwap) { votes += 1; layers += 1; reasons.push(`Above VWAP ${vwap.toFixed(0)}`); }
        else if (spot < vwap) { votes -= 1; layers += 1; reasons.push(`Below VWAP ${vwap.toFixed(0)}`); }
    } else if (dayPct != null && dayPct > 0.15) { votes += 1; layers += 1; reasons.push(`Day +${dayPct.toFixed(2)}%`); }
    else if (dayPct != null && dayPct < -0.15) { votes -= 1; layers += 1; reasons.push(`Day ${dayPct.toFixed(2)}%`); }

    // EMA layer
    if (spot != null && ema9 != null && ema21 != null) {
        if (ema9 > ema21 && spot > ema9) { votes += 1; layers += 1; reasons.push(`Price > EMA9(${ema9.toFixed(0)}) > EMA21(${ema21.toFixed(0)})`); }
        else if (ema9 < ema21 && spot < ema9) { votes -= 1; layers += 1; reasons.push(`Price < EMA9(${ema9.toFixed(0)}) < EMA21(${ema21.toFixed(0)})`); }
        else if (ema9 > ema21) { votes += 1; layers += 1; reasons.push('EMA9 > EMA21 uptrend'); }
        else if (ema9 < ema21) { votes -= 1; layers += 1; reasons.push('EMA9 < EMA21 downtrend'); }
    } else if (momPct != null && momPct > 0.1) { votes += 1; layers += 1; reasons.push(`Momentum +${momPct.toFixed(2)}%`); }
    else if (momPct != null && momPct < -0.1) { votes -= 1; layers += 1; reasons.push(`Momentum ${momPct.toFixed(2)}%`); }

    // RSI layer
    if (rsiV != null) {
        if (rsiV >= 55) { votes += 1; layers += 1; reasons.push(`RSI-7 = ${rsiV.toFixed(0)} bullish`); }
        else if (rsiV <= 45) { votes -= 1; layers += 1; reasons.push(`RSI-7 = ${rsiV.toFixed(0)} bearish`); }
    }

    // OI layer
    let oiVote = 0;
    if (pcr > 1.15) { oiVote += 1; reasons.push(`PCR ${pcr.toFixed(2)} (PE heavy)`); }
    else if (pcr < 0.85) { oiVote -= 1; reasons.push(`PCR ${pcr.toFixed(2)} (CE heavy)`); }
    const atmNet = atmCeChg - atmPeChg;
    if (atmNet > 500) { oiVote += 1; reasons.push('ATM CE OI building'); }
    else if (atmNet < -500) { oiVote -= 1; reasons.push('ATM PE OI building'); }
    if (spot != null) {
        if (support != null && Math.abs(spot - support) / spot * 100 < 0.5) { oiVote += 1; reasons.push(`Near support ${support}`); }
        else if (resistance != null && Math.abs(spot - resistance) / spot * 100 < 0.5) { oiVote -= 1; reasons.push(`Near resistance ${resistance}`); }
    }
    if (oiVote !== 0) { layers += 1; votes += oiVote > 0 ? 1 : -1; }

    const agreed = Math.abs(votes);
    if (agreed < opts.minLayers) return null;
    return {
        key: STRATEGY_KEYS.CONFLUENCE,
        side: votes > 0 ? 'CE' : 'PE',
        strength: 'STRONG',
        layers: `${agreed}/4`,
        reasons,
    };
}

// ─────────────────────────────── STRATEGY 2: ORB ───────────────────────────────

export function checkOrb(tech, chain, opts, nowMin) {
    const { spot, orbHigh, orbLow, rsi: rsiV, ema9 } = tech;
    if (spot == null || orbHigh == null || orbLow == null) return null;
    // ORB is a 9:30-11:00 window strategy.
    if (nowMin > 11 * 60) return null;

    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const reasons = [];
    const orbRange = orbHigh - orbLow;
    if (!(orbRange > 0)) return null;

    let side, breakoutPct;
    if (spot > orbHigh) {
        breakoutPct = ((spot - orbHigh) / orbHigh) * 100;
        if (breakoutPct < opts.orbBreakPct) return null;
        side = 'CE';
        if (rsiV != null && rsiV < 55) return null;
        if (ema9 != null && spot < ema9) return null;
        reasons.push(`ORB breakout above ${orbHigh.toFixed(0)} (+${breakoutPct.toFixed(2)}%)`);
        reasons.push(`ORB range: ${orbLow.toFixed(0)} - ${orbHigh.toFixed(0)} (${orbRange.toFixed(0)} pts)`);
        if (pcr > 1.0) reasons.push(`PCR ${pcr.toFixed(2)} supports breakout`);
        if (rsiV != null) reasons.push(`RSI ${rsiV.toFixed(0)} confirms momentum`);
    } else if (spot < orbLow) {
        breakoutPct = ((orbLow - spot) / orbLow) * 100;
        if (breakoutPct < opts.orbBreakPct) return null;
        side = 'PE';
        if (rsiV != null && rsiV > 45) return null;
        if (ema9 != null && spot > ema9) return null;
        reasons.push(`ORB breakdown below ${orbLow.toFixed(0)} (-${breakoutPct.toFixed(2)}%)`);
        reasons.push(`ORB range: ${orbLow.toFixed(0)} - ${orbHigh.toFixed(0)} (${orbRange.toFixed(0)} pts)`);
        if (pcr < 1.0) reasons.push(`PCR ${pcr.toFixed(2)} supports breakdown`);
        if (rsiV != null) reasons.push(`RSI ${rsiV.toFixed(0)} confirms selling`);
    } else {
        return null;
    }

    return {
        key: STRATEGY_KEYS.ORB,
        side,
        strength: 'STRONG',
        layers: 'ORB+OI',
        reasons,
        orbBreakPct: breakoutPct,
    };
}

// ──────────────────────────── STRATEGY 3: PCR Extreme ────────────────────────────

export function checkPcrExtreme(tech, chain, opts) {
    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const { spot, rsi: rsiV, ema9, adx: adxV } = tech;
    const support = chain?.walls?.support?.strike != null ? Number(chain.walls.support.strike) : null;
    const resistance = chain?.walls?.resistance?.strike != null ? Number(chain.walls.resistance.strike) : null;
    const reasons = [];

    // Contrarian entries need a calm trend — a strong ADX trend chops reversals.
    if (adxV != null && adxV >= 25) return null;

    let side;
    if (pcr >= 1.5) {
        side = 'CE';
        if (rsiV == null || rsiV > 50) return null;
        if (ema9 != null && spot != null && spot < ema9) return null;
        reasons.push(`PCR ${pcr.toFixed(2)} EXTREME PE writing = strong floor`);
        reasons.push(`RSI ${rsiV.toFixed(0)} oversold = bounce setup`);
        if (support != null && spot != null) reasons.push(`Max PE OI wall at ${support} (support floor)`);
        if (ema9 != null && spot != null && spot > ema9) reasons.push('Price above EMA9 = turning up');
    } else if (pcr <= 0.5) {
        side = 'PE';
        if (rsiV == null || rsiV < 50) return null;
        if (ema9 != null && spot != null && spot > ema9) return null;
        reasons.push(`PCR ${pcr.toFixed(2)} EXTREME CE writing = ceiling formed`);
        reasons.push(`RSI ${rsiV.toFixed(0)} overbought = fade setup`);
        if (resistance != null && spot != null) reasons.push(`Max CE OI wall at ${resistance} (resistance ceiling)`);
        if (ema9 != null && spot != null && spot < ema9) reasons.push('Price below EMA9 = turning down');
    } else {
        return null;
    }

    return {
        key: STRATEGY_KEYS.PCR_REVERSAL,
        side,
        strength: 'STRONG',
        layers: `PCR=${pcr.toFixed(2)}`,
        reasons,
        pcr,
    };
}

// ─────────────────────────── STRATEGY 4: MACD Multi-TF ───────────────────────────

export function checkMacdMtf(tech, chain, opts) {
    const mtf = tech.mtfMacd;
    if (!mtf?.ready) return null;
    const h1 = mtf.h1 || {};
    const m15 = mtf.m15 || {};

    const h1Bull = Boolean(h1.bull);
    const h1Bear = Boolean(h1.bear);
    const m15Bull = Boolean(m15.bull);
    const m15Bear = Boolean(m15.bear);
    if ((h1Bull && m15Bear) || (h1Bear && m15Bull)) return null;

    const reasons = [
        `1H MACD ${h1Bull ? 'bullish' : 'bearish'} (line ${h1.macd} vs ${h1.signal})`,
        `15m MACD ${m15Bull ? 'bullish' : 'bearish'} aligned with 1H`,
    ];
    const entryCrossUp = Boolean(m15.crossUp);
    const entryCrossDown = Boolean(m15.crossDown);
    reasons.push(`15m MACD entry cross (${entryCrossUp ? 'up' : entryCrossDown ? 'down' : 'none'})`);

    const adxV = tech.adx;
    if (adxV != null && adxV < opts.minAdx) return null;

    const { rsi: rsiV, ema9, spot } = tech;
    let side;
    if (h1Bull && m15Bull && entryCrossUp) {
        side = 'CE';
        if (rsiV != null && rsiV < 50) return null;
        if (ema9 != null && spot != null && spot < ema9) return null;
        if (h1.aboveZero) reasons.push('1H MACD above zero -- strong uptrend');
    } else if (h1Bear && m15Bear && entryCrossDown) {
        side = 'PE';
        if (rsiV != null && rsiV > 50) return null;
        if (ema9 != null && spot != null && spot > ema9) return null;
        if (h1.belowZero) reasons.push('1H MACD below zero -- strong downtrend');
    } else {
        return null;
    }

    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    if (side === 'CE' && pcr < 0.75) return null;
    if (side === 'PE' && pcr > 1.25) return null;
    reasons.push(`PCR ${pcr.toFixed(2)} not fighting ${side} direction`);

    return {
        key: STRATEGY_KEYS.MACD_MTF,
        side,
        strength: 'STRONG',
        layers: '2/3 MACD',
        reasons,
    };
}

// ─────────────────────────── STRATEGY 5: Mean Reversion ───────────────────────────

export function checkMeanRev(tech, chain, opts) {
    const { spot, adx: adxV, rsi: rsiV, vwap, bb } = tech;
    if (spot == null || adxV == null || rsiV == null || !bb) return null;
    if (adxV >= 20) return null;

    const bbRange = bb.upper - bb.lower;
    if (!(bbRange > 0)) return null;

    const pcr = Number(chain?.pcr) != null ? Number(chain.pcr) : 1;
    const reasons = [`ADX ${adxV.toFixed(0)} (sideways market)`];

    const lowerZone = (spot - bb.lower) / bbRange;
    const upperZone = (bb.upper - spot) / bbRange;
    let side;
    if (lowerZone < 0.15 && rsiV < 35) {
        side = 'CE';
        if (vwap != null && spot > vwap) return null;
        reasons.push(`Price near lower BB ${bb.lower.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} oversold -- bounce expected`);
        if (vwap != null) reasons.push(`Below VWAP ${vwap.toFixed(0)} -- snap-back target`);
        if (pcr > 1.1) reasons.push(`PCR ${pcr.toFixed(2)} supports bounce (PE heavy)`);
        else if (pcr < 0.8) return null;
    } else if (upperZone < 0.15 && rsiV > 65) {
        side = 'PE';
        if (vwap != null && spot < vwap) return null;
        reasons.push(`Price near upper BB ${bb.upper.toFixed(0)}`);
        reasons.push(`RSI ${rsiV.toFixed(0)} overbought -- pullback expected`);
        if (vwap != null) reasons.push(`Above VWAP ${vwap.toFixed(0)} -- fade target`);
        if (pcr < 0.9) reasons.push(`PCR ${pcr.toFixed(2)} supports pullback (CE heavy)`);
        else if (pcr > 1.2) return null;
    } else {
        return null;
    }

    return {
        key: STRATEGY_KEYS.MEAN_REV,
        side,
        strength: 'MODERATE',
        layers: 'BB+RSI+ADX',
        reasons,
        sideways: true,
    };
}

/**
 * Reduced quality score — the subset of tgbot2's `_passes_auto_alert_quality`
 * that this codebase's data can support (no leg volume / bid-ask spread / VIX).
 * Feeds the confidence number; never gates the entry here.
 */
export function qualityScore(result, tech, chain) {
    let score = 0;
    const { key, side } = result;
    const { adx: adxV, ema9, ema21, spot, rsi: rsiV } = tech;
    const trendStrategies = [STRATEGY_KEYS.CONFLUENCE, STRATEGY_KEYS.ORB, STRATEGY_KEYS.MACD_MTF].includes(key);

    if (adxV != null) {
        if (key === STRATEGY_KEYS.MEAN_REV) {
            if (adxV < 15) score += 20;
            else score += 10;
        } else if (adxV >= 25) { score += 20; }
        else if (adxV >= 20) { score += 10; }
    }

    if (trendStrategies && ema9 != null && ema21 != null && spot != null) {
        const aligned = (side === 'CE' && ema9 > ema21 && spot > ema9) ||
            (side === 'PE' && ema9 < ema21 && spot < ema9);
        if (aligned) score += 15;
    }

    if (trendStrategies && rsiV != null) {
        if ((side === 'CE' && rsiV >= 55 && rsiV <= 70) || (side === 'PE' && rsiV >= 30 && rsiV <= 45)) {
            score += 10;
        }
    }

    if (key === STRATEGY_KEYS.CONFLUENCE) {
        const n = parseInt(String(result.layers || '0/4').split('/')[0], 10) || 0;
        if (n >= 4) score += 25;
        else if (n >= 3) score += 12;
    }

    if (key === STRATEGY_KEYS.ORB && result.orbBreakPct != null) {
        if (result.orbBreakPct >= 0.2) score += 15;
    }

    if (key === STRATEGY_KEYS.PCR_REVERSAL) {
        const p = Number(result.pcr);
        if (Number.isFinite(p) && (p >= 1.5 || p <= 0.5)) score += 20;
    }

    return score + 10;
}

/** Win-confidence estimate, ported from tgbot2's `_confidence_pct`. */
export function strategyConfidence(key, score) {
    const base = STRATEGY_META[key]?.baseWin ?? 60;
    const adj = (Number(score) - 55) * 0.4;
    const pct = Math.max(40, Math.min(92, Math.round(base + adj)));
    const label = pct >= 75 ? 'high' : pct >= 62 ? 'medium' : 'low';
    return { pct, label };
}

/**
 * Run all five strategies on the current read. Returns an ordered list of
 * setups (highest quality first) plus context about why nothing fired when
 * empty.
 *
 * @param {object} d
 * @param {object|null} d.chain chain snapshot
 * @param {object|null} d.quote quote result
 * @param {{min:number,high:number,low:number,close:number,volume:number}[]} d.today5m
 * @param {{min:number,high:number,low:number,close:number,volume:number}[]} d.full5m
 * @param {object|null} d.hourly 1h bars or null
 * @param {number} [d.nowMin] IST minute-of-day (defaults to now)
 * @param {object} [d.opts] overrides for DEFAULTS
 */
export function evaluateStrategies({ chain, quote, today5m = [], full5m = [], hourly = null, nowMin = null, opts = {} } = {}) {
    const o = { ...DEFAULTS, ...opts };
    const now = nowMin != null ? nowMin : istMinuteOfDay();
    const tech = buildTech({ today5m, full5m, hourly, chain, quote });

    // Clock gates — honest dead-ends instead of a stale read.
    if (now >= o.lastEntryMin) {
        return { list: [], winner: null, evaluated: false, noneReason: `past last entry time (${Math.floor(o.lastEntryMin / 60)}:00 IST)` };
    }
    if (tech.lastBarMin != null && now - tech.lastBarMin > 45) {
        return { list: [], winner: null, evaluated: false, noneReason: 'no fresh session bars — market closed or feed stale' };
    }
    if (tech.spot == null) {
        return { list: [], winner: null, evaluated: false, noneReason: 'no spot price from the option chain' };
    }

    const checks = [
        (t) => checkConfluence(t, chain, o),
        (t) => checkOrb(t, chain, o, now),
        (t) => checkPcrExtreme(t, chain, o),
        (t) => checkMacdMtf(t, chain, o),
        (t) => checkMeanRev(t, chain, o),
    ];

    const list = [];
    for (const fn of checks) {
        let r = null;
        try { r = fn(tech, chain, o, now); } catch { r = null; }
        if (!r) continue;
        const meta = STRATEGY_META[r.key] || {};
        const score = qualityScore(r, tech, chain);
        const conf = strategyConfidence(r.key, score);
        list.push({
            ...r,
            name: meta.name || r.key,
            winRateTag: meta.tag || '',
            score,
            confidence: conf.pct,
            confidenceLabel: conf.label,
            atr15: tech.atr15,
        });
    }

    list.sort((a, b) => (b.score - a.score) || (STRATEGY_META[b.key]?.rank || 0) - (STRATEGY_META[a.key]?.rank || 0));
    const winner = list[0] || null;
    const noneReason = list.length
        ? null
        : `no strategy fired — confluence <${o.minLayers} layers, no ORB break, PCR ${chain?.pcr != null ? Number(chain.pcr).toFixed(2) : 'n/a'} mid-band, no MACD cross, not at a Bollinger edge`;
    return { list, winner, evaluated: true, noneReason };
}
