/**
 * Unit checks for the index universe + IndexAnalysisService. Pure, no network.
 * Run: node scripts/check-index.js
 */
import {
    F_AND_O_INDICES,
    INDEX_KEYS,
    resolveIndexKey,
    getIndexSpec,
    isIndexSymbol,
    unsupportedIndexReason,
} from '../src/data/indexUniverse.js';
import { rangePosition, oiWalls, pcrLabel, indexAnalysisService } from '../src/services/IndexAnalysisService.js';
import { normalizeYahooSymbol } from '../src/services/IndianStockQuoteService.js';
import { EXPIRY_INDICES } from '../src/services/ExpiryTradeService.js';
import { COMMAND_REGISTRY } from '../src/commands/registry.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------- the drift this file prevents
// ExpiryTradeService had the right tickers; IndianStockQuoteService knew only
// NIFTY and BANKNIFTY, so MIDCPNIFTY became MIDCPNIFTY.NS — nonexistent, and it
// HUNG rather than failed. One map now; these assert they cannot diverge again.
ok(EXPIRY_INDICES === F_AND_O_INDICES, 'ExpiryTradeService aliases the shared map (same object)');
for (const k of INDEX_KEYS) {
    ok(normalizeYahooSymbol(k) === F_AND_O_INDICES[k].yahoo, `normalizeYahooSymbol(${k}) uses the shared ticker`);
}
ok(normalizeYahooSymbol('MIDCPNIFTY') === 'NIFTY_MID_SELECT.NS', 'MIDCPNIFTY no longer becomes MIDCPNIFTY.NS');
ok(normalizeYahooSymbol('FINNIFTY') === 'NIFTY_FIN_SERVICE.NS', 'FINNIFTY no longer becomes FINNIFTY.NS');
// MIDCPNIFTY is Midcap SELECT (~15k) not Midcap 100 (~63k) — silent if wrong
ok(F_AND_O_INDICES.MIDCPNIFTY.yahoo.includes('MID_SELECT'), 'MIDCPNIFTY maps to Midcap SELECT, not Midcap 100');

// equities must be untouched by the index path
ok(normalizeYahooSymbol('RELIANCE') === 'RELIANCE.NS', 'equity still gets .NS');
ok(normalizeYahooSymbol('^NSEI') === '^NSEI', 'caret tickers pass through');
ok(normalizeYahooSymbol('') === '', 'empty stays empty');

// ------------------------------------------------------------------- resolution
ok(resolveIndexKey('nifty') === 'NIFTY', 'lowercase resolves');
ok(resolveIndexKey(' BankNifty ') === 'BANKNIFTY', 'whitespace + case resolves');
ok(resolveIndexKey('NIFTY50') === 'NIFTY', 'NIFTY50 alias');
ok(resolveIndexKey('BNF') === 'BANKNIFTY', 'BNF alias');
ok(resolveIndexKey('midcap') === 'MIDCPNIFTY', 'midcap alias');
ok(resolveIndexKey('NIFTY.NS') === 'NIFTY', 'suffix stripped before matching');
ok(resolveIndexKey('RELIANCE') === null, 'an equity is not an index');
ok(resolveIndexKey('') === null, 'empty is not an index');
ok(resolveIndexKey(null) === null, 'null safe');
ok(isIndexSymbol('finnifty') === true, 'isIndexSymbol true for an index');
ok(isIndexSymbol('TCS') === false, 'isIndexSymbol false for a stock');
ok(getIndexSpec('nifty')?.lot === 75, 'NIFTY lot 75');
ok(getIndexSpec('banknifty')?.lot === 30, 'BANKNIFTY lot 30');
ok(getIndexSpec('finnifty')?.lot === 65, 'FINNIFTY lot 65');
ok(getIndexSpec('midcpnifty')?.lot === 120, 'MIDCPNIFTY lot 120');
ok(getIndexSpec('nope') === null, 'unknown spec is null');

// unsupported index-looking symbols must be NAMED, so callers fail fast instead
// of stalling on a nonexistent ticker
ok(unsupportedIndexReason('SENSEX')?.includes('BSE'), 'SENSEX explained as BSE');
ok(unsupportedIndexReason('BANKEX')?.includes('BSE'), 'BANKEX explained as BSE');
ok(unsupportedIndexReason('NIFTYIT') !== null, 'NIFTYIT named as unsupported');
ok(unsupportedIndexReason('NIFTYNXT50') !== null, 'NIFTYNXT50 named as unsupported');
ok(unsupportedIndexReason('NIFTY') === null, 'a supported index has no unsupported reason');
ok(unsupportedIndexReason('RELIANCE') === null, 'an equity has no index reason');

// ------------------------------------------------------------- range position
ok(near(rangePosition(50, 0, 100), 0.5), 'midpoint of range = 0.5');
ok(near(rangePosition(0, 0, 100), 0), 'at the low = 0');
ok(near(rangePosition(100, 0, 100), 1), 'at the high = 1');
ok(near(rangePosition(150, 0, 100), 1), 'above the high clamps to 1');
ok(near(rangePosition(-5, 0, 100), 0), 'below the low clamps to 0');
ok(rangePosition(50, 100, 100) === null, 'zero-width range -> null, no divide by zero');
ok(rangePosition(null, 0, 100) === null, 'missing spot -> null');
ok(rangePosition(50, null, 100) === null, 'missing low -> null');

// ------------------------------------------------------------------- OI walls
const ce = [{ strike: 100, oi: 10 }, { strike: 110, oi: 50 }, { strike: 120, oi: 30 }];
const pe = [{ strike: 80, oi: 40 }, { strike: 90, oi: 70 }, { strike: 105, oi: 20 }];
const w = oiWalls(ce, pe, 100);
ok(w.resistance?.strike === 110, 'call wall is the highest-OI strike at/above spot');
ok(w.support?.strike === 90, 'put wall is the highest-OI strike at/below spot');
ok(oiWalls([], [], 100).resistance === null, 'no CE rows -> no resistance');
ok(oiWalls(null, null, 100).support === null, 'null rows safe');
// a strike exactly at spot counts on both sides
const atSpot = oiWalls([{ strike: 100, oi: 99 }], [{ strike: 100, oi: 99 }], 100);
ok(atSpot.resistance?.strike === 100 && atSpot.support?.strike === 100, 'strike at spot counts both ways');
// strikes on the wrong side are ignored even with huge OI
const wrongSide = oiWalls([{ strike: 50, oi: 9999 }], [{ strike: 150, oi: 9999 }], 100);
ok(wrongSide.resistance === null && wrongSide.support === null, 'wrong-side strikes ignored regardless of OI');

// ----------------------------------------------------------------- PCR wording
ok(pcrLabel(1.5)?.includes('put-heavy'), 'high PCR reads put-heavy');
ok(pcrLabel(0.5)?.includes('call-heavy'), 'low PCR reads call-heavy');
ok(pcrLabel(null) === null, 'null PCR -> null label');
ok(pcrLabel('x') === null, 'non-numeric PCR -> null label');

// --------------------------------------------------------------- analyze guard
// A non-index must be refused before any network call, and the message must name
// what IS supported rather than just failing.
let threw = null;
try { await indexAnalysisService.analyze('RELIANCE'); } catch (e) { threw = e.message; }
ok(threw !== null, 'analyze rejects a non-index');
ok(threw?.includes('NIFTY'), 'rejection lists the supported indices');
let threwBse = null;
try { await indexAnalysisService.analyze('SENSEX'); } catch (e) { threwBse = e.message; }
ok(threwBse?.includes('BSE'), 'SENSEX rejection explains why, not just "unsupported"');

// ------------------------------------------------------------ command wiring
const cmd = COMMAND_REGISTRY.find((c) => c.key === 'index');
ok(Boolean(cmd), '/index registered');
ok(cmd?.names.includes('/index'), '/index name present');
ok(cmd?.scope === 'group_only', '/index is group-only like the other trade commands');
ok(cmd?.category === 'trade', '/index categorised under trade');
// must not collide with an existing command name
const names = COMMAND_REGISTRY.flatMap((c) => c.names);
ok(names.filter((n) => n === '/index').length === 1, '/index is not a duplicate name');

// ------------------------------------------------- the card must not imply a call
const card = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435.95, changePct: -0.46,
    dayLow: 24380, dayHigh: 24520, rangePos: 0.4, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 120.5, iv: 12.4 }, atmPe: { ltp: 135.2, iv: 13.1 },
    ceCapital: 9037.5, peCapital: 10140, pcr: 0.75, pcrLabel: pcrLabel(0.75),
    walls: { resistance: { strike: 24600, oi: 1234567 }, support: { strike: 24300, oi: 987654 } },
    maxPain: 24400, topCe: [{ strike: 24600, oi: 1234567 }], topPe: [{ strike: 24300, oi: 987654 }],
});
ok(card.includes('NIFTY 50'), 'card names the index');
ok(card.includes('24450'), 'card shows the ATM strike');
ok(card.includes('lot 75'), 'card shows the lot size');
ok(/₹9,038|₹9,037/.test(card), 'card shows lot-sized CE capital');
ok(card.includes('Day range'), 'card renders the day range when high/low are present');
ok(card.includes('40% of range'), 'card renders the range position');
ok(card.includes('Max pain'), 'card shows max pain');
ok(card.includes('Call wall above'), 'card shows the call wall');
ok(card.includes('No direction called'), 'card states it calls no direction');
ok(card.includes('36.7%'), 'card carries the measured index-ORB number, not a claim');
ok(!/BUY CE|BUY PE|Verdict/i.test(card), 'card contains no buy verdict');

console.log(`\ncheck-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
