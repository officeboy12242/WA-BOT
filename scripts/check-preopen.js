/**
 * Unit checks for PreOpenScanService. Pure functions only -- no network.
 * Run: node scripts/check-preopen.js
 */
import {
    orderImbalance,
    parsePreOpenRow,
    percentileRanks,
    rankPreOpen,
    dailyAtr,
    buildPreOpenSetup,
    MIN_REL_GAP_PCT,
} from '../src/services/PreOpenScanService.js';
import {
    DISCOVERY_SOURCES,
    normalizeDiscoverySource,
    parseDiscoverySource,
    isPrescriptiveSource,
} from '../src/utils/discoverySource.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${label}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------- imbalance
ok(near(orderImbalance(100, 0), 1), 'all buy -> +1');
ok(near(orderImbalance(0, 100), -1), 'all sell -> -1');
ok(near(orderImbalance(50, 50), 0), 'balanced -> 0');
ok(orderImbalance(0, 0) === null, 'empty book -> null');
ok(orderImbalance(null, null) === null, 'missing qty -> null');
ok(near(orderImbalance('1,000', '0'), 1), 'comma-formatted qty parses');

// ---------------------------------------------------------------- row parsing
const mkRow = (over = {}, det = {}) => ({
    metadata: {
        symbol: 'RELIANCE', iep: 110, previousClose: 100, totalTurnover: 5e7,
        yearHigh: 200, yearLow: 50, ...over,
    },
    detail: { preOpenMarket: { totalBuyQuantity: 300, totalSellQuantity: 100, atoBuyQty: 10, atoSellQty: 5, finalQuantity: 1000, ...det } },
});

const p = parsePreOpenRow(mkRow());
ok(p?.symbol === 'RELIANCE', 'symbol parsed');
ok(near(p.gapPct, 10), 'gapPct from IEP vs prevClose');
ok(near(p.imbalance, 0.5), 'imbalance 300/100 -> 0.5');
ok(near(p.turnoverCr, 5), 'turnover rupees -> crore');

ok(parsePreOpenRow(null) === null, 'null row rejected');
ok(parsePreOpenRow({ metadata: {} }) === null, 'no symbol rejected');
ok(parsePreOpenRow(mkRow({ iep: 0 })) === null, 'zero IEP rejected');
ok(parsePreOpenRow(mkRow({ previousClose: null })) === null, 'missing prevClose rejected');

// IEP alias fallbacks
ok(near(parsePreOpenRow({ metadata: { symbol: 'X', previousClose: 100 }, detail: { preOpenMarket: { IEP: 105 } } }).gapPct, 5), 'falls back to detail.IEP');
ok(near(parsePreOpenRow({ metadata: { symbol: 'X', previousClose: 100 }, detail: { preOpenMarket: { finalPrice: 90 } } }).gapPct, -10), 'falls back to finalPrice');

// ---------------------------------------------------------------- percentiles
const pr = percentileRanks([10, 20, 30, 40, 50]);
ok(near(pr[0], 0), 'lowest -> 0');
ok(near(pr[4], 1), 'highest -> 1');
ok(pr[2] > 0.4 && pr[2] < 0.6, 'median -> ~0.5');
ok(percentileRanks([]).length === 0, 'empty input safe');
ok(near(percentileRanks([7])[0], 0.5), 'single value -> 0.5');
const withNaN = percentileRanks([1, NaN, 3]);
ok(withNaN[1] === 0, 'NaN scored 0, does not throw');

// ---------------------------------------------------------------- ranking
const rows = (specs) => specs.map((s) => parsePreOpenRow(mkRow(
    { symbol: s.sym, iep: 100 * (1 + s.gap / 100), previousClose: 100, totalTurnover: (s.cr ?? 50) * 1e7 },
    { totalBuyQuantity: s.buy ?? 300, totalSellQuantity: s.sell ?? 100 }
)));

// market proxy: median gap should be subtracted
const board = rankPreOpen(rows([
    { sym: 'A', gap: 5 }, { sym: 'B', gap: 5 }, { sym: 'C', gap: 5 },
]));
ok(near(board.marketGapPct, 5), 'median gap becomes the market proxy');
ok(board.picks.length === 0, 'a whole board moving together yields no relative movers');

// a genuine relative mover survives
const one = rankPreOpen(rows([
    { sym: 'FLAT1', gap: 0 }, { sym: 'FLAT2', gap: 0 }, { sym: 'FLAT3', gap: 0 },
    { sym: 'MOVER', gap: 3, buy: 900, sell: 100 },
]));
ok(one.picks.length === 1 && one.picks[0].symbol === 'MOVER', 'relative mover selected');
ok(one.picks[0].side === 'long', 'gap up -> long');
ok(one.picks[0].relGapPct > 0, 'relGap positive for the mover');

// book disagreement is dropped, not guessed
const dis = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'BAD', gap: 3, buy: 100, sell: 900 },   // gaps up on net selling
]));
ok(dis.picks.length === 0, 'gap up with net sell pressure rejected');
ok(dis.rejects.bookDisagrees === 1, 'rejection is tallied as bookDisagrees');

// short side works symmetrically
const shortSide = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'DOWN', gap: -3, buy: 100, sell: 900 },
]));
ok(shortSide.picks.length === 1 && shortSide.picks[0].side === 'short', 'gap down + sell pressure -> short');

// a one-sided book (single order) is excluded
const lop = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'LOP', gap: 3, buy: 1000, sell: 0 },
]));
ok(lop.rejects.lopsided === 1, 'fully one-sided book rejected as lopsided');

// thin auctions excluded
const thin = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'THIN', gap: 3, cr: 0.1 },
]));
ok(thin.rejects.thinAuction === 1, 'thin auction rejected');

// threshold boundary: just under the minimum is excluded
const boundary = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'EDGE', gap: MIN_REL_GAP_PCT - 0.05 },
]));
ok(boundary.picks.length === 0, 'below minRelGapPct excluded');

// maxPicks respected, and ordering is by score
const many = rankPreOpen(rows([
    { sym: 'F1', gap: 0 }, { sym: 'F2', gap: 0 }, { sym: 'F3', gap: 0 },
    { sym: 'M1', gap: 1, buy: 400, sell: 100, cr: 10 },
    { sym: 'M2', gap: 4, buy: 900, sell: 100, cr: 200 },
    { sym: 'M3', gap: 2, buy: 500, sell: 100, cr: 100 },
]), { maxPicks: 2 });
ok(many.picks.length === 2, 'maxPicks respected');
ok(many.picks[0].score >= many.picks[1].score, 'picks sorted by score desc');
ok(many.picks[0].symbol === 'M2', 'biggest move + book + turnover ranks first');

// degenerate inputs
ok(rankPreOpen([]).picks.length === 0, 'empty rows safe');
ok(rankPreOpen([null, undefined]).picks.length === 0, 'null rows safe');

// ---------------------------------------------------------------- ATR / setup
const flat = Array.from({ length: 20 }, () => ({ high: 102, low: 98, close: 100 }));
ok(near(dailyAtr(flat), 4), 'ATR of a constant 4-wide range is 4');
ok(dailyAtr([]) === null, 'ATR of empty is null');
ok(dailyAtr(flat.slice(0, 5)) === null, 'ATR needs enough candles');
ok(dailyAtr(Array.from({ length: 20 }, () => ({ high: 100, low: 100, close: 100 }))) === null, 'zero-range ATR -> null');

const longSetup = buildPreOpenSetup({ iep: 100, side: 'long', score: 80 }, { candles: flat });
ok(longSetup.direction === 'LONG', 'long direction');
ok(longSetup.stop < 100 && longSetup.target1 > 100, 'long stop below, target above');
ok(near(longSetup.target1 - 100, 100 - longSetup.stop), 'T1 is 1R symmetric with the stop');
ok(near(longSetup.target2 - 100, 2 * (100 - longSetup.stop)), 'T2 is 2R');
ok(longSetup.riskAtr >= 0.6 && longSetup.riskAtr <= 2.0, 'risk stays inside ATR bounds');

const shortSetup = buildPreOpenSetup({ iep: 100, side: 'short', score: 70 }, { candles: flat });
ok(shortSetup.direction === 'SHORT', 'short direction');
ok(shortSetup.stop > 100 && shortSetup.target1 < 100, 'short stop above, target below');

ok(buildPreOpenSetup({ iep: 0, side: 'long' }, { candles: flat }) === null, 'no IEP -> no setup');
ok(buildPreOpenSetup({ iep: 100, side: 'long' }, null) === null, 'no candles -> no setup');
ok(buildPreOpenSetup({ iep: 100, side: 'long' }, { candles: [] }) === null, 'empty candles -> no setup');

// ---------------------------------------------------------------- source wiring
ok(DISCOVERY_SOURCES.includes('preopen'), 'preopen is a registered source');
ok(normalizeDiscoverySource('preopen') === 'preopen', 'canonical name resolves');
for (const alias of ['pre-open', 'pre', 'auction', 'iep', '915', '9:15'])
    ok(normalizeDiscoverySource(alias) === 'preopen', `alias ${alias} resolves`);
ok(parseDiscoverySource('preopen') === 'preopen', 'parse resolves preopen');
ok(parseDiscoverySource('nonsense') === null, 'unknown source still returns null');
ok(isPrescriptiveSource('preopen') === true, 'preopen list is authoritative (no AI symbol rewrite)');
// the pre-existing sources must not have been shadowed by the new aliases
ok(normalizeDiscoverySource('v2') === 'heatmap2', 'heatmap2 alias intact');
ok(normalizeDiscoverySource('heatmap') === 'heatmap', 'heatmap intact');
ok(normalizeDiscoverySource('legacy') === 'legacy', 'legacy intact');
ok(normalizeDiscoverySource('') === 'legacy', 'empty falls back to legacy');

console.log(`\ncheck-preopen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
