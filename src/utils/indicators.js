/**
 * Technical indicators ported to match pandas semantics exactly, because the
 * strategies they feed (IndexStrategyEngine) were written and backtested in a
 * pandas bot (tgbot2). pandas `ewm(span=n, adjust=False)` is the recursive EMA
 * `alpha = 2/(n+1)` seeded from the FIRST value — NOT an SMA-seeded EMA — so a
 * naive JS EMA diverges on the short series these strategies run on.
 */

/** pandas ewm(span=n, adjust=False) — recursive, seeded from values[0]. */
export function emaPandas(values, span) {
    const n = Math.max(1, Number(span) || 1);
    const k = 2 / (n + 1);
    const out = new Array(values.length);
    let ema = Number(values[0]);
    out[0] = Number.isFinite(ema) ? ema : null;
    for (let i = 1; i < values.length; i++) {
        const v = Number(values[i]);
        if (!Number.isFinite(v)) { out[i] = out[i - 1]; continue; }
        ema = v * k + (ema == null ? v : ema) * (1 - k);
        out[i] = ema;
    }
    return out;
}

/** pandas Series.diff().clip(lower=0).rolling(p).mean() over the last p deltas. */
export function smaGainLoss(closes, period) {
    let gain = 0, loss = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    return { avgGain: gain / period, avgLoss: loss / period };
}

/**
 * RSI exactly as tgbot2 computes it: simple (SMA) average of up/down deltas over
 * the window — not Wilder smoothing. All-losses window reads 100 (tgbot2 does
 * the same; a flat window is never "overbought").
 * @param {number[]} closes
 * @param {number} period
 * @returns {number|null}
 */
export function rsi(closes, period = 14) {
    if (!Array.isArray(closes) || closes.length < period + 1) return null;
    const { avgGain, avgLoss } = smaGainLoss(closes, period);
    if (!(avgLoss > 0)) return 100;
    const rs = avgGain / avgLoss;
    const v = 100 - 100 / (1 + rs);
    return Number.isFinite(v) ? v : null;
}

/**
 * MACD line / signal / histogram + bull-bear alignment and crossover detection,
 * mirroring tgbot2's `_macd_bar_state` (which requires >= 35 closes).
 * @param {number[]} closes
 * @param {{fast?:number, slow?:number, signal?:number, crossLookback?:number}} opts
 * @returns {object|null}
 */
export function macdState(closes, { fast = 12, slow = 26, signal = 9, crossLookback = 1 } = {}) {
    if (!Array.isArray(closes) || closes.length < 35) return null;
    const ef = emaPandas(closes, fast);
    const es = emaPandas(closes, slow);
    const macd = closes.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
    const sig = emaPandas(macd, signal);

    const m = macd[macd.length - 1];
    const s = sig[sig.length - 1];
    const pm = macd[macd.length - 2];
    const ps = sig[sig.length - 2];
    if (![m, s, pm, ps].every((x) => Number.isFinite(x))) return null;

    let crossUp = pm <= ps && m > s;
    let crossDown = pm >= ps && m < s;
    const lb = Math.max(1, crossLookback);
    for (let i = Math.max(1, macd.length - lb); i < macd.length; i++) {
        const mi = macd[i], si = sig[i], pmi = macd[i - 1], psi = sig[i - 1];
        if (![mi, si, pmi, psi].every((x) => Number.isFinite(x))) continue;
        if (pmi <= psi && mi > si) crossUp = true;
        if (pmi >= psi && mi < si) crossDown = true;
    }

    return {
        bull: m > s,
        bear: m < s,
        aboveZero: m > 0,
        belowZero: m < 0,
        crossUp,
        crossDown,
        macd: Number(m.toFixed(4)),
        signal: Number(s.toFixed(4)),
    };
}

/**
 * Average Directional Index — port of tgbot2's `_adx` (EMA-smoothed, Wilder
 * style with alpha 2/(n+1)).
 * @param {{high:number[], low:number[], close:number[]}} ohlc
 * @param {number} period
 * @returns {number|null}
 */
export function adx(ohlc, period = 14) {
    const { high, low, close } = ohlc;
    if (!Array.isArray(high) || high.length < period + 2) return null;
    const n = high.length;
    const tr = [], plusDm = [], minusDm = [];
    for (let i = 1; i < n; i++) {
        const h = high[i], l = low[i], pc = close[i - 1];
        if (![h, l, pc, high[i - 1], low[i - 1]].every((x) => Number.isFinite(x))) continue;
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        const up = h - high[i - 1];
        const dn = low[i - 1] - l;
        plusDm.push(up > dn && up > 0 ? up : 0);
        minusDm.push(dn > up && dn > 0 ? dn : 0);
    }
    if (tr.length < period + 1) return null;

    const atrArr = emaPandas(tr, period);
    const plusE = emaPandas(plusDm, period);
    const minusE = emaPandas(minusDm, period);
    const last = atrArr.length - 1;
    const atrV = atrArr[last];
    if (!(atrV > 0)) return null;
    const pdi = 100 * (plusE[last] / atrV);
    const mdi = 100 * (minusE[last] / atrV);
    const denom = pdi + mdi;
    if (!(denom > 0)) return null;
    const dx = 100 * Math.abs(pdi - mdi) / denom;
    return Number.isFinite(dx) ? dx : null;
}

/**
 * Bollinger Bands — SMA(20) ± 2·std (population std, ddof=0, like pandas).
 * @param {number[]} closes
 * @param {number} period
 * @param {number} mult
 * @returns {{upper:number, middle:number, lower:number}|null}
 */
export function bollinger(closes, period = 20, mult = 2) {
    if (!Array.isArray(closes) || closes.length < period) return null;
    const win = closes.slice(-period);
    if (!win.every((x) => Number.isFinite(x))) return null;
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    return {
        upper: mean + mult * sd,
        middle: mean,
        lower: mean - mult * sd,
    };
}

/** Last value of an EMA series (null-safe). */
export function lastFinite(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (Number.isFinite(arr[i])) return arr[i];
    }
    return null;
}
