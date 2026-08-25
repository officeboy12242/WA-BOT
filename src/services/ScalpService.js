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
    return '█'.repeat(filled) + '░'.repeat(empty);
}

function confLabel(pct) {
    if (pct >= 70) return '✅✅';
    if (pct >= 55) return '✅';
    if (pct >= 40) return '⚠️';
    return '❌';
}

// ── Confidence calculation ─────────────────────────────────────────────────

function calcConfidence({ oiWallQty, totalOi, pcr, vix, spotDistance, regime }) {
    // OI wall strength: higher wall = higher confidence
    const oiScore = Math.min(100, (oiWallQty / 80) * 100); // 80L = max score

    // PCR alignment: PCR > 1 = bullish bias favors CE buys, < 1 = PE
    const pcrScore = Math.min(100, Math.abs(pcr - 1) * 200 + 50);

    // VIX: low VIX = higher confidence for theta, lower for directional
    const vixScore = regime === 'theta'
        ? Math.max(0, 100 - (vix - LOW_VIX_THRESHOLD) * 5)
        : Math.min(100, (vix - 10) * 8);

    // Distance to wall: closer = higher confidence
    const distScore = Math.max(0, 100 - spotDistance * 0.5);

    // Time of day: 10:30-12:30 = peak
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

    /**
     * Build the full scalp card for NIFTY.
     * @param {string} symbol default 'NIFTY'
     * @returns {Promise<string|null>} formatted card text
     */
    async buildScalpCard(symbol = 'NIFTY') {
        const ctx = await this.nse.fetchOptionContext(symbol);
        if (!ctx?.snapshot) {
            return '⚠️ Could not fetch NSE option chain. Market may be closed or NSE is unreachable.';
        }

        const snap = ctx.snapshot;
        const spot = Number(snap.spot);
        const pcr = snap.pcr;
        const strikes = snap.strikes || [];
        const atmStrike = snap.atmStrike;
        const atmCe = snap.atmCe;
        const atmPe = snap.atmPe;

        if (!spot || !strikes.length) {
            return '⚠️ Incomplete option chain data — cannot build scalp card.';
        }

        // ── Near-spot strike universe (±600 pts) ────────────────────────
        // Far OTM rows from weekly+monthly chains pollute max pain and OI
        // walls. Restrict to the tradeable window around spot.
        const nearStrikes = strikes.filter(
            (s) => Math.abs(Number(s.strike) - spot) <= 600
        );
        const chain = nearStrikes.length >= 5 ? nearStrikes : strikes;

        // ── Calculate max pain ──────────────────────────────────────────
        const mpRows = chain
            .filter((s) => s.ce && s.pe)
            .map((s) => ({
                strike: s.strike,
                CE: { openInterest: s.ce.oi || 0 },
                PE: { openInterest: s.pe.oi || 0 },
            }));
        const mpVal = maxPain(mpRows);

        // ── Find OI walls (highest CE and PE OI near spot) ─────────────
        const sortedByCe = [...chain].filter((s) => s.ce?.oi).sort((a, b) => b.ce.oi - a.ce.oi);
        const sortedByPe = [...chain].filter((s) => s.pe?.oi).sort((a, b) => b.pe.oi - a.pe.oi);

        const topCeWall = sortedByCe[0];
        const topPeWall = sortedByPe[0];

        const resistance = topCeWall?.strike || round5(spot + 100);
        const support = topPeWall?.strike || round5(spot - 100);
        const rangeWidth = resistance - support;

        // ── Spot position in range (0% = at support, 100% = at resistance) ──
        const spotPct = rangeWidth > 0
            ? Math.round(((spot - support) / rangeWidth) * 100)
            : 50;

        // ── Regime ──────────────────────────────────────────────────────
        const regime = detectRegime({
            spot,
            maxPainVal: mpVal,
            rangeWidth,
            vix: 13, // placeholder — NSE chain doesn't provide VIX directly
            pcr: pcr || 1,
        });

        // ── Build setups ───────────────────────────────────────────────
        const setups = [];

        // Support bounce — Buy CE
        if (spot - support < rangeWidth * 0.4) {
            const ceNearSupport = findStrikeLeg({ strikes }, support, 'CE');
            const entryPrem = ceNearSupport?.ltp || (atmCe?.ltp ? atmCe.ltp - 20 : null);
            if (entryPrem) {
                const target = entryPrem + 3;
                const stop = entryPrem - 4;
                const conf = calcConfidence({
                    oiWallQty: topPeWall?.pe?.oi || 0,
                    totalOi: snap.totalPeOi || 0,
                    pcr: pcr || 1,
                    vix: 13,
                    spotDistance: spot - support,
                    regime: 'directional',
                });
                setups.push({
                    type: 'BUY CE',
                    emoji: '🟢',
                    trigger: `Spot touches ${support}`,
                    entry: entryPrem,
                    target,
                    stop,
                    speed: '2-5 min',
                    confidence: conf,
                    why: `PE OI wall ${formatOi(topPeWall?.pe?.oi)} at ${support}, spot near support`,
                    topPick: conf >= 65,
                });
            }
        }

        // Resistance rejection — Buy PE
        if (resistance - spot < rangeWidth * 0.4) {
            const peNearResistance = findStrikeLeg({ strikes }, resistance, 'PE');
            const entryPrem = peNearResistance?.ltp || (atmPe?.ltp ? atmPe.ltp - 20 : null);
            if (entryPrem) {
                const target = entryPrem + 3;
                const stop = entryPrem - 4;
                const conf = calcConfidence({
                    oiWallQty: topCeWall?.ce?.oi || 0,
                    totalOi: snap.totalCeOi || 0,
                    pcr: pcr || 1,
                    vix: 13,
                    spotDistance: resistance - spot,
                    regime: 'directional',
                });
                setups.push({
                    type: 'BUY PE',
                    emoji: '🔴',
                    trigger: `Spot touches ${resistance}`,
                    entry: entryPrem,
                    target,
                    stop,
                    speed: '2-5 min',
                    confidence: conf,
                    why: `CE OI wall ${formatOi(topCeWall?.ce?.oi)} at ${resistance}, spot near resistance`,
                    topPick: conf >= 65,
                });
            }
        }

        // Theta scalp — Short Straddle (only when mid-range or tight)
        if (spotPct >= 30 && spotPct <= 70) {
            const straddle = (atmCe?.ltp || 0) + (atmPe?.ltp || 0);
            if (straddle > 100) {
                const target = straddle - 5;
                const stop = straddle + 6;
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1,
                    vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                setups.push({
                    type: 'SHORT STRADDLE',
                    emoji: '⚡',
                    trigger: `Spot mid-range (${spotPct}%)`,
                    entry: straddle,
                    target,
                    stop,
                    speed: '5-15 min',
                    confidence: conf,
                    why: `ATM straddle ₹${straddle}, theta decay working, range-bound`,
                    topPick: regime === 'low_vol' && conf >= 60,
                });
            }
        }

        // Theta scalp — Short Strangle (wider wings, cheaper risk)
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
                    pcr: pcr || 1,
                    vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                setups.push({
                    type: 'SHORT STRANGLE',
                    emoji: '🪁',
                    trigger: `Sell ${otmCeStrike} CE + ${otmPeStrike} PE`,
                    entry: strangle,
                    target,
                    stop,
                    speed: '10-30 min',
                    confidence: conf,
                    why: `OTM wings collect ₹${strangle}, spot mid-range keeps both legs safe`,
                    topPick: false,
                });
            }
        }

        // Breakout scalp — momentum continuation past the wall
        if (regime === 'trending') {
            const bullBreak = spot > resistance;
            const bearBreak = spot < support;
            if (bullBreak || bearBreak) {
                const leg = findStrikeLeg({ strikes }, atmStrike, bullBreak ? 'CE' : 'PE');
                const entryPrem = leg?.ltp || (bullBreak ? atmCe?.ltp : atmPe?.ltp);
                if (entryPrem && entryPrem > 10) {
                    const target = entryPrem + 3;
                    const stop = entryPrem - 4;
                    const conf = calcConfidence({
                        oiWallQty: bullBreak ? topCeWall?.ce?.oi || 0 : topPeWall?.pe?.oi || 0,
                        totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                        pcr: pcr || 1,
                        vix: 13,
                        spotDistance: 20,
                        regime: 'directional',
                    });
                    setups.push({
                        type: bullBreak ? 'BREAKOUT CE' : 'BREAKDOWN PE',
                        emoji: bullBreak ? '🚀' : '🩸',
                        trigger: `Spot broke ${bullBreak ? 'above resistance' : 'below support'} ${bullBreak ? resistance : support}`,
                        entry: entryPrem,
                        target,
                        stop,
                        speed: '1-3 min',
                        confidence: conf,
                        why: `Spot beyond the wall — momentum trade, exit fast`,
                        topPick: conf >= 65,
                    });
                }
            }
        }

        // Sort: top picks first, then by confidence
        setups.sort((a, b) => {
            if (a.topPick && !b.topPick) return -1;
            if (!a.topPick && b.topPick) return 1;
            return b.confidence - a.confidence;
        });

        // ── Format card ─────────────────────────────────────────────────
        return this._formatCard({
            spot,
            pcr,
            mpVal,
            resistance,
            support,
            rangeWidth,
            spotPct,
            atmStrike,
            atmCe,
            atmPe,
            topCeWall,
            topPeWall,
            regime,
            setups,
        });
    }

    _formatCard({ spot, pcr, mpVal, resistance, support, rangeWidth, spotPct, atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups }) {
        const L = [];
        const { hour, minute } = istTime();
        const timeLabel = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        const dateLabel = istDateLabel();

        // Regime badge
        const regimeBadge = {
            low_vol: '⚠️ LOW VOL',
            trending: '🔥 TRENDING',
            normal: '📊 NORMAL',
        }[regime] || '📊 NORMAL';

        // Build price ladder rows
        const ladder = buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall });

        L.push('╔══════════════════════════════════════╗');
        L.push('║  ⚡ /scalp · NIFTY MICRO SCALP       ║');
        L.push('╚══════════════════════════════════════╝');
        L.push('');
        L.push(`📅 ${dateLabel} · ${timeLabel} IST`);
        L.push(`📍 Spot: ${fmtNum(spot)} · ${regimeBadge}`);
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('');
        L.push('📊 *SCALP MAP*');
        L.push('');
        for (const row of ladder) {
            L.push(row);
        }
        L.push('');
        L.push(`  Max Pain: ${fmtNum(mpVal)} · Range: ${rangeWidth} pts`);
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('');

        // Premium snapshot
        L.push('💎 *PREMIUM LIVE*');
        L.push('');
        L.push('┌────────────────────────────────┐');
        if (atmCe) {
            L.push(`│ CE ${fmtNum(atmStrike)} │ ₹${atmCe.ltp ?? '–'} │ LTP`);
        }
        if (atmPe) {
            L.push(`│ PE ${fmtNum(atmStrike)} │ ₹${atmPe.ltp ?? '–'} │ LTP`);
        }
        const straddle = (atmCe?.ltp || 0) + (atmPe?.ltp || 0);
        if (straddle > 0) {
            L.push(`│ Straddle  │ ₹${straddle} │ Total`);
        }
        L.push('└────────────────────────────────┘');
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('');

        // Setups
        if (setups.length) {
            L.push('🎯 *TRIGGER SCALPS*');
            L.push('');
            for (const s of setups) {
                const pick = s.topPick ? ' ⭐ TOP PICK' : '';
                L.push(`*${s.emoji} ${s.type}${pick}*`);
                if (s.trigger) L.push(`  Trigger: ${s.trigger}`);
                L.push(`  Entry: ₹${s.entry} · Target: ₹${s.target} · Stop: ₹${s.stop}`);
                L.push(`  Conf: ${s.confidence}% ${confBar(s.confidence)} ${confLabel(s.confidence)}`);
                if (s.why) L.push(`  📊 ${s.why}`);
                L.push('');
            }
        } else {
            L.push('⚠️ *NO CLEAR SETUP NOW*');
            L.push('  Spot is mid-range — wait for trigger');
            L.push('');
        }

        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('');

        // Mid-range warning
        if (spotPct >= 30 && spotPct <= 70 && !setups.some((s) => s.topPick)) {
            L.push('⚠️ *SPOT IS MID-RANGE — NO TRADE NOW*');
            L.push('  Wait for spot to hit support or resistance');
            L.push('');
        }

        // Rules
        const isLowVol = regime === 'low_vol';
        const isTrending = regime === 'trending';
        L.push('⚡ *SCALP RULES*');
        L.push('  🎯 +₹2-3 exit · 🛑 −₹3-4 stop');
        L.push(`  ⏰ 2-5 min hold · 📦 ${isLowVol ? '1 lot' : '2-3 lots'}`);
        L.push(`  🔁 Max ${isLowVol ? '3' : '4'} trades/day`);
        if (isLowVol) L.push('  ⚠️ Low vol — tighter stops, faster exits');
        if (isTrending) L.push('  ⚠️ Trending — only trade in trend direction');
        L.push('  ❌ Skip if range < 50 pts');
        L.push('');
        L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        L.push('');
        L.push('🔄 _Refresh: /scalp_');

        return L.join('\n');
    }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmtNum(n) {
    if (n == null || !Number.isFinite(n)) return '–';
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
 * Shows key levels from resistance to support with OI walls, ATM, spot, max pain.
 */
function buildPriceLadder({ spot, resistance, support, mpVal, atmStrike, atmCe, atmPe, topCeWall, topPeWall }) {
    const rows = [];
    const pad = (s, len) => String(s).padStart(len);

    // Build list of key price levels (descending)
    const levels = [];
    const step = Math.max(20, Math.round((resistance - support) / 10 / 5) * 5);

    // Start from resistance + buffer, go down to support - buffer
    const top = round5(resistance + 20);
    const bottom = round5(support - 20);

    for (let p = top; p >= bottom; p -= step) {
        levels.push(p);
    }

    // Determine nearest round number to spot for "YOU" marker
    const nearestLevel = levels.reduce((prev, curr) =>
        Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
    );

    for (const price of levels) {
        let line = '';
        const p = pad(fmtNum(price), 8);
        // OI wall marker
        const isCeWall = topCeWall?.strike === price;
        const isPeWall = topPeWall?.strike === price;

        if (isCeWall) {
            line = `${p} ┤ ▓▓▓ CE OI WALL (${formatOi(topCeWall?.ce?.oi)}) ← SELL ZONE`;
        } else if (isPeWall) {
            line = `${p} ┤ ▓▓▓ PE OI WALL (${formatOi(topPeWall?.pe?.oi)}) ← BUY ZONE`;
        } else if (price === resistance) {
            line = `${p} ┤ ░░░ ·····RESISTANCE·····`;
        } else if (price === support) {
            line = `${p} ┤ ░░░ ······SUPPORT······`;
        } else if (price === nearestLevel) {
            // Spot line — show CE/PE premiums inline
            const ceStr = atmCe?.ltp != null ? `CE ₹${atmCe.ltp}` : '';
            const peStr = atmPe?.ltp != null ? `PE ₹${atmPe.ltp}` : '';
            const premStr = ceStr && peStr ? `${ceStr} / ${peStr}` : ceStr || peStr || '';
            line = `${p} ┤ ◄◄◄ YOU ARE HERE ◄◄◄${premStr ? ' ─── ' + premStr : ''}`;
        } else if (price === mpVal) {
            line = `${p} ┤ ······MAX PAIN ${fmtNum(mpVal)}······`;
        } else if (price === atmStrike) {
            const ceStr = atmCe?.ltp != null ? `CE ₹${atmCe.ltp}` : '';
            const peStr = atmPe?.ltp != null ? `PE ₹${atmPe.ltp}` : '';
            const premStr = ceStr && peStr ? `${ceStr} / ${peStr}` : ceStr || peStr || '';
            line = `${p} ┤ ─── ATM${premStr ? ' ' + premStr : ''} ───`;
        } else if (price > resistance - step && price < resistance) {
            line = `${p} ┤`;
        } else if (price < support + step && price > support) {
            line = `${p} ┤`;
        } else {
            line = `${p} ┤`;
        }

        rows.push(line);
    }

    return rows;
}

export default ScalpService;
