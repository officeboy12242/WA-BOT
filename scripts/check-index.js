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
import {
    rangePosition, oiWalls, pcrLabel, indexAnalysisService,
    sessionVwap, barAtr, evaluateIndexSignal, sizeIndexTrade,
    istMinuteOfDay, todaySessionBars, SIGNAL_WINDOW, STRETCH_ATR,
} from '../src/services/IndexAnalysisService.js';
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
// This fixture carries no signal, so it must NOT produce a call. The card only
// says BUY when evaluateIndexSignal actually fires — asserted below.
ok(card.includes('NO ENTRY'), 'a card with no signal says NO ENTRY');
ok(!/BUY CE|BUY PE/i.test(card), 'a card with no signal contains no buy instruction');
ok(card.includes('66.7%'), 'card carries the measured fade win rate');

// --------------------------------------------------------------- VWAP / ATR
// Indices often report ZERO volume on Yahoo. If zero-volume bars were dropped or
// weighted zero, VWAP would be null on exactly the instruments this serves.
const zeroVol = Array.from({ length: 10 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100 + i, volume: 0 }));
ok(sessionVwap(zeroVol) !== null, 'VWAP survives all-zero volume (indices report none)');
ok(sessionVwap([]) === null, 'VWAP of empty is null');
ok(sessionVwap([{ high: NaN, low: 1, close: 1, volume: 1 }]) === null, 'VWAP ignores non-finite bars');
const flatBars = Array.from({ length: 10 }, () => ({ high: 102, low: 98, close: 100, volume: 1 }));
ok(near(sessionVwap(flatBars), 100, 1e-6), 'VWAP of a symmetric flat series is the midpoint');
ok(near(barAtr(flatBars), 4), 'bar ATR of a constant 4-wide range is 4');
ok(barAtr([{ high: 1, low: 1, close: 1 }]) === null, 'ATR needs enough bars');

// ------------------------------------------------------------------ signal rules
const mkBar = (min, close) => ({ min, close, high: close + 2, low: close - 2, volume: 100 });
const flatSess = Array.from({ length: 15 }, (_, i) => mkBar(9 * 60 + 15 + i * 5, 100));
const flatSig = evaluateIndexSignal(flatSess, 10 * 60 + 30);
ok(flatSig.side === null, 'flat session yields no entry');
ok(/no setup/.test(flatSig.reason), 'flat session explains why');

const upSess = [
    ...Array.from({ length: 12 }, (_, i) => mkBar(9 * 60 + 15 + i * 5, 100)),
    ...Array.from({ length: 4 }, (_, i) => mkBar(10 * 60 + 20 + i * 5, 130 + i)),
];
const upSig = evaluateIndexSignal(upSess, 10 * 60 + 35);
ok(upSig.side === 'short', 'stretch ABOVE VWAP fades SHORT, not long');
ok(upSig.kind === 'vwap-stretch', 'labelled vwap-stretch');

const dnSess = [
    ...Array.from({ length: 12 }, (_, i) => mkBar(9 * 60 + 15 + i * 5, 100)),
    ...Array.from({ length: 4 }, (_, i) => mkBar(10 * 60 + 20 + i * 5, 70 - i)),
];
ok(evaluateIndexSignal(dnSess, 10 * 60 + 35).side === 'long', 'stretch BELOW VWAP fades LONG');

// the measured time window is load-bearing, not cosmetic
ok(evaluateIndexSignal(upSess, 9 * 60 + 45).side === null, 'before the window -> no entry');
ok(/too early/.test(evaluateIndexSignal(upSess, 9 * 60 + 45).reason), 'says too early');
ok(evaluateIndexSignal(upSess, 14 * 60).side === null, 'after the dead time -> no entry');
ok(/NEGATIVE/.test(evaluateIndexSignal(upSess, 14 * 60).reason), 'says the rule measured negative late');
const degradedSig = evaluateIndexSignal(upSess, 12 * 60);
ok(degradedSig.side === 'short' && degradedSig.degraded === true, 'late-but-alive is flagged degraded');
ok(evaluateIndexSignal([mkBar(600, 100)], 10 * 60 + 30).side === null, 'too few bars -> no entry');
ok(evaluateIndexSignal(null, 10 * 60 + 30).side === null, 'null bars safe');
ok(SIGNAL_WINDOW.deadMin > SIGNAL_WINDOW.closeMin, 'dead time is after the window close');
ok(STRETCH_ATR === 1.0, 'threshold is the untuned 1xATR, not the best-looking 1.5');

// ----------------------------------------------------------------------- sizing
const sz = sizeIndexTrade({ premium: 121, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 });
ok(sz.lots === 1, 'NIFTY at ATR 16.2 needs exactly 1 lot to reach Rs600');
ok(sz.t1Rs >= 600 && sz.t1Rs <= 1200, 'T1 profit lands inside the requested band');
ok(Math.abs(sz.t1Rs - sz.riskRs) <= 2, 'target and risk are the same size — 1:1, the measured ratio');
ok(sz.premT1 > sz.premEntry && sz.premStop < sz.premEntry, 'exit above entry, stop below');
ok(sz.capitalUsed <= 30000, 'capital respected');
ok(sz.t2Rs > sz.t1Rs, 'runner target is further than T1');
const bigCap = sizeIndexTrade({ premium: 121, lot: 75, indexAtr: 16.2, capital: 300000, minProfit: 600, maxProfit: 1200 });
ok(bigCap.t1Rs <= 1200, 'more capital does not push profit past maxProfit');
const poor = sizeIndexTrade({ premium: 600, lot: 75, indexAtr: 16.2, capital: 10000, minProfit: 600, maxProfit: 1200 });
ok(poor.lots === 0 && typeof poor.blocked === 'string', 'unaffordable lot blocked with a reason, not a silent zero');
ok(sizeIndexTrade({ premium: 0, lot: 75, indexAtr: 16, capital: 30000, minProfit: 600, maxProfit: 1200 }) === null, 'zero premium -> null');
ok(sizeIndexTrade({ premium: 121, lot: 75, indexAtr: 0, capital: 30000, minProfit: 600, maxProfit: 1200 }) === null, 'zero ATR -> null');
const cheap = sizeIndexTrade({ premium: 3, lot: 75, indexAtr: 40, capital: 30000, minProfit: 600, maxProfit: 1200 });
ok(cheap === null || cheap.premStop > 0, 'stop premium never goes negative on a cheap option');

// -------------------------------------------------------------- session slicing
const twoDays = [
    { ts: Date.parse('2026-08-11T04:00:00Z'), high: 2, low: 1, close: 1.5, volume: 5 },
    { ts: Date.parse('2026-08-12T04:00:00Z'), high: 3, low: 2, close: 2.5, volume: 5 },
    { ts: Date.parse('2026-08-12T04:05:00Z'), high: 4, low: 3, close: 3.5, volume: 5 },
];
ok(todaySessionBars(twoDays).length === 2, 'only the latest session is kept');
ok(todaySessionBars([]).length === 0, 'empty candles safe');
ok(todaySessionBars(null).length === 0, 'null candles safe');
const withPlaceholder = [
    { ts: Date.parse('2026-08-12T03:45:00Z'), high: 5, low: 5, close: 5, volume: 0 },
    ...twoDays.slice(1),
];
ok(
    todaySessionBars(withPlaceholder).every((b) => !(b.volume === 0 && b.high === b.low)),
    'the 09:15 zero-volume pre-open placeholder is dropped'
);
ok(istMinuteOfDay(Date.parse('2026-08-12T04:00:00Z')) === 9 * 60 + 30, 'IST minute conversion gives 09:30');

// ------------------------------------------------------ card when a setup fires
const entryCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, changePct: -0.8, capital: 30000,
    expiry: '18-Aug-2026', atmStrike: 24450, atmCe: { ltp: 121, iv: 8.6 }, atmPe: { ltp: 124, iv: 11 },
    ceCapital: 9075, peCapital: 9300, pcr: 0.75, pcrLabel: pcrLabel(0.75),
    walls: { resistance: null, support: null }, maxPain: 24500, topCe: [], topPe: [],
    legName: 'PE', leg: { ltp: 124 },
    signal: {
        side: 'short', kind: 'vwap-stretch', vwap: 24400, atr: 16.2, stretch: 1.2,
        reason: '1.20xATR above VWAP - stretched, fade toward VWAP',
    },
    plan: sizeIndexTrade({ premium: 124, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 }),
});
ok(entryCard.includes('ENTER'), 'firing card says ENTER');
ok(entryCard.includes('BUY PE'), 'a short fade buys the PE');
ok(entryCard.includes('EXIT AT'), 'card gives an explicit exit price');
ok(entryCard.includes('STOP'), 'card gives a stop');
ok(entryCard.includes('66.7%'), 'card carries the measured win rate');
ok(entryCard.includes('n=51'), 'card carries the sample size beside the win rate');
ok(entryCard.includes('theta'), 'card warns the premium lags the index move');

const quietCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.30xATR from VWAP', vwap: 24400, stretch: 0.3 },
    plan: null,
});
ok(quietCard.includes('NO ENTRY'), 'quiet card says NO ENTRY');
ok(quietCard.includes('no setup'), 'quiet card gives the reason');
ok(!quietCard.includes('EXIT AT'), 'quiet card offers no exit price');

console.log(`\ncheck-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
