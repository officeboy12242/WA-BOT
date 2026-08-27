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
import { buildVolumeProfile, calcSessionVWAP, detectBarAbsorption, auctionRegime, vwapLevels, confluenceScore } from '../utils/volumeProfile.js';
import { fetchNiftySessionBars } from '../utils/niftyIntradayProfile.js';
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

/**
 * Nearest strike that actually exists in the chain.
 *
 * findStrikeLeg() matches strikes EXACTLY, but the strangle wings were built with
 * round5() — rounding to the nearest 5 while NIFTY strikes step in 50s. So a wing
 * at 24,425 matched nothing, both legs priced 0, and the setup failed its
 * `strangle > 20` check without any error. Measured across typical range widths,
 * 5 of 9 produced a non-existent wing, so SHORT STRANGLE was silently dead in
 * most sessions. Snapping to a real strike is what makes it reachable.
 */
function nearestStrike(chain, target) {
    let best = null;
    for (const s of chain) {
        if (!Number.isFinite(s?.strike)) continue;
        if (best === null || Math.abs(s.strike - target) < Math.abs(best - target)) best = s.strike;
    }
    return best;
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
    // distScore is zone-relative: being near the edge of the trigger zone (early
    // entry, more room to capture 8pt) scores higher than being right at the wall
    // (late entry, less room). zonePct: 0 = at wall, 1 = at zone edge.
    const zonePct = Math.min(1, spotDistance / 200);
    const distScore = Math.max(40, Math.min(90, 40 + zonePct * 50));

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

    const ltp = leg.ltp || 0;
    if (ltp <= 0) return 0;

    // Moneyness check — OTM strikes are ideal for scalping (cheaper, higher % move)
    // For CE: OTM = strike > spot. For PE: OTM = strike < spot.
    const isOTM = side === 'CE' ? strike > spot + 50 : strike < spot - 50;
    const isATM = strike === atmStrike;
    const moneynessBonus = isOTM ? 15 : isATM ? 5 : -10; // penalize ITM

    // Premium cost score (0-35): ₹30-₹90 is the sweet spot for 8pt scalps
    // Below ₹30 = illiquid / too far OTM, above ₹90 = hard to capture 8pts
    let premScore = 0;
    if (ltp >= 30 && ltp <= 90) {
        // Peak score at ₹50 — ideal balance of cost vs movement
        const distFromSweet = Math.abs(ltp - 50);
        premScore = Math.max(15, 35 - distFromSweet * 0.35);
    } else if (ltp > 90) {
        // Expensive — penalty scales with distance from sweet spot
        premScore = Math.max(0, 15 - (ltp - 90) * 0.2);
    } else if (ltp > 10) {
        // Below sweet spot but still tradeable
        premScore = Math.max(0, 15 - (30 - ltp) * 0.5);
    } else {
        // Very cheap — likely illiquid
        premScore = 0;
    }

    // OI score (0-25): higher OI = better liquidity
    const oi = leg.oi || 0;
    const maxOi = 300000;
    const oiScore = Math.min(25, (oi / maxOi) * 25);

    // IV score (0-25): moderate IV preferred (not too high = overpriced)
    const iv = leg.iv || 0;
    const ivScore = iv >= 5 && iv <= 10 ? 25 : iv > 10 ? Math.max(0, 25 - (iv - 10) * 3) : iv * 2.5;

    const raw = premScore + oiScore + ivScore + moneynessBonus;
    return Math.max(0, Math.round(raw));
}

/**
 * Find the best strike for a given side (CE/PE) near a target level.
 * Returns the strike with highest momentum score.
 */
function findBestStrike(strikes, targetLevel, side, spot, atmStrike) {
    // For scalping, we want OTM strikes near the trigger price:
    // - BUY CE triggers when spot touches SUPPORT → OTM CE at support = strike > support + 50
    // - BUY PE triggers when spot touches RESISTANCE → OTM PE at resistance = strike < resistance - 50
    // We use targetLevel (support/resistance) as the reference, NOT current spot,
    // because the setup fires when price reaches that level.
    // This ensures symmetric premium selection regardless of current spot position.

    const STRIKE_STEP = 50; // NIFTY strike interval

    // OTM at the TRIGGER PRICE (targetLevel), not current spot
    const isOTM = (s) => side === 'CE'
        ? s.strike >= targetLevel + STRIKE_STEP    // CE: OTM when spot is at support
        : s.strike <= targetLevel - STRIKE_STEP;   // PE: OTM when spot is at resistance
    const isATM = (s) => s.strike === atmStrike;

    // Tier 1: OTM at trigger price, ₹30-₹90 premium (best for 8pt scalps)
    // Using the same premium range for both CE and PE ensures symmetric selection
    // regardless of asymmetric support/resistance distances from ATM.
    const PREM_MIN = 30;
    const PREM_MAX = 90;
    let candidates = strikes
        .filter((s) => Math.abs(s.strike - targetLevel) <= 300)
        .filter((s) => isOTM(s))
        .filter((s) => {
            const leg = side === 'CE' ? s.ce : s.pe;
            return leg?.ltp > 0 && leg.ltp >= PREM_MIN && leg.ltp <= PREM_MAX;
        });

    // Tier 2: ATM strike (if OTM candidates are too expensive)
    if (!candidates.length || candidates.every(s => {
        const ltp = (side === 'CE' ? s.ce : s.pe)?.ltp || 0;
        return ltp > 150;
    })) {
        const atm = strikes.find((s) => isATM(s));
        if (atm) {
            const leg = side === 'CE' ? atm.ce : atm.pe;
            if (leg?.ltp > 0 && leg.ltp <= 150) {
                candidates = [atm, ...candidates.filter(s => s.strike !== atm.strike)];
            }
        }
    }

    // Tier 3: Any strike with cheap premium within 150pts of target
    if (!candidates.length) {
        candidates = strikes
            .filter((s) => Math.abs(s.strike - targetLevel) <= 150)
            .filter((s) => { const leg = side === 'CE' ? s.ce : s.pe; return leg?.ltp > 0 && leg.ltp <= 120; });
    }

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

        // OI walls — OTM only relative to spot:
        // resistance = biggest CE wall ABOVE spot, support = biggest PE wall BELOW spot.
        // Without this filter both walls can collapse onto one crowded ATM strike
        // (expiry week), giving range = 0 and a degenerate directional bias.
        const sortedByCe = [...chain].filter((s) => s.ce?.oi && s.strike > spot).sort((a, b) => b.ce.oi - a.ce.oi);
        const sortedByPe = [...chain].filter((s) => s.pe?.oi && s.strike < spot).sort((a, b) => b.pe.oi - a.pe.oi);

        let topCeWall = sortedByCe[0] || null;
        let topPeWall = sortedByPe[0] || null;

        // Fallbacks: if no OTM wall on one side, use the nearest strike on that side
        // that still has OI; otherwise the synthetic round5 level kicks in below.
        if (!topCeWall) {
            topCeWall = [...chain].filter((s) => s.strike > spot && s.ce?.oi > 0).sort((a, b) => a.strike - b.strike)[0] || null;
        }
        if (!topPeWall) {
            topPeWall = [...chain].filter((s) => s.strike < spot && s.pe?.oi > 0).sort((a, b) => b.strike - a.strike)[0] || null;
        }

        const resistance = topCeWall?.strike || round5(spot + 100);
        const support = topPeWall?.strike || round5(spot - 100);
        const rangeWidth = resistance - support;

        // Guard: never fire directional setups inside a degenerate/too-tight range
        const MIN_RANGE_PTS = 50;
        const rangeValid = rangeWidth >= MIN_RANGE_PTS;

        const spotPct = rangeWidth > 0
            ? Math.round(((spot - support) / rangeWidth) * 100)
            : 50;

        // ── Auction Market Theory, on REAL intraday bars ────────────────────
        //
        // POC/VAH/VAL/VWAP describe where the market transacted over time, so they
        // need session candles. These were previously fed option-chain rows dressed
        // as candles (`{ close: strike, volume: OI }`), which measures where options
        // are HELD rather than where price traded: the "VWAP" was really the
        // OI-weighted average strike, and it shared its input with the profile, so
        // the confluence score was counting one signal twice.
        //
        // Best-effort by design — /scalp must still produce setups when Yahoo is
        // unreachable, so these stay null and their card sections are omitted
        // rather than failing the card.
        let vp = null;
        let vwapData = null;
        let vwapInfo = null;
        let amtRegime = null;
        let absorption = null;
        let profileMeta = null;
        try {
            const session = await fetchNiftySessionBars();
            if (session?.bars?.length >= 10) {
                profileMeta = {
                    sessionDate: session.sessionDate,
                    volumeSource: session.volumeSource,
                    barCount: session.barCount,
                };
                vp = buildVolumeProfile(session.bars, 5);
                vwapData = calcSessionVWAP(session.bars);
                vwapInfo = vwapData ? vwapLevels(vwapData, spot) : null;
                amtRegime = vp ? auctionRegime(spot, vp) : null;
                absorption = detectBarAbsorption(session.bars);
            }
        } catch (err) {
            logger.debug(`Scalp AMT layer unavailable: ${err.message}`);
        }

        const regime = detectRegime({
            spot, maxPainVal: mpVal, rangeWidth, vix: 13, pcr: pcr || 1,
        });

        // ── Confluence Score (combines all indicators) ─────────────────────
        const confScore = confluenceScore(vp, vwapInfo, {
            pcr: pcr || 1,
            oiWall: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
            regime,
            spotDistance: Math.min(Math.abs(spot - support), Math.abs(spot - resistance)),
        });

        // ── Build 5 setups (target +8 / stop -5, 75%+ conf filter) ─────────────────────
        const MIN_CONF = 75;
        const TARGET_PTS = 8;
        const STOP_PTS = 5;
        const setups = [];

        // 1) Support bounce — Buy CE (cheap OTM strike near support)
        if (rangeValid && spot - support < rangeWidth * 0.6) {
            const bestCe = findBestStrike(chain, support, 'CE', spot, atmStrike);
            // Only use strike from findBestStrike (no ATM fallback — it picks ITM)
            const entryPrem = bestCe?.ltp ? round2(bestCe.ltp) : null;
            if (entryPrem && entryPrem >= 15 && entryPrem <= 200) {
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
                    strike: bestCe.strike,
                    optionType: 'CE',
                    momentumScore: bestCe.score || 0,
                    trigger: `Spot touches ${fmtNum(support)}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `PE OI wall ${formatOi(topPeWall?.pe?.oi)} at ${fmtNum(support)} · Strike ${fmtNum(bestCe.strike)} CE ₹${entryPrem}`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 2) Resistance rejection — Buy PE (cheap OTM strike near resistance)
        if (rangeValid && resistance - spot < rangeWidth * 0.6) {
            const bestPe = findBestStrike(chain, resistance, 'PE', spot, atmStrike);
            // Only use strike from findBestStrike (no ATM fallback — it picks ITM)
            const entryPrem = bestPe?.ltp ? round2(bestPe.ltp) : null;
            if (entryPrem && entryPrem >= 15 && entryPrem <= 200) {
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
                    strike: bestPe.strike,
                    optionType: 'PE',
                    momentumScore: bestPe.score || 0,
                    trigger: `Spot touches ${fmtNum(resistance)}`,
                    entry: entryPrem, target, stop, speed: '2-5 min',
                    confidence: conf,
                    why: `CE OI wall ${formatOi(topCeWall?.ce?.oi)} at ${fmtNum(resistance)} · Strike ${fmtNum(bestPe.strike)} PE ₹${entryPrem}`,
                    topPick: conf >= 80,
                    });
                }
            }
        }

        // 3) & 4) Short Straddle / Strangle.
        //
        // These were removed citing a backtest showing 47%/38% win rates. That
        // backtest priced a straddle as CALL + CALL — its pricer only ever returned
        // a call value, and its "mirror strike" 2*atm - atm is just atm — and it
        // pinned T at 1/365 at both entry and exit, so there was no theta decay at
        // all. That deletes the only profit source a short-premium setup has. The
        // numbers measured a bug, not these setups, so they are restored here.
        // If they should go, cut them on real option data.

        // 3) Short Straddle
        if (spotPct >= 30 && spotPct <= 70) {
            const straddle = round2((atmCe?.ltp || 0) + (atmPe?.ltp || 0));
            if (straddle > 50) {
                const target = round2(straddle - 8);
                const stop = round2(straddle + 6);
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'SHORT STRADDLE', emoji: '⚡',
                    rank: 'secondary',
                    strike: atmStrike,
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: atmStrike, price: atmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: atmStrike, price: atmPe?.ltp || 0 },
                    ],
                    trigger: `Spot mid-range (${spotPct}%)`,
                    entry: straddle, target, stop, speed: '5-15 min',
                    confidence: conf,
                    why: `ATM straddle ₹${straddle}, theta decay working`,
                    topPick: regime === 'low_vol' && conf >= 80,
                    });
                }
            }
        }

        // 4) Short Strangle
        if (spotPct >= 25 && spotPct <= 75 && rangeWidth >= TIGHT_RANGE_PTS) {
            const wingStep = Math.max(50, round5(rangeWidth / 4));
            // Snap to strikes the chain actually lists — see nearestStrike().
            const otmCeStrike = nearestStrike(chain, atmStrike + wingStep);
            const otmPeStrike = nearestStrike(chain, atmStrike - wingStep);
            const otmCe = findStrikeLeg({ strikes }, otmCeStrike, 'CE');
            const otmPe = findStrikeLeg({ strikes }, otmPeStrike, 'PE');
            const strangle = round2((otmCe?.ltp || 0) + (otmPe?.ltp || 0));
            if (strangle > 20) {
                const target = round2(strangle - Math.max(5, Math.round(strangle * 0.2)));
                const stop = round2(strangle + Math.max(4, Math.round(strangle * 0.2)));
                const conf = calcConfidence({
                    oiWallQty: Math.max(topCeWall?.ce?.oi || 0, topPeWall?.pe?.oi || 0),
                    totalOi: (snap.totalCeOi || 0) + (snap.totalPeOi || 0),
                    pcr: pcr || 1, vix: 13,
                    spotDistance: Math.min(spot - support, resistance - spot),
                    regime: 'theta',
                });
                if (conf >= MIN_CONF) {
                    setups.push({
                    type: 'SHORT STRANGLE', emoji: '🪁',
                    rank: 'secondary',
                    legs: [
                        { action: 'SELL', optionType: 'CE', strike: otmCeStrike, price: otmCe?.ltp || 0 },
                        { action: 'SELL', optionType: 'PE', strike: otmPeStrike, price: otmPe?.ltp || 0 },
                    ],
                    trigger: `Sell ${fmtNum(otmCeStrike)} CE + ${fmtNum(otmPeStrike)} PE`,
                    entry: strangle, target, stop, speed: '10-30 min',
                    confidence: conf,
                    why: `OTM wings collect ₹${strangle}, both legs safe`,
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
                        trigger: `Spot broke ${bullBreak ? 'above resistance' : 'below support'} ${fmtNum(bullBreak ? resistance : support)}`,
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
            strikeTables, vp, vwapData, vwapInfo, amtRegime,
            absorption, profileMeta, confScore,
        });
    }

    _formatCard({ spot, pcr, mpVal, resistance, support, rangeWidth, spotPct, atmStrike, atmCe, atmPe, topCeWall, topPeWall, regime, setups, strikeTables, vp, vwapData, vwapInfo, amtRegime, absorption, profileMeta, confScore }) {
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

        // ── Volume Profile Section ────────────────────────────────────────
        if (vp) {
            const vpBias = amtRegime?.regime === 'buy_zone' ? '\uD83D\uDFE2 BUY ZONE' 
                : amtRegime?.regime === 'sell_zone' ? '\uD83D\uDD34 SELL ZONE' 
                : amtRegime?.regime === 'balanced' ? '\u26A1 BALANCED' 
                : amtRegime?.regime === 'breakout' ? '\uD83D\uDE80 OUT OF VALUE'
                : '\u2753 UNKNOWN';
            // Name the construction. With ETF volume this is a volume profile;
            // without it buildVolumeProfile weights every bar equally, which is a
            // time-at-price (TPO) profile \u2014 related, but not the same thing.
            const kind = profileMeta?.volumeSource === 'etf-proxy' ? 'volume' : 'time-at-price';
            L.push(`\uD83D\uDCCA *AUCTION MARKET THEORY* (${kind})`);
            L.push('');
            L.push(`  POC: ${fmtNum(vp.poc)}  VAH: ${fmtNum(vp.vah)}  VAL: ${fmtNum(vp.val)}`);
            // Gap to the value area itself. The old card printed the distance from
            // VWAP under a "vs VA" label, which is a different measurement.
            const vaGap = spot > vp.vah ? spot - vp.vah : spot < vp.val ? spot - vp.val : 0;
            const vaTxt = vaGap === 0
                ? 'inside value'
                : `${vaGap > 0 ? '+' : ''}${fmtNum(round2(vaGap))} pts`;
            L.push(`  Spot vs VA: ${vaTxt} ${vpBias}`);
            if (vp.lvns && vp.lvns.length > 0) {
                const lvnStr = vp.lvns.slice(0, 3).map(l => `${fmtNum(l.low)}-${fmtNum(l.high)}`).join(', ');
                L.push(`  LVN zones: ${lvnStr}`);
            }
            L.push('');
        }

        // ── VWAP Section ──────────────────────────────────────────────────
        // Printed only when real volume backed it. Without volume every bar
        // weighs the same, making this a mean of typical prices rather than a
        // VWAP — printing that under this heading would be a false label.
        if (vwapInfo && profileMeta?.volumeSource === 'etf-proxy') {
            L.push('\uD83D\uDCCA *VWAP DYNAMIC S/R*');
            L.push('');
            L.push(`  VWAP: ${fmtNum(vwapInfo.vwap)}  \u00B11\u03C3: ${fmtNum(vwapData.lower1)}-${fmtNum(vwapData.upper1)}`);
            L.push(`  \u00B12\u03C3: ${fmtNum(vwapData.lowerBand)}-${fmtNum(vwapData.upperBand)}  Bias: ${vwapInfo.bias}`);
            L.push('');
        }

        // ── Absorption Detection ──────────────────────────────────────────
        if (absorption?.isAbsorbing) {
            const who = absorption.side === 'buyers'
                ? 'buyers absorbing the selling'
                : absorption.side === 'sellers'
                    ? 'sellers capping the buying'
                    : 'two-sided, no clear winner';
            L.push('\uD83D\uDD0D *ABSORPTION DETECTED*');
            L.push('');
            L.push(`  ${fmtNum(absorption.level)} \u00B7 score ${absorption.score} \u2014 ${who}`);
            L.push(`  ${absorption.volRatio}\u00D7 volume on ${absorption.rangeRatio}\u00D7 range`);
            L.push('');
        }

        // ── Confluence Score ───────────────────────────────────────────────
        if (confScore) {
            const confFacts = confScore.factors.map(f => `${f.name} ${f.score}`).join(' \u00B7 ');
            L.push(`\u2B50 *CONFLUENCE: ${confScore.score}/100* \u2014 ${confFacts}`);
            L.push('');
        }

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
                        L.push(`  Entry: \u20B9${s.entry} (collect) \u2192 Target: \u20B9${s.target} (buy back) \u00B7 +\u20B9${profit}`);
                        L.push(`  Stop: \u20B9${s.stop} (buy back) \u00B7 \u2212\u20B9${loss}`);
                    } else if (isShort) {
                        L.push(`  Entry: \u20B9${s.entry} (collect) \u2192 Target: \u20B9${s.target} (buy back)`);
                        L.push(`  Stop: \u20B9${s.stop} (buy back)`);
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
