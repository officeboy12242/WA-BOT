/**
 * Unit checks for TurnoverBandScanService + its wiring. Pure functions, no network.
 * Run: node scripts/check-turnover-band.js
 */
import {
    ema,
    atr,
    emaDirection,
    trendStrength,
    buildSetup,
    rankTurnoverBand,
    DEFAULTS,
    UNIVERSE,
    fetchFnoSymbols,
} from '../src/services/TurnoverBandScanService.js';
import {
    DISCOVERY_SOURCES,
    normalizeDiscoverySource,
    parseDiscoverySource,
    isPrescriptiveSource,
} from '../src/utils/discoverySource.js';
import { FNO_UNIVERSE } from '../src/services/MarketScanService.js';
import { pickStrategy } from '../src/utils/tradeMorningPick.js';
import { formatTradeScanPreview } from '../src/utils/tradeScanFormatter.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ ema / atr
ok(near(ema([5, 5, 5, 5, 5], 3), 5), 'EMA of a constant series is that constant');
ok(ema([], 3) === null, 'EMA of empty is null');
ok(ema([1, 2, 3], 2) > 2, 'EMA tracks a rising series upward');

const flat = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
ok(near(atr(flat), 4), 'ATR of a constant 4-wide range is 4');
ok(atr([]) === null, 'ATR of empty is null');
ok(atr(flat.slice(0, 3)) === null, 'ATR needs enough candles');
ok(atr(Array.from({ length: 20 }, () => ({ high: 7, low: 7, close: 7 }))) === null, 'zero-range ATR -> null');

// ------------------------------------------------------------ ema direction
const rising = Array.from({ length: 60 }, (_, i) => 100 + i);
const falling = Array.from({ length: 60 }, (_, i) => 200 - i);
ok(emaDirection(rising).dir === 1, 'monotonically rising -> LONG');
ok(emaDirection(falling).dir === -1, 'monotonically falling -> SHORT');
ok(emaDirection(Array.from({ length: 60 }, () => 100)).dir === 0, 'flat series -> no direction');
ok(emaDirection([1, 2, 3]) === null, 'too few closes -> null, not a guess');

// The ambiguous case that must NOT be guessed: price above the fast EMA while the
// fast EMA is still below the slow one (early turn). Direction must be 0.
const turning = [...Array.from({ length: 40 }, (_, i) => 200 - i * 2), ...Array.from({ length: 8 }, (_, i) => 122 + i * 3)];
const td = emaDirection(turning);
ok(td !== null, 'turning series parses');
ok(td.close > td.fast && td.fast < td.slow, 'fixture really is the ambiguous shape');
ok(td.dir === 0, 'price>fast but fast<slow -> dropped, not called LONG');

// ------------------------------------------------------------------ strength
ok(trendStrength({ close: 110, fast: 105, slow: 100, atr: 5 }) === 2, 'strength = (|c-f|+|f-s|)/atr');
ok(trendStrength({ close: 110, fast: 105, slow: 100, atr: 0 }) === 0, 'zero ATR -> 0, no divide-by-zero');
// scale invariance: same ATR-relative geometry on a pricier stock scores the same
ok(
    near(
        trendStrength({ close: 110, fast: 105, slow: 100, atr: 5 }),
        trendStrength({ close: 1100, fast: 1050, slow: 1000, atr: 50 })
    ),
    'strength is scale-invariant across price levels'
);

// ------------------------------------------------------------------ setup
const long = buildSetup({ close: 100, dir: 1, atr: 4, score: 60 });
ok(long.direction === 'LONG', 'long labelled');
ok(long.stop < 100 && long.target1 > 100, 'long stop below / target above');
ok(near(long.target1 - 100, 100 - long.stop), 'T1 is 1R, symmetric with the stop');
ok(near(long.target2 - 100, 2 * (100 - long.stop)), 'T2 is 2R');
ok(long.riskAtr >= 0.6 && long.riskAtr <= 2.0, 'risk inside the ATR bounds');
const short = buildSetup({ close: 100, dir: -1, atr: 4, score: 60 });
ok(short.direction === 'SHORT' && short.stop > 100 && short.target1 < 100, 'short mirrors correctly');
ok(buildSetup({ close: 100, dir: 0, atr: 4 }) === null, 'no direction -> no setup');
ok(buildSetup({ close: 0, dir: 1, atr: 4 }) === null, 'no price -> no setup');
ok(buildSetup({ close: 100, dir: 1, atr: 0 }) === null, 'no ATR -> no setup');

// ------------------------------------------------------------------ banding
const mkRow = (symbol, turnoverCr, trend = 'up') => {
    const closes = trend === 'up'
        ? Array.from({ length: 60 }, (_, i) => 100 + i)
        : trend === 'down'
          ? Array.from({ length: 60 }, (_, i) => 200 - i)
          : Array.from({ length: 60 }, () => 100);
    return {
        symbol,
        turnoverCr,
        closes,
        candles: closes.map((c) => ({ high: c + 2, low: c - 2, close: c })),
        changePct: 1,
    };
};
// 40 names, turnover descending by construction
const many = Array.from({ length: 40 }, (_, i) => mkRow(`S${i + 1}`, 1000 - i * 10));

const band = rankTurnoverBand(many, { bandFrom: 11, bandTo: 20, maxPicks: 50 });
ok(band.bandSize === 10, 'band 11-20 selects exactly 10 names');
ok(band.picks.every((p) => p.rank >= 11 && p.rank <= 20), 'every pick carries a rank inside the band');
const syms = band.picks.map((p) => p.symbol);
ok(!syms.includes('S1') && !syms.includes('S10'), 'top 10 excluded — the whole point');
ok(syms.includes('S11') && syms.includes('S20'), 'band is inclusive at both ends');

const top = rankTurnoverBand(many, { bandFrom: 1, bandTo: 10, maxPicks: 50 });
ok(top.picks.some((p) => p.symbol === 'S1'), 'band 1-10 does include the top name');
ok(top.bandSize === 10, 'band 1-10 sizes correctly');

// ranking is by turnover, not input order
const shuffled = [mkRow('LOW', 50), mkRow('HIGH', 5000), mkRow('MID', 500)];
const r3 = rankTurnoverBand(shuffled, { bandFrom: 1, bandTo: 1, maxPicks: 5 });
ok(r3.picks[0]?.symbol === 'HIGH', 'rank 1 is the highest turnover regardless of input order');

// filters
const withFlat = [...Array.from({ length: 12 }, (_, i) => mkRow(`A${i}`, 1000 - i)), mkRow('FLAT', 100, 'flat')];
const rf = rankTurnoverBand(withFlat, { bandFrom: 13, bandTo: 13, maxPicks: 5 });
ok(rf.picks.length === 0 && rf.rejects.emaFlat === 1, 'flat EMA stack rejected and tallied');

const illiquid = rankTurnoverBand([mkRow('TINY', 1)], { bandFrom: 1, bandTo: 5, minTurnoverCr: 20 });
ok(illiquid.rejects.illiquid === 1, 'below the turnover floor rejected');

const shortRow = rankTurnoverBand([{ symbol: 'X', turnoverCr: 999, closes: [1, 2], candles: [] }], {});
ok(shortRow.rejects.noData === 1, 'too-short history rejected as noData');

// sorted by strength, capped by maxPicks
const capped = rankTurnoverBand(many, { bandFrom: 11, bandTo: 30, maxPicks: 3 });
ok(capped.picks.length === 3, 'maxPicks respected');
for (let i = 1; i < capped.picks.length; i++)
    ok(capped.picks[i - 1].strength >= capped.picks[i].strength, 'picks ordered by strength desc');

// both directions survive
const mixed = [
    ...Array.from({ length: 10 }, (_, i) => mkRow(`U${i}`, 2000 - i)),
    mkRow('DOWNER', 900, 'down'),
];
const rm = rankTurnoverBand(mixed, { bandFrom: 11, bandTo: 11, maxPicks: 5 });
ok(rm.picks[0]?.side === 'short', 'a downtrending name in-band yields a SHORT');

// degenerate
ok(rankTurnoverBand([]).picks.length === 0, 'empty input safe');
ok(rankTurnoverBand([null, undefined]).picks.length === 0, 'null rows safe');
ok(DEFAULTS.bandFrom === 11, 'default band starts at 11, not 1');

// ------------------------------------------------------------------ wiring
ok(DISCOVERY_SOURCES.includes('turnover'), 'turnover registered as a source');
for (const a of ['turnover', 'band', 'active', 'mostactive', 'most-active', 'value'])
    ok(normalizeDiscoverySource(a) === 'turnover', `alias ${a} resolves`);
ok(parseDiscoverySource('turnover') === 'turnover', 'parse resolves turnover');
ok(parseDiscoverySource('gibberish') === null, 'unknown source still null');
ok(isPrescriptiveSource('turnover') === true, 'turnover list is authoritative');
// existing sources unharmed
ok(normalizeDiscoverySource('v2') === 'heatmap2', 'heatmap2 intact');
ok(normalizeDiscoverySource('pre') === 'preopen', 'preopen intact');
ok(normalizeDiscoverySource('gl') === 'nse', 'nse intact');
ok(normalizeDiscoverySource('') === 'legacy', 'empty -> legacy');

// strategy label must be its own, not borrowed
ok(pickStrategy({ discoverySource: 'turnover', confluence: 60, signal: { confidence: 80 } })
    === 'Turnover band + EMA 8/21 trend', 'turnover gets its own strategy label');
ok(pickStrategy({ discoverySource: 'turnover', confluence: 0, signal: {} })
    === 'Turnover band + EMA 8/21 trend', 'label independent of confluence/AI');
ok(pickStrategy({ discoverySource: 'preopen' }) === 'Pre-open auction + order imbalance', 'preopen label intact');
ok(pickStrategy({ discoverySource: 'heatmap2' }) === 'Opening Range Breakout + 8 EMA', 'heatmap2 label intact');

// ------------------------------------------------------------------ scan card
const card = formatTradeScanPreview({
    discoverySource: 'turnover',
    symbols: ['S11'],
    heatmap: {
        version: 'turnover', bandFrom: 11, bandTo: 30, scanned: 180,
        picks: [{
            symbol: 'S11', rank: 11, side: 'long', turnoverCr: 420.5, strength: 3.2, score: 64,
            close: 100, ema8: 97, ema21: 94,
            setup: { direction: 'LONG', entry: 100, stop: 97, target1: 103, target2: 106 },
        }],
    },
});
ok(card.includes('TURNOVER BAND'), 'renders the turnover block');
ok(card.includes('Ranks 11-30 of 180'), 'band and universe size shown');
ok(!card.includes('15m OR / 8 EMA'), 'not rendered as the v1 heatmap block');
ok(!card.includes('HEATMAP v2'), 'not rendered as the v2 block');
ok(!card.includes('PRE-OPEN AUCTION'), 'not rendered as the pre-open block');
ok(card.includes('E 100 · SL 97 · T1 103 · T2 106'), 'levels rendered');
ok(!/\d\.\d{6}/.test(card), 'no unrounded floats in the card');

const emptyCard = formatTradeScanPreview({
    discoverySource: 'turnover',
    symbols: [],
    heatmap: { version: 'turnover', picks: [], scanned: 180, rejects: { emaFlat: 12, noAtr: 1 } },
});
ok(emptyCard.includes('with EMAs disagreeing'), 'emaFlat reason surfaced on an empty day');

// -------------------------------------------------- F&O eligibility contract
// 67 of our 247 scan names have no options. An early run ranked FINCABLES first,
// which has no option chain, making the CE/PE card untradeable. The fallback must
// stay F&O-certain: never the unfiltered universe.
ok(typeof fetchFnoSymbols === 'function', 'fetchFnoSymbols is exported');
ok(Array.isArray(FNO_UNIVERSE) && FNO_UNIVERSE.length > 20, 'static FNO_UNIVERSE is a usable fallback');
ok(!FNO_UNIVERSE.includes('FINCABLES'), 'the static fallback excludes non-F&O names like FINCABLES');
ok(UNIVERSE.includes('FINCABLES'), 'FINCABLES IS in the raw scan universe — so the gate is load-bearing');
ok(UNIVERSE.length > FNO_UNIVERSE.length, 'raw universe is wider than the F&O fallback, as expected');

console.log(`\ncheck-turnover-band: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
