/**
 * Self-check: heatmap v2 filters, intraday series math, discovery-source
 * routing and the outcome resolver. No network.
 *
 * Run: node scripts/check-heatmap-v2.js
 */
import assert from 'assert';
import {
    splitSessionsIST,
    todaySession,
    previousSessionClose,
    sessionVwap,
    openingRangeCandle,
    istMinutesOfDay,
    relativeStrength,
    sessionTurnover,
} from '../src/utils/intradaySeries.js';
import { computeSentimentV2, evaluateSetupV2, scaledMinMove } from '../src/services/HeatmapV2ScanService.js';
import {
    normalizeDiscoverySource,
    parseDiscoverySource,
    isPrescriptiveSource,
    DISCOVERY_SOURCES,
} from '../src/utils/discoverySource.js';
import { walkToOutcome, directionOf, isPremiumBased, OUTCOMES } from '../src/services/TradeOutcomeResolver.js';
import { pickStrategy } from '../src/utils/tradeMorningPick.js';
import { formatTradeScanPreview } from '../src/utils/tradeScanFormatter.js';
import { HEATMAP_SECTORS, UNKNOWN_HEATMAP_SYMBOLS, HEATMAP_UNIVERSE } from '../src/data/nseHeatmapSectors.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${a}, want ${b})`); checks += 1; };

/* ── candle helpers ──────────────────────────────────────────────────────── */

// 09:15 IST == 03:45 UTC.
const day = (d) => Date.parse(`2026-07-${String(d).padStart(2, '0')}T03:45:00Z`);
function bar(base, i, { o, h, l, c, v = 1000 }) {
    return { ts: base + i * 15 * 60 * 1000, open: o, high: h, low: l, close: c, volume: v };
}
/** A flat session of `n` bars around `price`. */
function flatSession(base, n, price, vol = 1000) {
    return Array.from({ length: n }, (_, i) =>
        bar(base, i, { o: price, h: price + 0.5, l: price - 0.5, c: price, v: vol })
    );
}

/* ── intraday series ─────────────────────────────────────────────────────── */

const twoDays = [...flatSession(day(20), 25, 100), ...flatSession(day(21), 10, 105)];
eq(splitSessionsIST(twoDays).length, 2, 'two IST sessions detected');
eq(todaySession(twoDays).length, 10, 'today = the latest session only');
eq(previousSessionClose(twoDays), 100, 'previous session close');
eq(previousSessionClose(flatSession(day(20), 5, 100)), null, 'single session has no prior close');

eq(istMinutesOfDay(day(20)), 9 * 60 + 15, '09:15 IST maps to 555 minutes');
eq(openingRangeCandle(todaySession(twoDays)).ts, day(21), 'OR is the 09:15 bar of TODAY');

// The bug this guards: with a 5-day fetch, a naive scan finds the OLDEST 09:15.
ok(openingRangeCandle(todaySession(twoDays)).ts !== day(20), 'OR is not a previous session bar');

const vw = sessionVwap(flatSession(day(21), 3, 100));
ok(vw && vw.every((v) => Math.abs(v - 100) < 1), 'VWAP tracks a flat session');
eq(sessionVwap(flatSession(day(21), 3, 100, 0)), null, 'no volume → VWAP unavailable, not fabricated');
eq(sessionTurnover(flatSession(day(21), 2, 100, 0)), null, 'no volume → no turnover');
ok(sessionTurnover(flatSession(day(21), 2, 100, 500)) > 0, 'turnover accumulates');

eq(relativeStrength(2.5, 1.0), 1.5, 'relative strength = stock − index');
eq(relativeStrength(2.5, null), null, 'RS unavailable without an index read');

/* ── sentiment ───────────────────────────────────────────────────────────── */

// v1 counted anything past ±0.05% as a colour; v2 needs a real move AND a spread.
eq(computeSentimentV2([{ indexPct: 0.06 }, { indexPct: 0.07 }, { indexPct: 0.08 }]).bias, 'NEUTRAL',
    'noise-level greens are not a bullish tape');
eq(computeSentimentV2([{ indexPct: 1 }, { indexPct: 1 }, { indexPct: 1 }, { indexPct: -1 }]).bias, 'NEUTRAL',
    'spread of 2 is not enough');
eq(computeSentimentV2([{ indexPct: 1 }, { indexPct: 1 }, { indexPct: 1 }]).bias, 'BULLISH', 'clear green tape');
eq(computeSentimentV2([{ indexPct: -1 }, { indexPct: -1 }, { indexPct: -1 }]).bias, 'BEARISH', 'clear red tape');

/* ── setup evaluation ────────────────────────────────────────────────────── */

/**
 * Metrics with EMA and ATR pinned rather than derived, so each assertion
 * exercises the filter it names instead of an accident of the fixture.
 * (Deriving them the first time meant a 3%-wide breakout bar on a 1%-ATR
 * series, which the ATR band correctly threw out — a real filter firing, but
 * not the thing that test was trying to check.)
 */
function metricsFrom(session, { relStrength = 1.0, atr14 = 1.0, ema = 100.3 } = {}) {
    const priorLen = 25;
    return {
        symbol: 'TEST',
        session,
        sessionStart: priorLen,
        emas: new Array(priorLen + session.length).fill(ema),
        or: openingRangeCandle(session),
        vwap: sessionVwap(session),
        atr14,
        relStrength,
    };
}

/** OR bar, drift, then a solid green breakout at index `breakIdx`. */
function breakoutSession(base, { breakIdx = 8, total = 10, orHigh = 101, breakClose = 101.8 } = {}) {
    const s = [bar(base, 0, { o: 100, h: orHigh, l: 99, c: 100.5, v: 1000 })];
    for (let i = 1; i < total; i++) {
        if (i === breakIdx) {
            s.push(bar(base, i, { o: 100.8, h: breakClose + 0.2, l: 100.7, c: breakClose, v: 5000 }));
        } else if (i > breakIdx) {
            // Non-solid drift bars: they must not register as breakouts themselves.
            s.push(bar(base, i, { o: breakClose, h: breakClose + 1.2, l: breakClose - 0.1, c: breakClose + 0.2, v: 2000 }));
        } else {
            s.push(bar(base, i, { o: 100.4, h: 100.7, l: 100.2, c: 100.5, v: 900 }));
        }
    }
    return s;
}

const good = evaluateSetupV2(metricsFrom(breakoutSession(day(21), { breakIdx: 8, total: 10 })), 'long');
ok(good.ok, `clean long breakout is taken (${good.reason || ''})`);
ok(good.setup.score > 0 && good.setup.score <= 100, 'score inside 0–100');
ok(good.setup.entry > good.setup.stop, 'long entry above its stop');
ok(good.setup.target1 > good.setup.entry, 'T1 above entry for a long');
ok(good.setup.target2 > good.setup.target1, 'T2 beyond T1');
ok(good.setup.riskAtrMult >= 0.6 && good.setup.riskAtrMult <= 2.0, 'stop inside the ATR band');
ok(good.setup.barsBack <= 6, 'reported break is recent');

// Targets are 1.0R / 2.0R — expectancy peaked there across the target sweep.
const rTo = (t) => (t - good.setup.entry) / good.setup.risk;
ok(Math.abs(rTo(good.setup.target1) - 1.0) < 0.02, `T1 is 1.0R (got ${rTo(good.setup.target1).toFixed(2)}R)`);
ok(Math.abs(rTo(good.setup.target2) - 2.0) < 0.02, `T2 is 2.0R (got ${rTo(good.setup.target2).toFixed(2)}R)`);

// Follow-through is a gate, so a confirmed break always has a bar after it —
// which is also what proves the entry price actually traded.
ok(good.setup.checks.followThrough, 'a taken setup always has follow-through');
ok(good.setup.barsBack >= 1, 'the break is never the final bar, so the fill is observed');

// v1's score could only ever land between 82 and 100 because its four required
// conditions were also its scoring conditions. v2 must actually discriminate.
const strong = evaluateSetupV2(metricsFrom(breakoutSession(day(21), { breakIdx: 8, total: 10 })), 'long');
const weak = evaluateSetupV2(
    metricsFrom(breakoutSession(day(21), { breakIdx: 3, total: 10 }), { relStrength: 0.1 }),
    'long'
);
ok(strong.ok, 'strong setup evaluates');
if (weak.ok) ok(strong.setup.score !== weak.setup.score, 'score separates strong from weak setups');

/* staleness: a break 8 bars ago is history, not an entry */
const stale = evaluateSetupV2(metricsFrom(breakoutSession(day(21), { breakIdx: 2, total: 14 })), 'long');
ok(!stale.ok, `stale break rejected (${stale.reason})`);

/* after noon: measured at 37% win rate and negative expectancy, so it is out */
const lateSession = breakoutSession(day(21), { breakIdx: 12, total: 14 });
eq(istMinutesOfDay(lateSession[12].ts), 12 * 60 + 15, 'bar 12 really is 12:15 IST');
const late = evaluateSetupV2(metricsFrom(lateSession), 'long');
ok(!late.ok, `post-noon break rejected (${late.reason})`);

/* a break on the final bar cannot be confirmed, so it is not taken */
const unconfirmed = breakoutSession(day(21), { breakIdx: 5, total: 6 });
const noConfirm = evaluateSetupV2(metricsFrom(unconfirmed), 'long');
ok(!noConfirm.ok, `unconfirmed break on the last bar rejected (${noConfirm.reason})`);

/* wrong side of VWAP must not be taken */
const belowVwap = breakoutSession(day(21), { breakIdx: 8, total: 10 });
// Make the early bars heavy and high so VWAP sits above the breakout close.
for (let i = 1; i < 8; i++) { belowVwap[i] = bar(day(21), i, { o: 130, h: 131, l: 129, c: 130, v: 900000 }); }
const vwapFail = evaluateSetupV2(metricsFrom(belowVwap), 'long');
ok(!vwapFail.ok, `long below VWAP rejected (${vwapFail.reason})`);

/* negative relative strength must not be taken long */
const rsFail = evaluateSetupV2(
    metricsFrom(breakoutSession(day(21), { breakIdx: 8, total: 10 }), { relStrength: -2 }),
    'long'
);
ok(!rsFail.ok, `long with negative RS rejected (${rsFail.reason})`);

/* stop wider than 2×ATR → R:R would be measuring noise */
const wideStop = evaluateSetupV2(
    metricsFrom(breakoutSession(day(21), { breakIdx: 8, total: 10 }), { atr14: 0.3 }),
    'long'
);
ok(!wideStop.ok, `stop beyond 2xATR rejected (${wideStop.reason})`);

/* stop tighter than 0.6×ATR → widened rather than left inside the spread */
const tight = evaluateSetupV2(
    metricsFrom(breakoutSession(day(21), { breakIdx: 8, total: 10 }), { atr14: 4, ema: 101.4 }),
    'long'
);
ok(tight.ok, `tight stop is widened, not rejected (${tight.reason || ''})`);
if (tight.ok) {
    ok(tight.setup.stopWidened, 'widening is flagged on the setup');
    ok(tight.setup.riskAtrMult >= 0.6, 'widened stop reaches the ATR floor');
}

/* price already past T1 → reported, not tradeable */
const ranAway = breakoutSession(day(21), { breakIdx: 7, total: 10 });
// Non-solid drift bars, so the only qualifying break stays at index 7.
ranAway[8] = bar(day(21), 8, { o: 101.8, h: 104.0, l: 101.7, c: 103.0, v: 2000 });
ranAway[9] = bar(day(21), 9, { o: 103.0, h: 107.0, l: 102.9, c: 105.0, v: 2000 });
const gone = evaluateSetupV2(metricsFrom(ranAway), 'long');
ok(!gone.ok, `already-past-T1 setup rejected (${gone.reason})`);
eq(gone.reason, 'already past T1', 'rejected for the right reason');

/* no break at all */
const noBreak = evaluateSetupV2(metricsFrom(flatSession(day(21), 10, 100)), 'long');
ok(!noBreak.ok, 'flat session yields no setup');

/* ── early session ───────────────────────────────────────────────────────── */

// The daily scan fires at 09:20, when only the (still forming) 09:15 bar
// exists. Demanding a closed opening range there would post nothing, ever.
const oneBar = evaluateSetupV2(metricsFrom(flatSession(day(21), 1, 100)), 'long');
ok(!oneBar.ok, 'one bar cannot contain a breakout');
eq(oneBar.reason, 'opening range not closed', 'and says so, so the caller can switch to watch mode');

// Three bars is the earliest a break can be CONFIRMED: the opening range, the
// break, and the bar that follows through on it.
const threeBar = breakoutSession(day(21), { breakIdx: 1, total: 3 });
const earliest = evaluateSetupV2(metricsFrom(threeBar), 'long');
ok(earliest.ok, `a confirmed 09:30 break is takeable (${earliest.reason || ''})`);
eq(istMinutesOfDay(threeBar[1].ts), 9 * 60 + 30, 'that break really is the 09:30 bar');

// A 1% move by 09:35 is decisive; the same 1% spread over six hours is drift.
ok(scaledMinMove(1.5, 1) < 1.5, 'threshold is looser early in the session');
eq(scaledMinMove(1.5, 0), 0.75, 'floor is half the configured threshold');
eq(scaledMinMove(1.5, 13), 1.5, 'full threshold by midday');
eq(scaledMinMove(1.5, 40), 1.5, 'never exceeds the configured threshold');
ok(scaledMinMove(1.5, 6) > scaledMinMove(1.5, 2), 'threshold rises monotonically');

/* ── discovery source routing ────────────────────────────────────────────── */

eq(normalizeDiscoverySource('heatmap2'), 'heatmap2', 'heatmap2 resolves');
eq(normalizeDiscoverySource('hm2'), 'heatmap2', 'hm2 alias');
eq(normalizeDiscoverySource('v2'), 'heatmap2', 'v2 alias');
eq(normalizeDiscoverySource('heatmap'), 'heatmap', 'heatmap2 does not swallow heatmap');
eq(normalizeDiscoverySource('breakout'), 'heatmap', 'v1 aliases still work');
eq(normalizeDiscoverySource('nse'), 'nse', 'nse resolves');
eq(normalizeDiscoverySource('garbage'), 'legacy', 'unknown falls back to legacy');
eq(parseDiscoverySource('garbage'), null, 'command parsing rejects unknown rather than defaulting');
eq(parseDiscoverySource('heatmap2'), 'heatmap2', 'command parsing accepts heatmap2');
ok(DISCOVERY_SOURCES.includes('heatmap2'), 'heatmap2 is a persistable source');
ok(isPrescriptiveSource('heatmap2'), 'heatmap2 list is authoritative (no AI overlay)');
ok(!isPrescriptiveSource('legacy'), 'legacy still gets the AI overlay');
for (const s of DISCOVERY_SOURCES) {
    eq(normalizeDiscoverySource(s), s, `${s} round-trips through normalize`);
}

/* ── downstream surfaces must recognise heatmap2 ─────────────────────────── */

// The morning pick names the strategy it used. Matching the literal 'heatmap'
// let 'heatmap2' fall through and get labelled VWAP — a strategy the trade was
// not selected by.
const orEma = pickStrategy({ discoverySource: 'heatmap', confluence: 50, signal: { confidence: 80 } });
const orEma2 = pickStrategy({ discoverySource: 'heatmap2', confluence: 50, signal: { confidence: 80 } });
eq(orEma2.name, orEma.name, 'heatmap2 gets the same OR/EMA strategy label as heatmap');
ok(!/vwap/i.test(orEma2.name), `heatmap2 is not mislabelled VWAP (got "${orEma2.name}")`);

// The scan card reads a different shape for v2 — no `status`, real T1/T2.
const cardV2 = formatTradeScanPreview({
    symbols: ['TCS'],
    discoverySource: 'heatmap2',
    heatmap: {
        version: 2,
        sentiment: { label: 'MIXED', green: 6, red: 4 },
        regime: { label: 'RISK-ON' },
        picks: [{
            symbol: 'TCS', changePct: 2.73, side: 'long', relStrength: 2.96,
            setup: { direction: 'long', score: 82, entry: 2435, stop: 2426.39, target1: 2443.61, target2: 2452.22 },
        }],
    },
});
ok(/HEATMAP v2/.test(cardV2), 'v2 scan card uses the v2 block');
ok(/T1 2443\.61/.test(cardV2), 'v2 card prints T1');
ok(/T2 2452\.22/.test(cardV2), 'v2 card prints T2');
ok(/score 82/.test(cardV2), 'v2 card prints the score');
ok(/Heatmap v2/.test(cardV2), 'v2 card names the discovery source');

// A pre-breakout watch has no levels; the card must not invent them.
const cardWatch = formatTradeScanPreview({
    symbols: ['TCS'],
    discoverySource: 'heatmap2',
    heatmap: {
        version: 2, preOpeningRange: true,
        sentiment: { label: 'MIXED', green: 6, red: 4 }, regime: { label: 'RISK-ON' },
        picks: [{ symbol: 'TCS', changePct: 2.2, side: 'long', relStrength: 2.0, setup: null }],
    },
});
ok(/watch/i.test(cardWatch), 'pre-breakout pick renders as a watch');
ok(!/T1 /.test(cardWatch), 'pre-breakout pick shows no targets');

/* ── sector map integrity ────────────────────────────────────────────────── */

eq(UNKNOWN_HEATMAP_SYMBOLS.length, 0, `every sector symbol is in the swing universe: ${UNKNOWN_HEATMAP_SYMBOLS}`);
ok(HEATMAP_UNIVERSE.length > 200, `universe is large enough to select from (${HEATMAP_UNIVERSE.length})`);
ok(HEATMAP_SECTORS.every((s) => s.symbols.length >= 6), 'no sector is too thin to pick from');
ok(HEATMAP_SECTORS.every((s) => new Set(s.symbols).size === s.symbols.length), 'no duplicates inside a sector');
for (const dead of ['TATAMOTORS', 'ZOMATO', 'INTERGLOBE', 'LTIM', 'GUJGASLTD']) {
    ok(!HEATMAP_UNIVERSE.includes(dead), `delisted/renamed ticker ${dead} removed`);
}
for (const live of ['TMCV', 'TMPV', 'ETERNAL', 'INDIGO']) {
    ok(HEATMAP_UNIVERSE.includes(live), `replacement ticker ${live} present`);
}

/* ── outcome resolver ────────────────────────────────────────────────────── */

eq(directionOf('SWING_LONG'), 1, 'swing long is +1');
eq(directionOf('EXPIRY_SHORT'), -1, 'short is −1');
eq(directionOf('BUY_PE'), -1, 'a put is a bearish direction');
ok(isPremiumBased('BUY_CE'), 'CE alerts are premium-based');
ok(isPremiumBased('EXPIRY_BULLISH'), 'expiry alerts are premium-based');
ok(!isPremiumBased('SWING_LONG'), 'swing alerts are equity-priced');

const longPlan = { dir: 1, entry: 100, stop: 95, target: 110 };
eq(
    walkToOutcome([{ ts: 1, high: 101, low: 100 }, { ts: 2, high: 111, low: 105 }], longPlan).outcome,
    OUTCOMES.WIN,
    'target before stop = WIN'
);
eq(
    walkToOutcome([{ ts: 1, high: 101, low: 100 }, { ts: 2, high: 102, low: 94 }], longPlan).outcome,
    OUTCOMES.LOSS,
    'stop before target = LOSS'
);
eq(
    walkToOutcome([{ ts: 1, high: 101, low: 100 }, { ts: 2, high: 111, low: 94 }], longPlan).outcome,
    OUTCOMES.LOSS,
    'both inside one bar resolves pessimistically'
);
eq(
    walkToOutcome([{ ts: 1, high: 99, low: 98 }, { ts: 2, high: 99, low: 97 }], longPlan).outcome,
    OUTCOMES.NO_DATA,
    'entry never filled = NO_DATA, not a loss'
);
eq(
    walkToOutcome([{ ts: 1, high: 101, low: 100 }, { ts: 2, high: 104, low: 99 }], longPlan).outcome,
    OUTCOMES.EXPIRED,
    'filled but undecided = EXPIRED'
);

const shortPlan = { dir: -1, entry: 100, stop: 105, target: 90 };
eq(
    walkToOutcome([{ ts: 1, high: 100, low: 99 }, { ts: 2, high: 99, low: 89 }], shortPlan).outcome,
    OUTCOMES.WIN,
    'short reaching its target = WIN'
);
eq(
    walkToOutcome([{ ts: 1, high: 100, low: 99 }, { ts: 2, high: 106, low: 99 }], shortPlan).outcome,
    OUTCOMES.LOSS,
    'short stopped out = LOSS'
);

console.log(`OK heatmap v2 + resolver — ${checks} checks passed`);
