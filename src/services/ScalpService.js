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

function round2(n) {
    return Math.round(n * 100) / 100;
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

// ── Best strike selection for 5pt scalps ──────────────────────────────────

/**
 * Score a strike for scalping based on IV, OI, and proximity to ATM.
 * Higher score = better for capturing 5pt moves.
 */
function scoreStrikeForScalp(strike, side, spot, atmStrike, allStrikes) {
    const row = allStrikes.find((s) => s.strike === strike);
    if (!row) return 0;
    const leg = side === 'CE' ? row.ce : row.pe;
    if (!leg) return 0;

    // IV score (0-40): higher IV = more premium movement
    const iv = leg.iv || 0;
    const maxIv = 10; // NIFTY typical max IV
    const ivScore = Math.min(40, (iv / maxIv) * 40);

    // OI score (0-30): higher OI = better liquidity
    const oi = leg.oi || 0;
    const maxOi = 300000; // 3L = max score
    const oiScore = Math.min(30, (oi / maxOi) * 30);

    // Proximity to ATM (0-30): closer to ATM = higher delta = 1:1 movement
    const dist = Math.abs(strike - atmStrike);
    const maxDist = 200; // 200pts away = 0 score
    const proxScore = Math.max(0, 30 - (dist / maxDist) * 30);

    return Math.round(ivScore + oiScore + proxScore);
}

/**
 * Find the best strike for a given side (CE/PE) near a target level.
 * Returns the strike with highest momentum score.
 */
function findBestStrike(strikes, targetLevel, side, spot, atmStrike) {
    // Consider strikes within 100pts of target level
    const candidates = strikes
        .filter((s) => Math.abs(s.strike - targetLevel) <= 100)
        .filter((s) => { const leg = side === 'CE' ? s.ce : s.pe; return leg?.ltp > 0; });

    if (!candidates.length) return null;

    let bestStrike = null;
    let bestScore = -1;
    let bestLtp = 0;

    for (const s of candidates) {
        const score = scoreStrikeForScalp(s.strike, side, spot, atmStrike, strikes);
        const ltp = (side === 'CE' ? s.ce : s.pe)?.ltp || 0;
        // Prefer higher score; break ties by lower premium (cheaper entry)
        if (score > bestScore || (score === bestScore && ltp < bestLtp)) {
            bestScore = score;
            bestStrike = s.strike;
            bestLtp = ltp;
        }
    }

    return { strike: bestStrike, score: bestScore, ltp: bestLtp };
}

/**
 * Return top N strikes for a side, sorted by momentum score descending.
 * Each entry: { strike, ltp, iv, oi, score }
 */
function getTopStrikes(strikes, side, spot, atmStrike, n = 4) {
    const candidates = strikes
        .filter((s) => { const leg = side === 'CE' ? s.ce : s.pe; return leg?.ltp > 0; })
        .map((s) => {
            const leg = side === 'CE' ? s.ce : s.pe;
            return {
                strike: s.strike,
                ltp: leg.ltp || 0,
                iv: leg.iv || 0,
                oi: leg.oi || 0,
                score: scoreStrikeForScalp(s.strike, side, spot, atmStrike, strikes),
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, n);
    return candidates;
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

        // ── Build 5 setups (target +8 / stop -5, 75%+ conf filter) ─────────────────────
        const MIN_CONF = 75;
        const TARGET_PTS = 8;
        const STOP_PTS = 5;
        const setups = [];

        // 1) Support bounce — Buy CE (best momentum strike)
        if (spot - support < rangeWidth * 0.4) {
            const bestCe = findBestStrike(chain, support, 'CE', spot, atmStrike);
            const entryPrem = round2(bestCe?.ltp || (atmCe?.ltp ? atmCe.ltp - 20 : null));
            if (entryPrem && entryPrem >= 5) {
                const target = round2(entryPrem + TARGET_PTS);
                const stop = round2(entryPrem - STOP_PTS);
                const conf = calcConfidence({
                    oiWallQty: topPeWall?.pe?.oi || 0,
                    totalOi: snap.totalPeOi || 0, pcr: pcr || 1, vix: 13,
                    spotDistance: spot - support, regime: 'directional',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'BUY CE', emoji: '\uD83D\uDFE2',
                    rank: 'primary',
                    strike: bestCe?.strike || support,
                    optionType: 'CE',
                    momentumScore: bestCe?.score || 0,
                    trigger: `Spot touches ${support}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `PE OI wall ${formatOi(topPeWall?.pe?.oi)} at ${support} · Momentum: ${bestCe?.score || 0}/100`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 2) Resistance rejection — Buy PE (best momentum strike)
        if (resistance - spot < rangeWidth * 0.4) {
            const bestPe = findBestStrike(chain, resistance, 'PE', spot, atmStrike);
            const entryPrem = round2(bestPe?.ltp || (atmPe?.ltp ? atmPe.ltp - 20 : null));
            if (entryPrem && entryPrem >= 5) {
                const target = round2(entryPrem + TARGET_PTS);
                const stop = round2(entryPrem - STOP_PTS);
                const conf = calcConfidence({
                    oiWallQty: topCeWall?.ce?.oi || 0,
                    totalOi: snap.totalCeOi || 0, pcr: pcr || 1, vix: 13,
                    spotDistance: resistance - spot, regime: 'directional',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'BUY PE', emoji: '\uD83D\uDD34',
                    rank: 'primary',
                    strike: bestPe?.strike || resistance,
                    optionType: 'PE',
                    momentumScore: bestPe?.score || 0,
                    trigger: `Spot touches ${resistance}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `CE OI wall ${formatOi(topCeWall?.ce?.oi)} at ${resistance} · Momentum: ${bestPe?.score || 0}/100`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 3) Short Straddle
        if (spotPct >= 30 && spotPct <= 70) {
            const straddle = round2((atmCe?.ltp || 0) + (atmPe?.ltp || 0));
            if (straddle > 50) {
                const target = round2(straddle - 8);
                const stop = round2(straddle + 6);
                const profit = round2(straddle - target);
                const loss = round2(stop - straddle);
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'SHORT STRADDLE', emoji: '\u26A1',
                    rank: 'secondary',
                    strike: atmStrike,
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: atmStrike, price: atmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: atmStrike, price: atmPe?.ltp || 0 },
                    ],
                    trigger: `Spot mid-range (${spotPct}%)`,
                    entry: straddle, target, stop, speed: '5-15 min',
                    confidence: conf,
                    why: `ATM straddle \u20B9${straddle}, theta decay working`,
                    topPick: regime === 'low_vol' && conf >= 80,
                    });
                }
            }
        }

        // 4) Short Strangle
        if (spotPct >= 25 && spotPct <= 75 && rangeWidth >= TIGHT_RANGE_PTS) {
            const wingStep = Math.max(50, round5(rangeWidth / 4));
            const otmCeStrike = round5(atmStrike + wingStep);
            const otmPeStrike = round5(atmStrike - wingStep);
            const otmCe = findStrikeLeg({ strikes }, otmCeStrike, 'CE');
            const otmPe = findStrikeLeg({ strikes }, otmPeStrike, 'PE');
            const strangle = round2((otmCe?.ltp || 0) + (otmPe?.ltp || 0));
            if (strangle > 20) {
                const target = round2(strangle - Math.max(5, Math.round(strangle * 0.2)));
                const stop = round2(strangle + Math.max(4, Math.round(strangle * 0.2)));
                const profit = round2(strangle - target);
                const loss = round2(stop - strangle);
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'SHORT STRANGLE', emoji: '\uD83E\uDE81',
                    rank: 'secondary',
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: otmCeStrike, price: otmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: otmPeStrike, price: otmPe?.ltp || 0 },
                    ],
                    trigger: `Sell ${fmtNum(otmCeStrike)} CE + ${fmtNum(otmPeStrike)} PE`,
                    entry: strangle, target, stop, speed: '10-30 min',
                    confidence: conf,
                    why: `OTM wings collect \u20B9${strangle}, both legs safe`,
                    topPick: false,
                    });
                }
            }
        }

        // 5) Breakout/Breakdown scalp
        if (regime === 'trending') {
            const bullBreak = spot > resistance;
            const bearBreak = spot < support;
            if (bullBreak || bearBreak) {
                const leg = findStrikeLeg({ strikes }, atmStrike, bullBreak ? 'CE' : 'PE');
                const entryPrem = round2(leg?.ltp || (bullBreak ? atmCe?.ltp : atmPe?.ltp));
                if (entryPrem && entryPrem > 10) {
                    const target = round2(entryPrem + TARGET_PTS);
                    const stop = round2(entryPrem - STOP_PTS);
                    const conf = calcConfidence({
                        oiWallQty: bullBreak ? topCeWall?.ce?.oi || 0 : topPeWall?.pe?.oi || 0,
                        totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                        pcr: pcr || 1, vix: 13, spotDistance: 20, regime: 'directional',
                    });
                    if (conf >= MIN_CONF) {
                        setups.push({
                        type: bullBreak ? 'BREAKOUT CE' : 'BREAKDOWN PE',
                        emoji: bullBreak ? '\uD83D\uDE80' : '\uD83E\uDE79',
                        rank: 'secondary',
                        trigger: `Spot broke ${bullBreak ? 'above resistance' : 'below support'} ${bullBreak ? resistance : support}`,
                        entry: entryPrem, target, stop, speed: '1-3 min',
                        confidence: conf,
                        why: 'Spot beyond the wall \u2014 momentum trade, exit fast',
                        topPick: conf >= 80,
                        });
                    }
                }
            }
        }

        setups.sort((a, b) => {
            if (a.topPick && !b.topPick) return -1;
            if (!a.topPick && b.topPick) return 1;
            return b.confidence - a.confidence;
        });

        // Build strike comparison data for primary setups
        const primarySetups = setups.filter(s => s.rank === 'primary' && s.optionType);
        const strikeTables = {};
        for (const ps of primarySetups) {
            const topN = getTopStrikes(chain, ps.optionType, spot, atmStrike, 4);
            if (topN.length) strikeTables[ps.optionType] = topN;
        }

        return this._formatCard({
            spot, pcr, mpVal, resistance, support, rangeWidth, spotPct,
            atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups,
            strikeTables,
        });
    }

    _formatCard({ spot, pcr, mpVal, resistance, support, rangeWidth, spotPct, atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups, strikeTables }) {
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
        const straddle = round2((atmCe?.ltp || 0) + (atmPe?.ltp || 0));
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
                    if (s.momentumScore) L.push(`  Momentum: ${s.momentumScore}/100`);
                    if (s.why) L.push(`  \uD83D\uDCCA ${s.why}`);
                    L.push('');
                }

                // Strike comparison table
                for (const side of ['CE', 'PE']) {
                    const tbl = strikeTables?.[side];
                    if (!tbl?.length) continue;
                    const best = tbl[0];
                    L.push(`\uD83C\uDFB2 *WHY ${side} ${fmtNum(best.strike)}?*`);
                    L.push('');
                    for (let i = 0; i < tbl.length; i++) {
                        const r = tbl[i];
                        const isBest = i === 0;
                        const star = isBest ? ' \u2B50' : '';
                        L.push(`  ${fmtNum(r.strike)} \u2524 \u20B9${r.ltp} \u2502 IV ${r.iv.toFixed(1)}% \u2502 OI ${formatOi(r.oi)}`);
                        const barLen = Math.round(r.score / 5);
                        const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(20 - barLen);
                        L.push(`         \u2502 ${bar} ${r.score}/100${star}`);
                        if (i < tbl.length - 1) L.push('  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
                    }
                    const reasons = [];
                    if (best.iv >= 6) reasons.push(`IV ${best.iv.toFixed(1)}%`);
                    if (best.oi >= 100000) reasons.push(`OI ${formatOi(best.oi)}`);
                    const distFromAtm = Math.abs(best.strike - atmStrike);
                    if (distFromAtm <= 50) reasons.push('Near ATM');
                    else if (distFromAtm <= 100) reasons.push('Moderate delta');
                    L.push(`  \uD83D\uDCA1 Best pick: ${fmtNum(best.strike)} (${reasons.join(' + ') || 'Best score'})`);
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
                    if (isShort && s.legs && s.legs.length) {
                        for (const leg of s.legs) {
                            L.push(`  ${leg.action} ${fmtNum(leg.strike)} ${leg.optionType} \u20B9${round2(leg.price)}`);
                        }
                        const profit = round2(s.entry - s.target);
                        const loss = round2(s.stop - s.entry);
                        L.push(`  Premium: \u20B9${s.entry} \u2192 Target \u20B9${s.target} \u00B7 Profit \u20B9${profit}`);
                        L.push(`  Stop: \u20B9${s.stop} \u00B7 Loss \u20B9${loss}`);
                    } else if (isShort) {
                        L.push(`  Premium: \u20B9${s.entry} \u2192 Target \u20B9${s.target}`);
                        L.push(`  Stop: \u20B9${s.stop}`);
                    } else {
                        L.push(`  Entry: \u20B9${s.entry} \u00B7 Target: \u20B9${s.target} \u00B7 Stop: \u20B9${s.stop}`);
                    }
                    L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                    L.push('');
                }
            }
        }
        if (setups.length === 0) {
            L.push('\u26A0\uFE0F *NO CLEAR SETUP NOW*');
            L.push('  Spot is mid-range \u2014 wait for trigger');
            L.push('');
        }

        L.push('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        L.push('');

        const hasPrimary = setups.some((s) => s.rank === 'primary');
        if (!hasPrimary && spotPct >= 30 && spotPct <= 70) {
            L.push('\u26A0\uFE0F *WAIT FOR SPOT TO HIT SUPPORT OR RESISTANCE*');
            L.push('  Primary scalp setups trigger near OI walls');
            L.push('');
        }

        const isLowVol = regime === 'low_vol';
        const isTrending = regime === 'trending';
        L.push('\u26A1 *SCALP RULES*');
        L.push('  \uD83C\uDFAF +8 pt target \u00B7 \uD83D\uDED1 \u22125 pt stop');
        L.push('  \uD83D\uDCCA Fees: ~3.4 pts \u00B7 Net: +4.6 pts win / \u22128.4 pts loss');
        L.push('  \u2705 Only 75%+ confidence setups shown');
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
