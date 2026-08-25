/**
 * ScalpService — /scalp command
 *
 * Fetches live NSE option chain for NIFTY, calculates:
 * - Scalp range (support/resistance from OI walls)
 * - Live premiums (ATM CE/PE)
 * - Confidence scores per setup
 * - Regime detection (normal / low VIX / trending)
 * - Visual scalp map card
 */

import { nseOptionChainService, findStrikeLeg } from './NseOptionChainService.js';
import { maxPain } from '../utils/blackScholes.js';
import { logger } from '../utils/logger.js';

// ── Regime thresholds ──────────────────────────────────────────────────────

const LOW_VIX_THRESHOLD = 12;
const HIGH_VIX_THRESHOLD = 18;
const TIGHT_RANGE_PTS = 100;
const WIDE_RANGE_PTS = 250;

// ── Confidence weights ─────────────────────────────────────────────────────

const CONF_WEIGHTS = {
    oiWall: 0.30,
    pcr: 0.20,
    vix: 0.20,
    distance: 0.15,
    timeOfDay: 0.15,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function istTime(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
        hourCycle: 'h23',
    }).formatToParts(date);
    let h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    if (h === 24) h = 0;
    const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return { hour: h, minute: m };
}

function istDateLabel(date = new Date()) {
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
    }).format(date);
}

function round5(n) {
    return Math.round(n / 5) * 5;
}

function confBar(pct) {
    const filled = Math.round(pct / 10);
    const empty = 10 - filled;
    return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function confLabel(pct) {
    if (pct >= 70) return '\u2705\u2705';
    if (pct >= 55) return '\u2705';
    if (pct >= 40) return '\u26A0\uFE0F';
    return '\u274C';
}

// ── Confidence calculation ─────────────────────────────────────────────────

function calcConfidence({ oiWallQty, totalOi, pcr, vix, spotDistance, regime }) {
    const oiScore = Math.min(100, (oiWallQty / 80) * 100);
    const pcrScore = Math.min(100, Math.abs(pcr - 1) * 200 + 50);
    const vixScore = regime === 'theta'
        ? Math.max(0, 100 - (vix - LOW_VIX_THRESHOLD) * 5)
        : Math.min(100, (vix - 10) * 8);
    const distScore = Math.max(0, 100 - spotDistance * 0.5);

    const { hour, minute } = istTime();
    const timeDecimal = hour + minute / 60;
    let timeScore = 50;
    if (timeDecimal >= 10.5 && timeDecimal <= 12.5) timeScore = 90;
    else if (timeDecimal >= 9.5 && timeDecimal < 10.5) timeScore = 60;
    else if (timeDecimal > 12.5 && timeDecimal <= 14.5) timeScore = 70;
    else timeScore = 30;

    const raw =
        oiScore * CONF_WEIGHTS.oiWall +
        pcrScore * CONF_WEIGHTS.pcr +
        vixScore * CONF_WEIGHTS.vix +
        distScore * CONF_WEIGHTS.distance +
        timeScore * CONF_WEIGHTS.timeOfDay;

    return Math.round(Math.max(20, Math.min(90, raw)));
}

// ── Regime detection ───────────────────────────────────────────────────────

function detectRegime({ spot, maxPainVal, rangeWidth, vix, pcr }) {
    if (vix < LOW_VIX_THRESHOLD && rangeWidth < TIGHT_RANGE_PTS) return 'low_vol';
    if (vix > HIGH_VIX_THRESHOLD || rangeWidth > WIDE_RANGE_PTS) return 'trending';
    const spotVsMp = spot != null && maxPainVal != null ? Math.abs(spot - maxPainVal) : 0;
    if (spotVsMp > 100) return 'trending';
    return 'normal';
}

// ── Main function ──────────────────────────────────────────────────────────

class ScalpService {
    constructor() {
        this.nse = nseOptionChainService;
    }

    async buildScalpCard(symbol = 'NIFTY') {
        const ctx = await this.nse.fetchOptionContext(symbol);
        if (!ctx?.snapshot) {
            return '\u26A0\uFE0F Could not fetch NSE option chain. Market may be closed or NSE is unreachable.';
        }

        const snap = ctx.snapshot;
        const spot = Number(snap.spot);
        const pcr = snap.pcr;
        const strikes = snap.strikes || [];
        const atmStrike = snap.atmStrike;
        const atmCe = snap.atmCe;
        const atmPe = snap.atmPe;

        if (!spot || !strikes.length) {
            return '\u26A0\uFE0F Incomplete option chain data \u2014 cannot build scalp card.';
        }

        // Near-spot strike universe (+-600 pts)
        const nearStrikes = strikes.filter(
            (s) => Math.abs(Number(s.strike) - spot) <= 600
        );
        const chain = nearStrikes.length >= 5 ? nearStrikes : strikes;

        // Max pain
        const mpRows = chain
            .filter((s) => s.ce && s.pe)
            .map((s) => ({
                strike: s.strike,
                CE: { openInterest: s.ce.oi || 0 },
                PE: { openInterest: s.pe.oi || 0 },
            }));
        const mpVal = maxPain(mpRows);

        // OI walls
        const sortedByCe = [...chain].filter((s) => s.ce?.oi).sort((a, b) => b.ce.oi - a.ce.oi);
        const sortedByPe = [...chain].filter((s) => s.pe?.oi).sort((a, b) => b.pe.oi - a.pe.oi);

        const topCeWall = sortedByCe[0];
        const topPeWall = sortedByPe[0];

        const resistance = topCeWall?.strike || round5(spot + 100);
        const support = topPeWall?.strike || round5(spot - 100);
        const rangeWidth = resistance - support;

        const spotPct = rangeWidth > 0
            ? Math.round(((spot - support) / rangeWidth) * 100)
            : 50;

        const regime = detectRegime({
            spot, maxPainVal: mpVal, rangeWidth, vix: 13, pcr: pcr || 1,
        });

        // ── Build 5 setups (target +5 / stop -5) ─────────────────────
        const setups = [];

        // 1) Support bounce — Buy CE
        if (spot - support < rangeWidth * 0.4) {
            const ceNearSupport = findStrikeLeg({ strikes }, support, 'CE');
            const entryPrem = ceNearSupport?.ltp || (atmCe?.ltp ? atmCe.ltp - 20 : null);
            if (entryPrem) {
                const target = entryPrem + 5;
                const stop = entryPrem - 5;
                const conf = calcConfidence({
                    oiWallQty: topPeWall?.pe?.oi || 0,
                    totalOi: snap.totalPeOi || 0, pcr: pcr || 1, vix: 13,
                    spotDistance: spot - support, regime: 'directional',
                });
                setups.push({
                    type: 'BUY CE', emoji: '\uD83D\uDFE2',
                    rank: 'primary',
                    strike: atmStrike,
                    optionType: 'CE',
                    trigger: `Spot touches ${support}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `PE OI wall ${formatOi(topPeWall?.pe?.oi)} at ${support}`,
                    topPick: conf >= 65,
                });
            }
        }

        // 2) Resistance rejection — Buy PE
        if (resistance - spot < rangeWidth * 0.4) {
            const peNearResistance = findStrikeLeg({ strikes }, resistance, 'PE');
            const entryPrem = peNearResistance?.ltp || (atmPe?.ltp ? atmPe.ltp - 20 : null);
            if (entryPrem) {
                const target = entryPrem + 5;
                const stop = entryPrem - 5;
                const conf = calcConfidence({
                    oiWallQty: topCeWall?.ce?.oi || 0,
                    totalOi: snap.totalCeOi || 0, pcr: pcr || 1, vix: 13,
                    spotDistance: resistance - spot, regime: 'directional',
                });
                setups.push({
                    type: 'BUY PE', emoji: '\uD83D\uDD34',
                    rank: 'primary',
                    strike: atmStrike,
                    optionType: 'PE',
                    trigger: `Spot touches ${resistance}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `CE OI wall ${formatOi(topCeWall?.ce?.oi)} at ${resistance}`,
                    topPick: conf >= 65,
                });
            }
        }

        // 3) Short Straddle
        if (spotPct >= 30 && spotPct <= 70) {
            const straddle = (atmCe?.ltp || 0) + (atmPe?.ltp || 0);
            if (straddle > 50) {
                const target = straddle - 5;
                const stop = straddle + 6;
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                setups.push({
                    type: 'SHORT STRADDLE', emoji: '\u26A1',
                    rank: 'secondary',
                    trigger: `Spot mid-range (${spotPct}%)`,
                    entry: straddle, target, stop, speed: '5-15 min',
                    confidence: conf,
                    why: `ATM straddle \u20B9${straddle}, theta decay working`,
                    topPick: regime === 'low_vol' && conf >= 60,
                });
            }
        }

        // 4) Short Strangle
        if (spotPct >= 25 && spotPct <= 75 && rangeWidth >= TIGHT_RANGE_PTS) {
            const wingStep = Math.max(50, round5(rangeWidth / 4));
            const otmCeStrike = round5(atmStrike + wingStep);
            const otmPeStrike = round5(atmStrike - wingStep);
            const otmCe = findStrikeLeg({ strikes }, otmCeStrike, 'CE');
            const otmPe = findStrikeLeg({ strikes }, otmPeStrike, 'PE');
            const strangle = (otmCe?.ltp || 0) + (otmPe?.ltp || 0);
            if (strangle > 20) {
                const target = strangle - Math.max(3, Math.round(strangle * 0.15));
                const stop = strangle + Math.max(4, Math.round(strangle * 0.2));
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                setups.push({
                    type: 'SHORT STRANGLE', emoji: '\uD83E\uDE81',
                    rank: 'secondary',
                    trigger: `Sell ${otmCeStrike} CE + ${otmPeStrike} PE`,
                    entry: strangle, target, stop, speed: '10-30 min',
                    confidence: conf,
                    why: `OTM wings collect \u20B9${strangle}, both legs safe`,
                    topPick: false,
                });
            }
        }

        // 5) Breakout/Breakdown scalp
        if (regime === 'trending') {
            const bullBreak = spot > resistance;
            const bearBreak = spot < support;
            if (bullBreak || bearBreak) {
                const leg = findStrikeLeg({ strikes }, atmStrike, bullBreak ? 'CE' : 'PE');
                const entryPrem = leg?.ltp || (bullBreak ? atmCe?.ltp : atmPe?.ltp);
                if (entryPrem && entryPrem > 10) {
                    const target = entryPrem + 5;
                    const stop = entryPrem - 5;
                    const conf = calcConfidence({
                        oiWallQty: bullBreak ? topCeWall?.ce?.oi || 0 : topPeWall?.pe?.oi || 0,
                        totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                        pcr: pcr || 1, vix: 13, spotDistance: 20, regime: 'directional',
                    });
                    setups.push({
                        type: bullBreak ? 'BREAKOUT CE' : 'BREAKDOWN PE',
                        emoji: bullBreak ? '\uD83D\uDE80' : '\uD83E\uDE79',
                        rank: 'secondary',
                        trigger: `Spot broke ${bullBreak ? 'above resistance' : 'below support'} ${bullBreak ? resistance : support}`,
                        entry: entryPrem, target, stop, speed: '1-3 min',
                        confidence: conf,
                        why: 'Spot beyond the wall \u2014 momentum trade, exit fast',
                        topPick: conf >= 65,
                    });
                }
            }
        }

        setups.sort((a, b) => {
            if (a.topPick && !b.topPick) return -1;
            if (!a.topPick && b.topPick) return 1;
            return b.confidence - a.confidence;
        });

        return this._formatCard({
            spot, pcr, mpVal, resistance, support, rangeWidth, spotPct,
            atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups,
        });
    }

    _formatCard({ spot, pcr, mpVal, resistance, support, rangeWidth, spotPct, atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups }) {
        const L = [];
        const { hour, minute } = istTime();
        const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const dateLabel = istDateLabel();

        const regimeBadge = {
            low_vol: '\u26A0\uFE0F LOW VOL',
            trending: '\uD83D\uDD25 TRENDING',
            normal: '\uD83D\uDCCA NORMAL',
        }[regime] || '\uD83D\uDCCA NORMAL';

        const ladder = buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall });

        L.push('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
        L.push('\u2551  \u26A1 /scalp \u00B7 NIFTY MICRO SCALP       \u2551');
        L.push('\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D');
        L.push('');
        L.push(`\uD83D\uDCC5 ${dateLabel} \u00B7 ${timeLabel} IST`);
        L.push(`\uD83D\uDCCD Spot: ${fmtNum(spot)} \u00B7 ${regimeBadge}`);
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');
        L.push('\uD83D\uDCCA *SCALP MAP*');
        L.push('');
        for (const row of ladder) {
            L.push(row);
        }
        L.push('');
        L.push(`  Max Pain: ${fmtNum(mpVal)} \u00B7 Range: ${rangeWidth} pts`);
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        L.push('\uD83D\uDC8E *PREMIUM LIVE*');
        L.push('');
        L.push('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
        if (atmCe) {
            L.push(`\u2502 CE ${fmtNum(atmStrike)} \u2502 \u20B9${atmCe.ltp ?? '\u2013'} \u2502 LTP`);
        }
        if (atmPe) {
            L.push(`\u2502 PE ${fmtNum(atmStrike)} \u2502 \u20B9${atmPe.ltp ?? '\u2013'} \u2502 LTP`);
        }
        const straddle = (atmCe?.ltp || 0) + (atmPe?.ltp || 0);
        if (straddle > 0) {
            L.push(`\u2502 Straddle  \u2502 \u20B9${straddle} \u2502 Total`);
        }
        L.push('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        if (setups.length) {
            const primary = setups.filter((s) => s.rank === 'primary');
            const secondary = setups.filter((s) => s.rank !== 'primary');

            if (primary.length) {
                L.push('\uD83C\uDFAF *\uD83D\uDD35 PRIMARY \u00B7 Best for 5pt scalps*');
                L.push('');
                for (const s of primary) {
                    const pick = s.topPick ? ' \u2B50 TOP PICK' : '';
                    const strikeLabel = s.strike && s.optionType ? `Buy ${s.optionType} ${fmtNum(s.strike)}` : '';
                    L.push(`*${s.emoji} ${s.type}${pick}*`);
                    if (strikeLabel) L.push(`  ${strikeLabel}`);
                    if (s.trigger) L.push(`  Trigger: ${s.trigger}`);
                    L.push(`  Entry: \u20B9${s.entry} \u00B7 Target: \u20B9${s.target} \u00B7 Stop: \u20B9${s.stop}`);
                    L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                    if (s.why) L.push(`  \uD83D\uDCCA ${s.why}`);
                    L.push('');
                }
            }

            if (secondary.length) {
                L.push('\u26A1 *\uD83D\uDFE3 SECONDARY \u00B7 Theta & Momentum*');
                L.push('');
                for (const s of secondary) {
                    const pick = s.topPick ? ' \u2B50' : '';
                    const isShort = s.type.startsWith('SHORT');
                    L.push(`*${s.emoji} ${s.type}${pick}*`);
                    if (s.trigger) L.push(`  Trigger: ${s.trigger}`);
                    if (isShort) {
                        // Short/Sell positions: profit when price goes DOWN
                        L.push(`  SELL at \u20B9${s.entry} \u2192 BUY BACK at \u20B9${s.target} (profit \u20B9${Math.round(s.entry - s.target)})`);
                        L.push(`  Stop: \u20B9${s.stop} (loss \u20B9${Math.round(s.stop - s.entry)})`);
                    } else {
                        L.push(`  Entry: \u20B9${s.entry} \u00B7 Target: \u20B9${s.target} \u00B7 Stop: \u20B9${s.stop}`);
                    }
                    L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                    L.push('');
                }
            }
        } else {
            L.push('\u26A0\uFE0F *NO CLEAR SETUP NOW*');
            L.push('  Spot is mid-range \u2014 wait for trigger');
            L.push('');
        }

        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        if (spotPct >= 30 && spotPct <= 70 && !setups.some((s) => s.topPick)) {
            L.push('\u26A0\uFE0F *SPOT IS MID-RANGE \u2014 NO TRADE NOW*');
            L.push('  Wait for spot to hit support or resistance');
            L.push('');
        }

        const isLowVol = regime === 'low_vol';
        const isTrending = regime === 'trending';
        L.push('\u26A1 *SCALP RULES*');
        L.push('  \uD83C\uDFAF +5 pt exit \u00B7 \uD83D\uDED1 \u22125 pt stop');
        L.push(`  \u23F0 2-5 min hold \u00B7 \uD83D\uDCE6 ${isLowVol ? '1 lot' : '2-3 lots'}`);
        L.push(`  \u25BB Max ${isLowVol ? '3' : '4'} trades/day`);
        if (isLowVol) L.push('  \u26A0\uFE0F Low vol \u2014 tighter stops, faster exits');
        if (isTrending) L.push('  \u26A0\uFE0F Trending \u2014 only trade in trend direction');
        L.push('  \u274C Skip if range < 50 pts');
        L.push('');
        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');
        L.push('\uD83D\uDD04 _Refresh: /scalp_');

        return L.join('\n');
    }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '\u2013';
    return Number(n).toLocaleString('en-IN');
}

function formatOi(oi) {
    if (!oi) return '0';
    if (oi >= 10000000) return `${(oi / 10000000).toFixed(1)}Cr`;
    if (oi >= 100000) return `${(oi / 100000).toFixed(1)}L`;
    if (oi >= 1000) return `${(oi / 1000).toFixed(1)}K`;
    return String(oi);
}

/**
 * Build a TradingView-style price ladder.
 * Always includes: CE OI wall (+RESISTANCE), PE OI wall (+SUPPORT),
 * ATM, YOU, MAX PAIN.  Ladder extends at most 1 step beyond the
 * outermost key level so blank rows don't dominate.
 */
function buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall }) {
    const rows = [];
    const pad = (s, len) => String(s).padStart(len);

    // 1. Collect key levels (deduplicated)
    const keySet = new Set();
    const addKey = (v) => { if (v != null && Number.isFinite(v)) keySet.add(v); };

    addKey(topCeWall?.strike);
    addKey(topPeWall?.strike);
    addKey(resistance);
    addKey(support);
    addKey(atmStrike);
    addKey(mpVal);
    addKey(Math.round(spot));

    const keyArr = [...keySet].sort((a, b) => b - a);
    const rangeHigh = Math.max(...keyArr);
    const rangeLow  = Math.min(...keyArr);
    const range = rangeHigh - rangeLow || 100;
    const step = Math.max(10, Math.round(range / 8 / 5) * 5);

    // 2. Cap max pain / outermost key to 1 step beyond the visible wall range
    //    so the ladder doesn't stretch to 23,750 when spot is 24,300.
    const wallHigh = Math.max(topCeWall?.strike || resistance, resistance);
    const wallLow  = Math.min(topPeWall?.strike || support, support);
    const cappedHigh = wallHigh + step;
    const cappedLow  = wallLow - step;

    const allLevels = new Set();
    // Add key levels only if within capped range
    for (const k of keySet) {
        if (k >= cappedLow && k <= cappedHigh) allLevels.add(k);
    }
    // Always include spot itself
    const spotRound = Math.round(spot);
    if (spotRound >= cappedLow && spotRound <= cappedHigh) allLevels.add(spotRound);

    // Fill between with step lines
    for (let p = cappedHigh; p >= cappedLow; p -= step) allLevels.add(p);
    const levels = [...allLevels].sort((a, b) => b - a);

    // 3. Nearest level to spot for YOU marker
    const nearestToSpot = levels.reduce((best, v) =>
        Math.abs(v - spot) < Math.abs(best - spot) ? v : best, levels[0]);

    // 4. Premium strings
    const ce = atmCe?.ltp != null ? 'CE \u20B9' + atmCe.ltp : '';
    const pe = atmPe?.ltp != null ? 'PE \u20B9' + atmPe.ltp : '';
    const premStr = ce && pe ? ce + ' / ' + pe : ce || pe || '';

    const oiWall = (wall, side) => {
        const label = side === 'CE' ? 'CE OI WALL' : 'PE OI WALL';
        const zone  = side === 'CE' ? 'SELL ZONE'  : 'BUY ZONE';
        const isAlsoResist = side === 'CE' && wall?.strike === resistance;
        const isAlsoSup    = side === 'PE' && wall?.strike === support;
        let extra = '';
        if (isAlsoResist) extra = ' \u00B7 RESISTANCE';
        if (isAlsoSup)    extra = ' \u00B7 SUPPORT';
        return `\u2593\u2593\u2593 ${label} (${formatOi(wall?.ce?.oi || wall?.pe?.oi)}) \u2190 ${zone}${extra}`;
    };

    // 5. Render rows
    for (const price of levels) {
        const p = pad(fmtNum(price), 8);
        const isCeWall = topCeWall?.strike === price;
        const isPeWall = topPeWall?.strike === price;
        const isSpot   = price === nearestToSpot;
        const isAtm    = price === atmStrike && !isSpot;
        const isMp     = price === mpVal && !isSpot && !isAtm;

        let line;
        if (isCeWall) {
            line = p + ' \u2524 ' + oiWall(topCeWall, 'CE');
        } else if (isPeWall) {
            line = p + ' \u2524 ' + oiWall(topPeWall, 'PE');
        } else if (price === resistance && !isCeWall) {
            line = p + ' \u2524 \u2591\u2591\u2591 \u00B7\u00B7\u00B7\u00B7\u00B7RESISTANCE\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (price === support && !isPeWall) {
            line = p + ' \u2524 \u2591\u2591\u2591 \u00B7\u00B7\u00B7\u00B7\u00B7\u00B7SUPPORT\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (isAtm) {
            line = p + ' \u2524 \u2500\u2500\u2500 ATM' + (premStr ? ' ' + premStr : '') + ' \u2500\u2500\u2500';
        } else if (isMp) {
            line = p + ' \u2524 \u00B7\u00B7\u00B7\u00B7\u00B7\u00B7MAX PAIN ' + fmtNum(mpVal) + '\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7';
        } else if (isSpot) {
            line = p + ' \u2524 \u25C4\u25C4\u25C4 YOU ARE HERE \u25BA\u25BA\u25BA' + (premStr ? ' \u2500\u2500\u2500 ' + premStr : '');
        } else {
            line = p + ' \u2524';
        }

        rows.push(line);
    }

    return rows;
}

export default ScalpService;
