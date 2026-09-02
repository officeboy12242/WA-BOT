/**
 * Self-check: liquidity sweep detection and the BSE/SENSEX wiring.
 *
 * Offline — the candles are hand-built so the rules are pinned rather than
 * whatever the market happened to do today.
 *
 * Run: node scripts/check-liquidity-sweep.js
 */
import assert from 'assert';

import {
    detectSweep,
    formatSweepAlert,
    isTradeableTime,
    SWEEP_CONFIG,
} from '../src/services/LiquiditySweepScanService.js';
import { computeAtrSeries, istDayKey, istMinutes } from '../src/utils/yahooCandles.js';
import {
    F_AND_O_INDICES,
    INDEX_KEYS,
    resolveIndexKey,
    unsupportedIndexReason,
} from '../src/data/indexUniverse.js';
import { BSE_SCRIP_CODES, pickStrike } from '../src/services/BseOptionChainService.js';

// ── candle helpers ───────────────────────────────────────────────────────────
// One IST session of 5m bars starting 09:15. 12:00 UTC is not 09:15 IST, so the
// base is built explicitly to keep the session-window checks meaningful.
function sessionCandles(specs, dayIso = '2026-09-02') {
    const base = new Date(`${dayIso}T09:15:00+05:30`).getTime();
    return specs.map((s, i) => ({
        t: new Date(base + i * 5 * 60_000),
        o: s.o, h: s.h, l: s.l, c: s.c, v: s.v ?? 1000,
    }));
}

/** Flat filler bars so ATR is defined and pivots have room to form. */
function flat(n, price, spread = 10) {
    return Array.from({ length: n }, () => ({
        o: price, h: price + spread, l: price - spread, c: price,
    }));
}

// ── 1. ATR ───────────────────────────────────────────────────────────────────
{
    const c = sessionCandles(flat(40, 1000, 10));
    const atr = computeAtrSeries(c, 14);
    assert.ok(Number.isNaN(atr[13]), 'ATR undefined before the period fills');
    assert.ok(Number.isFinite(atr[14]), 'ATR defined once the period fills');
    assert.ok(atr[20] > 0, 'ATR positive on moving bars');
}

// ── 2. a sweep that pierces and reclaims fires ───────────────────────────────
function sweepScenario({ pierceTo, closeAt }) {
    const bars = flat(40, 1000, 10);
    // Pivot low at index 32: dips to 980 with higher bars either side.
    bars.push({ o: 1000, h: 1005, l: 995, c: 1000 });
    bars.push({ o: 1000, h: 1005, l: 995, c: 1000 });
    bars.push({ o: 1000, h: 1002, l: 980, c: 998 }); // the pool
    bars.push({ o: 998, h: 1004, l: 996, c: 1002 });
    bars.push({ o: 1002, h: 1006, l: 998, c: 1004 });
    bars.push({ o: 1004, h: 1006, l: 999, c: 1003 });
    bars.push({ o: 1003, h: 1005, l: 998, c: 1002 });
    // Final bar sweeps under 980 and closes back above it.
    bars.push({ o: 1000, h: 1006, l: pierceTo, c: closeAt });
    return sessionCandles(bars);
}

{
    const setup = detectSweep(sweepScenario({ pierceTo: 968, closeAt: 1002 }));
    assert.ok(setup, 'pierce + reclaim must produce a setup');
    assert.strictEqual(setup.side, 'CE', 'sweep is long only');
    assert.ok(['SWING', 'EQUAL', 'ORL', 'SESSION'].includes(setup.pool), 'names a real pool');
    assert.ok(setup.level < setup.entry, 'pool sits below the reclaim close');
    assert.ok(setup.sweptLow < setup.level, 'price actually traded through the pool');
    assert.ok(setup.pierceAtr >= SWEEP_CONFIG.minPierceAtr
        && setup.pierceAtr <= SWEEP_CONFIG.maxPierceAtr, 'pierce inside the measured band');
    assert.ok(setup.stop < setup.sweptLow, 'stop sits below the swept wick');
    assert.ok(setup.t1 > setup.entry && setup.t2 > setup.t1, 'targets ordered above entry');

    // T1/T2 are R-multiples of the actual stop distance, not fixed percentages.
    const r = setup.entry - setup.stop;
    assert.ok(Math.abs(setup.t1 - (setup.entry + SWEEP_CONFIG.t1R * r)) < 0.05, 'T1 = 0.75R');
    assert.ok(Math.abs(setup.t2 - (setup.entry + SWEEP_CONFIG.t2R * r)) < 0.05, 'T2 = 1.25R');
}

// ── 3. no reclaim = no trade ─────────────────────────────────────────────────
{
    // Closes BELOW the pool: that is a breakdown, not a sweep.
    const setup = detectSweep(sweepScenario({ pierceTo: 968, closeAt: 975 }));
    assert.strictEqual(setup, null, 'closing below the level must not fire');
}

// ── 4. pierce-depth band ─────────────────────────────────────────────────────
// Measured inverted U: under 0.25 ATR is noise (PF 0.83) and over 1.30 ATR is a
// real breakdown (PF 0.87). Both must be rejected, not merely down-weighted.
{
    const shallow = detectSweep(sweepScenario({ pierceTo: 989, closeAt: 1002 }));
    assert.strictEqual(shallow, null, 'a sub-0.25-ATR poke must not fire');

    const chasm = detectSweep(sweepScenario({ pierceTo: 700, closeAt: 1002 }));
    assert.strictEqual(chasm, null, 'a breakdown far past the level must not fire');
}

// ── 5. grading ───────────────────────────────────────────────────────────────
{
    const setup = detectSweep(sweepScenario({ pierceTo: 968, closeAt: 1002 }));
    const inBand =
        setup.pierceAtr >= SWEEP_CONFIG.aPlusLow && setup.pierceAtr <= SWEEP_CONFIG.aPlusHigh;
    assert.strictEqual(setup.grade, inBand || setup.pool === 'EQUAL' ? 'A+' : 'A',
        'grade follows the measured 0.50-1.00 ATR band');
    assert.ok(setup.expectedWinRate === (setup.grade === 'A+' ? 57 : 50), 'win rate tracks grade');
}

// ── 6. session window ────────────────────────────────────────────────────────
{
    const d = (hhmm) => new Date(`2026-09-02T${hhmm}:00+05:30`);
    assert.strictEqual(istMinutes(d('09:45')), SWEEP_CONFIG.firstEntryMin);
    assert.ok(!isTradeableTime(d('09:20')), 'opening auction excluded');
    assert.ok(isTradeableTime(d('11:00')), 'mid-session included');
    assert.ok(!isTradeableTime(d('15:10')), 'late session excluded');
    assert.strictEqual(istDayKey(d('09:45')), '2026-09-02');
}

// ── 7. too little data ───────────────────────────────────────────────────────
{
    assert.strictEqual(detectSweep([]), null, 'empty input is safe');
    assert.strictEqual(detectSweep(sessionCandles(flat(10, 1000))), null, 'short input is safe');
}

// ── 8. SENSEX is wired in ────────────────────────────────────────────────────
{
    assert.ok(INDEX_KEYS.includes('SENSEX'), 'SENSEX registered as an F&O index');
    const spec = F_AND_O_INDICES.SENSEX;
    assert.strictEqual(spec.yahoo, '^BSESN', 'SENSEX uses the BSE Yahoo ticker');
    assert.strictEqual(spec.exchange, 'BSE', 'SENSEX routes to the BSE chain');
    assert.strictEqual(spec.lot, 20);
    assert.strictEqual(BSE_SCRIP_CODES.SENSEX, spec.bseScripCd, 'scrip code agrees with the spec');
    assert.strictEqual(resolveIndexKey('sensex'), 'SENSEX');
    assert.strictEqual(resolveIndexKey('SX'), 'SENSEX');
    // The old "not covered" hint would fail SENSEX fast for no reason now.
    assert.strictEqual(unsupportedIndexReason('SENSEX'), null, 'SENSEX no longer unsupported');
    assert.ok(unsupportedIndexReason('BANKEX'), 'BANKEX still has no verified feed');
}

// ── 9. strike picking skips untraded strikes ─────────────────────────────────
{
    const snap = {
        spot: 76570,
        strikes: [
            { strike: 76400, ce: { ltp: 255.55 }, pe: { ltp: 169.1 } },
            { strike: 76600, ce: { ltp: null }, pe: { ltp: 266.1 } }, // untraded CE
            { strike: 76800, ce: { ltp: 83.5 }, pe: { ltp: 400 } },
        ],
    };
    const pick = pickStrike(snap, 'CE', { minPremium: 50, maxPremium: 400 });
    assert.strictEqual(pick.strike, 76400, 'nearest TRADED strike, not the nearest strike');
    assert.strictEqual(pickStrike(snap, 'CE', { minPremium: 5000 }), null, 'no fit returns null');
    assert.strictEqual(pickStrike({ strikes: [] }, 'CE'), null, 'empty chain is safe');
}

// ── 10. alert text ───────────────────────────────────────────────────────────
{
    const setup = { ...detectSweep(sweepScenario({ pierceTo: 968, closeAt: 1002 })),
                    label: 'SENSEX', lot: 20 };
    const bare = formatSweepAlert(setup);
    assert.ok(bare.includes('LIQUIDITY SWEEP'));
    assert.ok(bare.includes('T1') && bare.includes('T2') && bare.includes('Stop'));

    const withStrike = formatSweepAlert(setup, {
        strike: { strike: 76600, ce: { ltp: 153.15, oi: 59874 } },
        expiry: '03 Sep 2026',
    });
    assert.ok(withStrike.includes('76600 CE'), 'strike shown when a chain is available');
    assert.ok(withStrike.includes('153.15'), 'premium shown');
    assert.ok(withStrike.includes('03 Sep 2026'), 'expiry shown');
    assert.ok(withStrike.includes('3,063'), 'per-lot cost = premium x lot');
}

console.log('liquidity sweep + SENSEX self-check ok');
