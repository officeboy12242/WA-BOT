/**
 * ScalpBacktestService — 1-year backtest for /scalp strategies
 *
 * Simulates realistic intraday price paths from daily OHLC data.
 * Uses Black-Scholes for option pricing at each bar.
 * Tests 5 scalp strategies with 2 trades/day, 8pt target, 5pt stop.
 *
 * Key: builds intraday 5-min bars from daily OHLC using a random
 * path that respects high/low/close constraints, preventing the
 * unrealistic single-tick stops that plague naive simulators.
 */

import { logger } from '../utils/logger.js';
import { fetchYahooDailyCandles } from '../utils/yahooDailyCandles.js';
import { F_AND_O_INDICES } from '../data/indexUniverse.js';

// ─── CONSTANTS ───────────────────────────────────────────────────
const LOT_SIZE = 75;
const CAPITAL = 30000;
const TARGET_PTS = 8;
const STOP_PTS = 5;
const SLIPPAGE_PTS = 0.5;
const TOTAL_FEES = 42;       // round-trip brokerage + taxes
const MAX_TRADES = 2;
const MIN_CONF = 60;
const RISK_FREE = 0.065;
const TRADING_HOURS = 75;    // 9:15–15:30 = 75 × 5-min bars
const MINUTES_PER_BAR = 5;

// ─── NORMAL CDF (Abramowitz & Stegun approx) ────────────────────

function normcdf(x) {
    const s = x >= 0 ? 1 : -1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.2316419 * ax);
    const p = 0.319381530 * t - 0.356563782 * t * t + 1.781477937 * t ** 3
            - 1.821255978 * t ** 4 + 1.330274429 * t ** 5;
    return 0.5 * (1 + s * (1 - p * Math.exp(-ax * ax / 2)));
}

// ─── BLACK-SCHOLES ──────────────────────────────────────────────

function bsPrice(S, K, T, r, sigma) {
    if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return Math.max(0, S - K);
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    // For ATM options, call ≈ put by put-call parity
    const call = S * normcdf(d1) - K * Math.exp(-r * T) * normcdf(d2);
    return Math.max(0.01, call);
}

// ─── INTRADAY PATH SIMULATION ───────────────────────────────────
// Generates realistic 5-min bars from a daily OHLC candle.
// Uses Brownian bridge: anchor at open and close, random walk constrained
// to stay within the daily high/low range.

function buildIntradayPath(open, high, low, close, numBars) {
    const path = [];
    // Start at open, end at close
    // Use a simple approach: interpolate between open and close
    // with random noise that stays within high/low

    const totalBars = numBars || TRADING_HOURS;
    const range = high - low;

    // Create a mean-reverting path from open to close
    let current = open;
    for (let i = 0; i < totalBars; i++) {
        const t = i / totalBars; // 0 to 1 progress
        const drift = (close - open) / totalBars; // linear drift from open to close

        // Random walk with mean reversion toward the linear path
        const noise = (Math.random() - 0.5) * range * 0.15; // 15% of daily range
        const reversion = (open + (close - open) * t - current) * 0.3; // mean reversion

        current = current + drift + noise + reversion;

        // Clamp to daily range
        current = Math.max(low + range * 0.05, Math.min(high - range * 0.05, current));

        // Calculate bar OHLC (simulated 5-min bar within the daily range)
        const barRange = range / totalBars * (0.5 + Math.random() * 0.5);
        const barHigh = current + Math.random() * barRange * 0.5;
        const barLow = current - Math.random() * barRange * 0.5;
        const barClose = current + (Math.random() - 0.5) * barRange * 0.3;

        path.push({
            open: current,
            high: Math.max(current, barHigh),
            low: Math.min(current, barLow),
            close: barClose,
            volume: 1000 + Math.floor(Math.random() * 5000),
        });
    }

    // Ensure last bar closes at daily close
    path[path.length - 1].close = close;
    path[path.length - 1].high = Math.max(path[path.length - 1].high, close);
    path[path.length - 1].low = Math.min(path[path.length - 1].low, close);

    return path;
}

// ─── OPTION CHAIN SIMULATION ────────────────────────────────────

function simulateChain(spot, iv) {
    const atm = Math.round(spot / 50) * 50;
    const strikes = [];
    for (let k = atm - 500; k <= atm + 500; k += 50) {
        const T = 1 / 365; // ~1 day
        const ceLtp = bsPrice(spot, k, T, RISK_FREE, iv);
        const peLtp = bsPrice(spot, 2 * atm - k, T, RISK_FREE, iv); // put-call parity
        const dist = Math.abs(k - atm);
        const oi = Math.max(10000, 200000 - dist * 200 + Math.round(Math.random() * 50000));
        strikes.push({
            strike: k,
            ce: { ltp: ceLtp, oi, iv: iv * 100 },
            pe: { ltp: peLtp, oi: Math.round(oi * 0.8), iv: iv * 100 },
        });
    }
    return {
        spot, atmStrike: atm,
        atmCe: strikes.find(s => s.strike === atm)?.ce,
        atmPe: strikes.find(s => s.strike === atm)?.pe,
        strikes,
        pcr: strikes.reduce((s, r) => s + (r.pe?.oi || 0), 0) /
             Math.max(1, strikes.reduce((s, r) => s + (r.ce?.oi || 0), 1)),
    };
}

// ─── STRATEGY EVALUATORS ────────────────────────────────────────

function findBestStrike(strikes, target, side, spot, atm) {
    const cands = strikes.filter(s => Math.abs(s.strike - target) <= 150)
        .filter(s => { const l = side === 'CE' ? s.ce : s.pe; return l?.ltp >= 1; });
    if (!cands.length) return null;
    let best = null;
    for (const s of cands) {
        const l = side === 'CE' ? s.ce : s.pe;
        const iv = l.iv || 10;
        const d = Math.abs(s.strike - atm);
        const sc = Math.min(40, iv * 2) + Math.min(30, (l.oi || 0) / 10000) + Math.max(0, 30 - d / 5);
        if (!best || sc > best.sc) best = { strike: s.strike, sc, ltp: l.ltp };
    }
    return best;
}

function evalBuyCE(chain, spot, support, resistance) {
    const range = resistance - support;
    if (range < 30 || spot - support >= range * 0.5) return null;
    const best = findBestStrike(chain.strikes, support, 'CE', spot, chain.atmStrike);
    if (!best) return null;
    const target = best.ltp + TARGET_PTS;
    const stop = best.ltp - STOP_PTS;
    const nearness = 1 - (spot - support) / range;
    const conf = Math.round(50 + nearness * 35 + Math.random() * 5);
    return { strategy: 'buy_ce', side: 'CE', strike: best.strike, entry: best.ltp, target, stop, conf };
}

function evalBuyPE(chain, spot, support, resistance) {
    const range = resistance - support;
    if (range < 30 || resistance - spot >= range * 0.5) return null;
    const best = findBestStrike(chain.strikes, resistance, 'PE', spot, chain.atmStrike);
    if (!best) return null;
    const target = best.ltp + TARGET_PTS;
    const stop = best.ltp - STOP_PTS;
    const nearness = 1 - (resistance - spot) / range;
    const conf = Math.round(50 + nearness * 35 + Math.random() * 5);
    return { strategy: 'buy_pe', side: 'PE', strike: best.strike, entry: best.ltp, target, stop, conf };
}

// Short Straddle & Strangle REMOVED: backtested 47%/38% WR, both lose money

function evalBreakout(chain, spot, support, resistance) {
    const bull = spot > resistance + 5;
    const bear = spot < support - 5;
    if (!bull && !bear) return null;
    const side = bull ? 'CE' : 'PE';
    const leg = chain.strikes.find(s => s.strike === chain.atmStrike)?.[side.toLowerCase()];
    if (!leg || leg.ltp < 5) return null;
    const conf = Math.round(60 + Math.random() * 15);
    return { strategy: 'breakout', side, strike: chain.atmStrike,
             entry: leg.ltp, target: leg.ltp + TARGET_PTS, stop: leg.ltp - STOP_PTS, conf };
}

// ─── REGIME ──────────────────────────────────────────────────────

function regime(spot, hist) {
    if (!hist || hist.length < 20) return 'normal';
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    const trend = (spot - hist[0]) / hist[0] * 100;
    const vol = Math.sqrt(hist.reduce((s, p) => s + (p - avg) ** 2, 0) / hist.length);
    if (Math.abs(trend) > 1.5) return 'trending';
    if (vol < avg * 0.005) return 'low_vol';
    return 'normal';
}

// ─── MAIN ────────────────────────────────────────────────────────

export default class ScalpBacktestService {
    constructor() {}

    async runBacktest(days = 252) {
        logger.info(`ScalpBacktest: Fetching ~${days} days...`);
        const { candles } = await fetchYahooDailyCandles(
            F_AND_O_INDICES.NIFTY.yahoo, { range: `${Math.ceil(days / 22) + 1}mo` }
        );
        if (!candles || candles.length < 30) throw new Error('Insufficient data');
        logger.info(`ScalpBacktest: ${candles.length} daily bars`);

        let capital = CAPITAL, peak = CAPITAL, maxDD = 0;
        const trades = [], daily = [];
        const window = [];

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const spot = c.close;
            window.push(spot);
            if (window.length > 60) window.shift();
            if (i < 20) continue;

            // Realized vol for IV
            const rets = [];
            for (let j = 1; j < window.length; j++) rets.push(Math.abs(window[j] / window[j - 1] - 1));
            const rVol = rets.length > 0 ? (rets.reduce((a, b) => a + b, 0) / rets.length) * Math.sqrt(252) : 0.15;
            const iv = Math.max(0.08, Math.min(0.35, rVol));

            const chain = simulateChain(spot, iv);
            const sortedCe = chain.strikes.filter(s => s.strike > spot).sort((a, b) => (b.ce?.oi || 0) - (a.ce?.oi || 0));
            const sortedPe = chain.strikes.filter(s => s.strike < spot).sort((a, b) => (b.pe?.oi || 0) - (a.pe?.oi || 0));
            const topCe = sortedCe[0] || null;
            const topPe = sortedPe[0] || null;
            const resistance = topCe?.strike || Math.round(spot / 50) * 50 + 100;
            const support = topPe?.strike || Math.round(spot / 50) * 50 - 100;
            const reg = regime(spot, window);

            // Evaluate strategies
            const sigs = [];
            const ce = evalBuyCE(chain, spot, support, resistance);
            if (ce && ce.conf >= MIN_CONF) sigs.push(ce);
            const pe = evalBuyPE(chain, spot, support, resistance);
            if (pe && pe.conf >= MIN_CONF) sigs.push(pe);
            // Straddle removed per backtest results
            // Strangle removed - 38% WR was dragging performance down
            const breakout = evalBreakout(chain, spot, support, resistance);
            if (breakout && breakout.conf >= MIN_CONF) sigs.push(breakout);

            sigs.sort((a, b) => b.conf - a.conf);
            const taken = sigs.slice(0, MAX_TRADES);

            // Generate intraday path from daily OHLC
            const intraday = buildIntradayPath(c.open, c.high, c.low, c.close, TRADING_HOURS);

            let pnlToday = 0;
            for (const sig of taken) {
                // Margin check
                if (sig.entry * LOT_SIZE * 2 > capital * 0.9) continue;

                let closed = false;
                const isShort = sig.side === 'STRADDLE' || sig.side === 'STRANGLE';

                // Simulate intraday trading: try up to 15 bars (75 min)
                for (let b = 1; b <= Math.min(15, intraday.length); b++) {
                    const bar = intraday[b];
                    // Calculate option price at this bar
                    let optionPrice;
                    if (isShort) {
                        const ce = bsPrice(bar.close, chain.atmStrike, 1 / 365, RISK_FREE, iv);
                        const pe = bsPrice(bar.close, 2 * chain.atmStrike - chain.atmStrike, 1 / 365, RISK_FREE, iv);
                        optionPrice = ce + pe;
                    } else {
                        const isCE = sig.side === 'CE';
                        const K = sig.strike;
                        optionPrice = bsPrice(bar.close, K, 1 / 365, RISK_FREE, iv);
                    }

                    // Check target/stop
                    if (isShort) {
                        if (optionPrice <= sig.target) {
                            const pnl = (sig.entry - sig.target) * LOT_SIZE - TOTAL_FEES - SLIPPAGE_PTS * LOT_SIZE * 2;
                            pnlToday += Math.round(pnl);
                            trades.push({ strategy: sig.strategy, side: sig.side, entry: sig.entry,
                                exit: sig.target, pnl: Math.round(pnl), exitReason: 'target_hit', date: istDate(c.ts) });
                            closed = true;
                            break;
                        }
                        if (optionPrice >= sig.stop) {
                            const pnl = (sig.entry - sig.stop) * LOT_SIZE - TOTAL_FEES - SLIPPAGE_PTS * LOT_SIZE * 2;
                            pnlToday += Math.round(pnl);
                            trades.push({ strategy: sig.strategy, side: sig.side, entry: sig.entry,
                                exit: sig.stop, pnl: Math.round(pnl), exitReason: 'stop_loss', date: istDate(c.ts) });
                            closed = true;
                            break;
                        }
                    } else {
                        if (optionPrice >= sig.target) {
                            const pnl = (sig.target - sig.entry) * LOT_SIZE - TOTAL_FEES - SLIPPAGE_PTS * LOT_SIZE * 2;
                            pnlToday += Math.round(pnl);
                            trades.push({ strategy: sig.strategy, side: sig.side, entry: sig.entry,
                                exit: sig.target, pnl: Math.round(pnl), exitReason: 'target_hit', date: istDate(c.ts) });
                            closed = true;
                            break;
                        }
                        if (optionPrice <= sig.stop) {
                            const pnl = (sig.stop - sig.entry) * LOT_SIZE - TOTAL_FEES - SLIPPAGE_PTS * LOT_SIZE * 2;
                            pnlToday += Math.round(pnl);
                            trades.push({ strategy: sig.strategy, side: sig.side, entry: sig.entry,
                                exit: sig.stop, pnl: Math.round(pnl), exitReason: 'stop_loss', date: istDate(c.ts) });
                            closed = true;
                            break;
                        }
                    }
                }

                if (!closed) {
                    // Time exit at last bar
                    const lastBar = intraday[intraday.length - 1];
                    let exitPrem;
                    if (isShort) {
                        const ce = bsPrice(lastBar.close, chain.atmStrike, 1 / 365, RISK_FREE, iv);
                        const pe = bsPrice(lastBar.close, chain.atmStrike, 1 / 365, RISK_FREE, iv);
                        exitPrem = ce + pe;
                    } else {
                        exitPrem = bsPrice(lastBar.close, sig.strike, 1 / 365, RISK_FREE, iv);
                    }
                    const pnlPoints = isShort ? (sig.entry - exitPrem) : (exitPrem - sig.entry);
                    const pnl = pnlPoints * LOT_SIZE - TOTAL_FEES - SLIPPAGE_PTS * LOT_SIZE * 2;
                    pnlToday += Math.round(pnl);
                    trades.push({ strategy: sig.strategy, side: sig.side, entry: sig.entry,
                        exit: exitPrem, pnl: Math.round(pnl), exitReason: 'time_exit', date: istDate(c.ts) });
                }

                capital += trades[trades.length - 1]?.pnl || 0;
                if (capital > peak) peak = capital;
                const dd = peak - capital;
                if (dd > maxDD) maxDD = dd;
            }

            daily.push({ date: istDate(c.ts), pnl: pnlToday, trades: taken.length, capital: Math.round(capital) });
        }

        return this._stats(trades, daily, capital, maxDD, peak);
    }

    _stats(trades, daily, final, maxDD, peak) {
        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const n = trades.length;
        const wr = n > 0 ? (wins.length / n) * 100 : 0;
        const avgW = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
        const avgL = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
        const pf = avgL > 0 ? avgW / avgL : 0;
        const pnl = trades.reduce((s, t) => s + t.pnl, 0);
        const ret = ((final - CAPITAL) / CAPITAL) * 100;
        const profDays = daily.filter(d => d.pnl > 0).length;
        const lossDays = daily.filter(d => d.pnl < 0).length;
        const avgDaily = daily.length > 0 ? daily.reduce((s, d) => s + d.pnl, 0) / daily.length : 0;
        const best = daily.length > 0 ? Math.max(...daily.map(d => d.pnl)) : 0;
        const worst = daily.length > 0 ? Math.min(...daily.map(d => d.pnl)) : 0;

        let sharpe = null;
        if (daily.length > 2) {
            const r = daily.map(d => d.pnl / CAPITAL);
            const m = r.reduce((a, b) => a + b, 0) / r.length;
            const s = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length);
            if (s > 0) sharpe = Number(((m / s) * Math.sqrt(252)).toFixed(2));
        }

        const byStrat = {};
        for (const t of trades) {
            if (!byStrat[t.strategy]) byStrat[t.strategy] = { trades: 0, wins: 0, pnl: 0 };
            byStrat[t.strategy].trades++;
            if (t.pnl > 0) byStrat[t.strategy].wins++;
            byStrat[t.strategy].pnl += t.pnl;
        }
        for (const s of Object.values(byStrat)) s.winRate = s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0;

        const byExit = {};
        for (const t of trades) { const r = t.exitReason || '?'; byExit[r] = (byExit[r] || 0) + 1; }

        return {
            capital: CAPITAL, final: Math.round(final), pnl: Math.round(pnl),
            ret: Number(ret.toFixed(1)), maxDD: Math.round(maxDD), maxDDPct: Number(((maxDD / Math.max(1, peak)) * 100).toFixed(1)),
            total: n, winRate: Number(wr.toFixed(1)), avgWin: Math.round(avgW), avgLoss: Math.round(avgL),
            pf: Number(pf.toFixed(2)), sharpe,
            days: daily.length, profDays, lossDays, avgDaily: Math.round(avgDaily),
            best: Math.round(best), worst: Math.round(worst),
            byStrat, byExit, trades: trades.slice(-10), daily,
        };
    }

    formatResults(s) {
        const SL = { buy_ce: '🟢 Buy CE', buy_pe: '🔴 Buy PE', short_straddle: '⚡ Straddle', short_strangle: '🩹 Strangle', breakout: '🚀 Breakout' };
        const EL = { stop_loss: '🛑 Stop', target_hit: '🎯 Target', time_exit: '⏰ Time' };
        const L = [
            '╔════════════════════════════════════════╗',
            '║  🧪 *SCALP BACKTEST · 1 YEAR*          ║',
            '╚════════════════════════════════════════╝', '',
            `📅 ${s.days} trading days · ₹${(s.capital / 1000).toFixed(0)}K capital`,
            `📦 2 trades/day · ${TARGET_PTS}pt target · ${STOP_PTS}pt stop`, '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '💰 *PERFORMANCE*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '',
            `📈 Total P&L: ${s.pnl >= 0 ? '+' : ''}${inr(s.pnl)}`,
            `📊 Net Return: ${s.ret >= 0 ? '+' : ''}${s.ret}%`,
            `📉 Max Drawdown: ${inr(s.maxDD)} (${s.maxDDPct}%)`,
            s.sharpe != null ? `📐 Sharpe: ${s.sharpe}` : '',
            `⚖️ Profit Factor: ${s.pf}`, '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '🎯 *TRADE STATS*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '',
            `🔢 Trades: ${s.total}`, `✅ Win Rate: ${s.winRate}%`,
            `💰 Avg Win: ${inr(s.avgWin)}`, `💸 Avg Loss: ${inr(s.avgLoss)}`, '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '📅 *DAILY*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '',
            `🟢 Win Days: ${s.profDays}/${s.days} · 🔴 Loss: ${s.lossDays}`,
            `📊 Avg: ${inr(s.avgDaily)} · 🏆 Best: ${inr(s.best)} · 💀 Worst: ${inr(s.worst)}`, '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '🧩 *BY STRATEGY*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '',
        ];
        for (const [k, v] of Object.entries(s.byStrat))
            L.push(`${SL[k] || k}: ${v.trades} trades · ${v.winRate}% WR · ${v.pnl >= 0 ? '+' : ''}${inr(v.pnl)}`);
        L.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '🚪 *EXITS*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        for (const [r, c] of Object.entries(s.byExit))
            L.push(`${EL[r] || r}: ${c} (${Math.round(c / s.total * 100)}%)`);
        L.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '📋 *LAST 10 TRADES*', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        for (const t of s.trades) {
            const e = t.pnl > 0 ? '✅' : '❌';
            const sn = SL[t.strategy]?.split(' ')[0] || '?';
            const sd = t.side === 'STRADDLE' ? 'ST' : t.side;
            L.push(`${e} ${t.date} ${sn} ${sd} ₹${t.entry.toFixed(0)}→${t.pnl >= 0 ? '+' : ''}${inr(t.pnl)}`);
        }
        L.push('', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `_${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}_`, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return L.join('\n');
    }
}

// Helper
function istDate(ts) { return new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 10); }
function inr(n) { return n == null ? '–' : `₹${Math.round(n).toLocaleString('en-IN')}`; }
