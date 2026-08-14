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
    sessionVwap, barAtr, evaluateIndexSignal, sizeIndexTrade, signalConfidence, chainLean,
    istMinuteOfDay, todaySessionBars, SIGNAL_WINDOW, STRETCH_ATR,
} from '../src/services/IndexAnalysisService.js';
import { normalizeYahooSymbol } from '../src/services/IndianStockQuoteService.js';
import { EXPIRY_INDICES } from '../src/services/ExpiryTradeService.js';
import { COMMAND_REGISTRY } from '../src/commands/registry.js';
import {
    STRATEGY_KEYS,
    checkConfluence, checkOrb, checkPcrExtreme, checkMacdMtf, checkMeanRev,
    strategyConfidence, qualityScore, evaluateStrategies, buildTech, resample15m,
} from '../src/services/IndexStrategyEngine.js';
import { rsi, macdState, adx, bollinger } from '../src/utils/indicators.js';

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

// the clock gate was removed on request — /index must read any time, so the
// only early block left is the data gate (needs ~40 minutes of trade)
ok(evaluateIndexSignal(upSess, 9 * 60 + 45).side === null, 'no clock gate — but too few bars before 09:55 -> no entry');
ok(/not enough bars/.test(evaluateIndexSignal(upSess, 9 * 60 + 45).reason), 'early block is the data gate, not the clock');
const lateSig = evaluateIndexSignal(upSess, 14 * 60);
ok(lateSig.side === 'short', 'the fade now evaluates after 12:30 (clock gates removed)');
ok(lateSig.veryLate === true && lateSig.degraded === true, 'post-12:30 reads are flagged veryLate');
const degradedSig = evaluateIndexSignal(upSess, 12 * 60);
ok(degradedSig.side === 'short' && degradedSig.degraded === true, '12:00 read is flagged degraded (not veryLate)');

// ---------------------------------------------------------- confidence score
ok(signalConfidence(null) === null, 'no signal -> no confidence');
ok(signalConfidence({ side: null, kind: null }) === null, 'no side -> no confidence');
const confStretch = signalConfidence({ side: 'short', kind: 'vwap-stretch', stretch: 1.2 });
ok(confStretch?.pct === 67 && confStretch.label === 'high', 'fresh vwap-stretch confidence = measured 66.7% (67)');
const confBreak = signalConfidence({ side: 'long', kind: 'failed-break', stretch: 0.3 });
ok(confBreak?.pct === 66 && confBreak.label === 'high', 'fresh failed-break confidence = measured 65.6% (66)');
const confDegraded = signalConfidence({ side: 'short', kind: 'vwap-stretch', stretch: 1.2, degraded: true });
ok(confDegraded?.pct === 53 && confDegraded.label === 'low', 'degraded window drops confidence 67 -> 53 (low)');
ok(confDegraded.pct < confStretch.pct, 'degraded is never stronger than fresh');
const confVeryLate = signalConfidence({ side: 'short', kind: 'vwap-stretch', stretch: 1.2, degraded: true, veryLate: true });
ok(confVeryLate?.pct === 43 && confVeryLate.label === 'low', 'veryLate (post-12:30) drops confidence further: 67 -> 43');
ok(confVeryLate.pct < confDegraded.pct, 'veryLate is weaker than degraded — the window measured NEGATIVE there');
const confBigStretch = signalConfidence({ side: 'short', kind: 'vwap-stretch', stretch: 3.0 });
ok(confBigStretch?.pct === 67, 'stretch bonus never pushes past the measured base');
const confDegradedBig = signalConfidence({ side: 'short', kind: 'vwap-stretch', stretch: 3.0, degraded: true });
ok(confDegradedBig?.pct === 58, 'a big stretch recovers part of the degraded penalty (52+6=58)');
ok(confDegradedBig.pct < 67, 'even a big stretch stays under the measured base when degraded');

// ----------------------------------------------------------- chain lean (unmeasured)
// Outside the fade window the card must not dead-end — it shows a soft lean
// from the chain. This is conventional reasoning, NOT the tested edge.
ok(chainLean({ spot: null }) === null, 'no spot -> no lean');
ok(chainLean({}) === null, 'no chain data -> no lean');
const leanBull = chainLean({
    spot: 24409, pcr: 0.75, maxPain: 24500,
    walls: { resistance: { strike: 24600 }, support: { strike: 24300 } },
});
ok(leanBull?.net === 1, 'call-heavy crowd + spot below max pain + support closer -> mild bullish');
ok(/mildly BULLISH/.test(leanBull.netLabel), 'net +1 reads mildly BULLISH');
ok(leanBull.factors.length === 3, 'all three factors contribute');
const leanBear = chainLean({
    spot: 24800, pcr: 1.5, maxPain: 24400,
    walls: { resistance: { strike: 24900 }, support: { strike: 24000 } },
});
ok(leanBear?.net === -1, 'put-heavy crowd + spot above max pain + resistance closer -> mild bearish');
ok(/mildly BEARISH/.test(leanBear.netLabel), 'net -1 reads mildly BEARISH');
const leanBalanced = chainLean({
    spot: 24400, pcr: 1.0, maxPain: 24400,
    walls: { resistance: { strike: 24600 }, support: { strike: 24200 } },
});
ok(leanBalanced?.net === 0, 'balanced inputs -> no lean');
ok(/balanced/.test(leanBalanced.netLabel), 'net 0 reads balanced');
const leanBigBull = chainLean({
    spot: 24000, pcr: 1.6, maxPain: 24500,
    walls: { resistance: { strike: 24500 }, support: { strike: 23500 } },
});
ok(leanBigBull?.net === 2, 'two factors agree -> 2 of 3 lean BULLISH');
ok(/2 of 3 lean BULLISH/.test(leanBigBull.netLabel), 'stronger bull lean labeled with the count');
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
ok(entryCard.includes('🧠 Strategy: *VWAP Stretch Fade*'), 'fade ENTER card names the strategy');
ok(entryCard.includes('Why:'), 'fade ENTER card shows the basis for the read');
ok(entryCard.includes('BUY PE'), 'a short fade buys the PE');
ok(entryCard.includes('EXIT AT'), 'card gives an explicit exit price');
ok(entryCard.includes('STOP'), 'card gives a stop');
ok(entryCard.includes('66.7%'), 'card carries the measured win rate');
ok(entryCard.includes('n=51'), 'card carries the sample size beside the win rate');
ok(entryCard.includes('theta'), 'card warns the premium lags the index move');
ok(entryCard.includes('Confidence: *67%*'), 'entry card shows the confidence percentage');
ok(entryCard.includes('high'), 'entry card grades the confidence');

const quietCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.30xATR from VWAP', vwap: 24400, stretch: 0.3 },
    plan: null,
});
ok(quietCard.includes('NO ENTRY'), 'quiet card says NO ENTRY');
ok(quietCard.includes('no setup'), 'quiet card gives the reason');
ok(quietCard.includes('Confidence: *0%*'), 'no-setup card still shows a 0% confidence read');
ok(!quietCard.includes('EXIT AT'), 'quiet card offers no exit price');
// A quiet card (no fade, no strategy, no signal) still shows the chain lean
// instead of dead-ending — labeled unmeasured.
const quietLeanCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.20xATR from VWAP (needs >=1.0) and no failed range break' },
    plan: null,
});
ok(quietLeanCard.includes('CHAIN LEAN'), 'quiet card shows the chain lean instead of dead-ending');
ok(quietLeanCard.includes('Unmeasured'), 'chain lean is labeled unmeasured');
ok(quietLeanCard.includes('no setup fired'), 'quiet card says no setup fired (no clock-gate wording anymore)');
ok(!/lean BULLISH|lean BEARISH/.test(entryCard), 'a card WITH a live fade signal shows no chain lean');

// the fade ENTER card must warn when the read is past the measured window
const veryLateCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, changePct: -0.8, capital: 30000,
    expiry: '18-Aug-2026', atmStrike: 24450, atmCe: { ltp: 121, iv: 8.6 }, atmPe: { ltp: 124, iv: 11 },
    ceCapital: 9075, peCapital: 9300, pcr: 0.75, pcrLabel: pcrLabel(0.75),
    walls: { resistance: null, support: null }, maxPain: 24500, topCe: [], topPe: [],
    legName: 'PE', leg: { ltp: 124 },
    signal: {
        side: 'short', kind: 'vwap-stretch', vwap: 24400, atr: 16.2, stretch: 1.2,
        reason: '1.20xATR above VWAP - stretched, fade toward VWAP', degraded: true, veryLate: true,
    },
    plan: sizeIndexTrade({ premium: 124, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 }),
});
ok(veryLateCard.includes('NEGATIVE'), 'a very-late ENTER card warns the window measured negative');
ok(veryLateCard.includes('Confidence: *43%*'), 'a very-late ENTER card shows the cut confidence');
ok(veryLateCard.includes('VWAP Stretch Fade'), 'a very-late ENTER card still names the strategy');

// the failed-range-break rule must name ITS strategy on the card too
const failedBreakCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, changePct: 0.5, capital: 30000,
    expiry: '18-Aug-2026', atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 },
    ceCapital: 9075, peCapital: 9300, pcr: 0.75, walls: {}, maxPain: 24500, topCe: [], topPe: [],
    legName: 'CE', leg: { ltp: 121 },
    signal: {
        side: 'long', kind: 'failed-break', vwap: 24400, atr: 16.2, stretch: -0.4,
        reason: 'broke the opening range down then closed back inside — failed break, fade it',
    },
    plan: sizeIndexTrade({ premium: 121, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 }),
});
ok(failedBreakCard.includes('Failed Range Break Fade'), 'failed-break ENTER card names its strategy');
ok(failedBreakCard.includes('BUY CE'), 'a long fade buys the CE');

// even when the fade fires, the all-strategies block must render underneath —
// this was the bug: a live fade hid the strategy UI entirely, so /index looked
// like the old card "again and again"
const fadePlusScanCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, changePct: -0.8, capital: 30000,
    expiry: '18-Aug-2026', atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 },
    ceCapital: 9075, peCapital: 9300, pcr: 0.75, walls: {}, maxPain: 24500, topCe: [], topPe: [],
    legName: 'PE', leg: { ltp: 124 },
    signal: { side: 'short', kind: 'vwap-stretch', vwap: 24400, atr: 16.2, stretch: 1.2,
        reason: '1.20xATR above VWAP - stretched, fade toward VWAP' },
    plan: sizeIndexTrade({ premium: 124, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 }),
    strategies: {
        winner: null, list: [], quiet: ['confluence', 'orb', 'pcr-reversal', 'macd-mtf', 'mean-rev'],
    },
});
ok(fadePlusScanCard.includes('ALL STRATEGIES (ranked)'), 'fade card also renders the scanned block');
ok(fadePlusScanCard.includes('1️⃣ *Fade* — VWAP Stretch Fade'), 'the fade leads the scanned block');
ok(fadePlusScanCard.includes('➖ Confluence · no setup'), 'quiet engines are listed under the fade');
ok(fadePlusScanCard.includes('ENTER'), 'the fade headline call is still the primary read');

// ═══════════════ tgbot2 strategy engine (ported) — indicators ═══════════════
// RSI is tgbot2's SIMPLE (SMA) RSI — all-gains and flat windows read 100.
ok(rsi([10, 11, 12, 13, 14, 15, 16, 17, 18], 7) === 100, 'all-gains RSI reads 100');
ok(rsi([10, 10, 10, 10, 10, 10, 10, 10, 10], 7) === 100, 'flat RSI reads 100 (tgbot2 behavior)');
ok(near(rsi([10, 12, 12, 12, 12, 12, 12, 11, 12], 7), 50, 1e-6), 'balanced gains/losses: RSI 50');
ok(rsi([10, 9, 8, 7, 6, 5, 4, 3, 2], 7) === 0, 'all-loss RSI reads 0');
ok(rsi([1, 2], 7) === null, 'RSI needs period+1 closes');

const rising40 = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
ok(macdState(rising40)?.bull === true, 'rising closes -> MACD bull');
ok(macdState(rising40)?.aboveZero === true, 'rising closes -> MACD above zero');
const falling40 = Array.from({ length: 40 }, (_, i) => 120 - i * 0.5);
ok(macdState(falling40)?.bear === true, 'falling closes -> MACD bear');
ok(macdState(rising40.slice(0, 30)) === null, 'MACD needs >= 35 closes (tgbot2 guard)');
// a late sharp spike puts the MACD cross inside the 3-bar lookback window
const lateSpike = [...Array(35).fill(100), 100, 100, 132];
ok(macdState(lateSpike, { crossLookback: 3 })?.crossUp === true, 'late spike -> crossUp detected in lookback');
ok(macdState(lateSpike, { crossLookback: 3 })?.bull === true, 'late spike -> MACD bull now');

const trendOhlc = {
    high: Array.from({ length: 30 }, (_, i) => 101 + i),
    low: Array.from({ length: 30 }, (_, i) => 99 + i),
    close: Array.from({ length: 30 }, (_, i) => 100 + i),
};
ok(adx(trendOhlc) !== null && adx(trendOhlc) > 50, 'steady trend -> high ADX');
const flatOhlc = {
    high: Array.from({ length: 30 }, () => 102),
    low: Array.from({ length: 30 }, () => 98),
    close: Array.from({ length: 30 }, () => 100),
};
ok(adx(flatOhlc) === null, 'flat series -> ADX null (no directional movement)');

const bb = bollinger(Array(20).fill(10));
ok(bb && near(bb.upper, 10) && near(bb.lower, 10) && near(bb.middle, 10), 'flat series -> Bollinger bands collapse on the mean');
ok(bollinger([1, 2, 3], 20) === null, 'Bollinger needs the full window');

// ═══════════════ strategy checks (ported logic, crafted tech) ═══════════════
const O = { minLayers: 3, orbBreakPct: 0.08, minAdx: 16, lastEntryMin: 15 * 60 };

// Confluence — 4 layers agree -> CE
const confBull = checkConfluence(
    { spot: 101, vwap: 100, ema9: 100.5, ema21: 100.2, rsi: 60, momPct: 0.5, dayPct: 0.2 },
    { pcr: 1.2, atmCe: { changeOi: 1000 }, atmPe: { changeOi: 100 }, walls: { support: { strike: 99 }, resistance: { strike: 103 } } },
    O
);
ok(confBull?.side === 'CE' && confBull.layers === '4/4', 'confluence fires CE when 4 layers agree');
const confWeak = checkConfluence(
    { spot: 101, vwap: 100, ema9: 99.5, ema21: 99.2, rsi: 50, momPct: 0.1, dayPct: 0.1 },
    { pcr: 1.0, atmCe: {}, atmPe: {}, walls: {} },
    O
);
ok(confWeak === null, 'confluence stays quiet below the min layers');

// ORB — CE above the range, before 11:00, RSI/EMA confirmed
const orbCe = checkOrb(
    { spot: 105, orbHigh: 103, orbLow: 99, rsi: 60, ema9: 102 },
    { pcr: 1.1 },
    O,
    10 * 60 + 30
);
ok(orbCe?.side === 'CE' && orbCe.orbBreakPct > 0.08, 'ORB fires CE on a confirmed breakout');
ok(checkOrb({ spot: 105, orbHigh: 103, orbLow: 99, rsi: 60, ema9: 102 }, { pcr: 1.1 }, O, 11 * 60 + 1) === null, 'ORB window closes after 11:00');
ok(checkOrb({ spot: 105, orbHigh: 103, orbLow: 99, rsi: 50, ema9: 102 }, { pcr: 1.1 }, O, 10 * 60 + 30) === null, 'ORB CE needs RSI >= 55');
const orbPe = checkOrb(
    { spot: 95, orbHigh: 103, orbLow: 99, rsi: 40, ema9: 98 },
    { pcr: 0.9 },
    O,
    10 * 60 + 30
);
ok(orbPe?.side === 'PE', 'ORB fires PE on a breakdown');
ok(checkOrb({ spot: 101, orbHigh: 103, orbLow: 99, rsi: 60, ema9: 102 }, { pcr: 1.1 }, O, 10 * 60 + 30) === null, 'inside the range -> no ORB');

// PCR extreme reversal
const pcrCe = checkPcrExtreme(
    { spot: 100, rsi: 40, ema9: 99, adx: 18 },
    { pcr: 1.6, walls: { support: { strike: 98 }, resistance: { strike: 103 } } },
    O
);
ok(pcrCe?.side === 'CE' && pcrCe.pcr === 1.6, 'PCR >= 1.5 with oversold RSI -> CE bounce');
ok(checkPcrExtreme({ spot: 100, rsi: 60, ema9: 99, adx: 18 }, { pcr: 1.6, walls: {} }, O) === null, 'PCR CE needs RSI <= 50');
ok(checkPcrExtreme({ spot: 100, rsi: 40, ema9: 99, adx: 30 }, { pcr: 1.6, walls: {} }, O) === null, 'strong ADX trend chops the reversal');
const pcrPe = checkPcrExtreme(
    { spot: 100, rsi: 65, ema9: 101, adx: 18 },
    { pcr: 0.4, walls: { support: { strike: 97 }, resistance: { strike: 103 } } },
    O
);
ok(pcrPe?.side === 'PE', 'PCR <= 0.5 with overbought RSI -> PE fade');

// MACD multi-timeframe
const macdBullTech = {
    mtfMacd: { ready: true, h1: { bull: true, macd: 1, signal: 0.5, aboveZero: true }, m15: { bull: true, crossUp: true, crossDown: false } },
    adx: 20, rsi: 60, ema9: 100, spot: 101,
};
ok(checkMacdMtf(macdBullTech, { pcr: 1.0 }, O)?.side === 'CE', '1H+15m bull with entry cross -> CE');
ok(checkMacdMtf(
    { ...macdBullTech, mtfMacd: { ready: true, h1: { bull: true }, m15: { bear: true } } },
    { pcr: 1.0 }, O
) === null, 'mixed timeframes -> no MACD entry');
ok(checkMacdMtf({ ...macdBullTech, adx: 14 }, { pcr: 1.0 }, O) === null, 'MACD-MTF needs ADX >= 16');
ok(checkMacdMtf(macdBullTech, { pcr: 0.6 }, O) === null, 'MACD CE needs PCR >= 0.75');
ok(checkMacdMtf({ ...macdBullTech, mtfMacd: { ready: false } }, { pcr: 1.0 }, O) === null, 'MACD-MTF skips when 1H is unavailable');

// Mean reversion — sideways chop at the Bollinger edge
ok(checkMeanRev(
    { spot: 98, adx: 12, rsi: 30, vwap: 99, bb: { upper: 110, middle: 104, lower: 98 } },
    { pcr: 1.2 }, O
)?.side === 'CE', 'low BB + oversold RSI in chop -> CE bounce');
ok(checkMeanRev(
    { spot: 98, adx: 25, rsi: 30, vwap: 99, bb: { upper: 110, middle: 104, lower: 98 } },
    { pcr: 1.2 }, O
) === null, 'mean reversion needs ADX < 20');
ok(checkMeanRev(
    { spot: 112, adx: 12, rsi: 70, vwap: 110, bb: { upper: 110, middle: 104, lower: 98 } },
    { pcr: 0.8 }, O
)?.side === 'PE', 'upper BB + overbought RSI -> PE fade');
ok(checkMeanRev(
    { spot: 104, adx: 12, rsi: 50, vwap: 104, bb: { upper: 110, middle: 104, lower: 98 } },
    { pcr: 1.0 }, O
) === null, 'mid-band price -> no mean reversion');

// confidence + quality scoring
ok(strategyConfidence(STRATEGY_KEYS.ORB, 55).pct === 62, 'ORB at neutral quality -> 62% (base)');
ok(strategyConfidence(STRATEGY_KEYS.MACD_MTF, 75).pct === 77, 'MACD-MTF strong quality -> base 69 + 8');
ok(strategyConfidence(STRATEGY_KEYS.MACD_MTF, 75).label === 'high', '>= 75 grades high');
ok(strategyConfidence(STRATEGY_KEYS.ORB, 0).pct === 40, 'confidence never drops below 40');
ok(qualityScore({ key: STRATEGY_KEYS.ORB, side: 'CE', orbBreakPct: 0.3 }, { adx: 28, ema9: 102, ema21: 100, spot: 105, rsi: 62 }, {}) >= 60, 'strong ORB setup scores high');

// ═══════════════ integration: evaluateStrategies over real bar series ═══════════════
function mkSeries({ days = 4, startClose = 100, flatBars = 3, moveTo = 108, nowMin = 10 * 60 + 30 } = {}) {
    const full5m = [];
    const dayKey = (d) => `2026-08-${String(11 + d).padStart(2, '0')}`;
    for (let d = 0; d < days; d++) {
        for (let min = 9 * 60 + 15; min <= 14 * 60 + 25; min += 5) {
            full5m.push({ ts: Date.parse(dayKey(d) + 'T00:00:00Z') + min * 60e3, min, open: startClose, high: startClose + 3, low: startClose - 3, close: startClose, volume: 1000 });
        }
    }
    const today = [];
    const push = (min, close) => {
        const bar = { ts: Date.parse(dayKey(days) + 'T00:00:00Z') + min * 60e3, min, open: close, high: close + 3, low: close - 3, close, volume: 1000 };
        full5m.push(bar);
        if (min <= nowMin) today.push(bar);
    };
    for (let i = 0; i < flatBars; i++) push(9 * 60 + 15 + i * 5, startClose);
    const step = (moveTo - startClose) / 6;
    for (let i = 0; i < 6; i++) push(9 * 60 + 30 + i * 5, startClose + step * (i + 1));
    for (let min = 10 * 60; min <= nowMin; min += 5) push(min, moveTo);
    return { full5m, today };
}

const series = mkSeries();
const tech = buildTech({ today5m: series.today, full5m: series.full5m, hourly: null, chain: { spot: 108, pcr: 1.1 }, quote: { prevClose: 100 } });
ok(tech.spot === 108, 'tech picks up the chain spot');
ok(tech.orbHigh === 103 && tech.orbLow === 97, 'ORB level = first 15m candle of today');
ok(tech.rsi !== null && tech.ema9 !== null && tech.ema21 !== null, 'rising series yields RSI/EMA');
const resampled = resample15m(series.full5m);
ok(resampled.length > 0 && resampled[0].min === 9 * 60 + 15, '5m resamples into 15m slots');

const ev = evaluateStrategies({
    chain: { spot: 108, pcr: 1.1, atmCe: {}, atmPe: {}, walls: {} },
    quote: { prevClose: 100 },
    today5m: series.today,
    full5m: series.full5m,
    hourly: null,
    nowMin: 10 * 60 + 30,
    opts: O,
});
ok(ev.evaluated === true && ev.winner?.key === 'orb', 'ORB is the winning strategy on a breakout day');
ok(ev.winner?.side === 'CE' && ev.list.length >= 1, 'winner has a side and the list is ordered');
ok(ev.winner.confidence >= 40 && ev.winner.confidence <= 92, 'winner confidence is bounded 40-92');
ok(
    ev.quiet.includes('pcr-reversal') && ev.quiet.includes('macd-mtf') && ev.quiet.includes('mean-rev'),
    'every strategy is scanned — quiet ones are reported'
);
ok(!ev.quiet.includes('orb') && !ev.quiet.includes('confluence'), 'fired strategies are not in the quiet list');

// flat day + neutral PCR -> every engine quiet, no dead-end reason shown
const flatDay = mkSeries({ moveTo: 100 });
const evFlat = evaluateStrategies({
    chain: { spot: 100, pcr: 1.0, atmCe: {}, atmPe: {}, walls: {} },
    quote: { prevClose: 100 },
    today5m: flatDay.today,
    full5m: flatDay.full5m,
    hourly: null,
    nowMin: 10 * 60 + 30,
    opts: O,
});
ok(evFlat.list.length === 0 && evFlat.winner === null, 'flat day -> no strategy fires');
ok(evFlat.quiet.length === 5, 'flat day -> all five engines reported quiet');
ok(typeof evFlat.noneReason === 'string', 'quiet day explains why in noneReason');

const evLate = evaluateStrategies({
    chain: { spot: 108, pcr: 1.1, atmCe: {}, atmPe: {}, walls: {} },
    quote: { prevClose: 100 },
    today5m: series.today,
    full5m: series.full5m,
    hourly: null,
    nowMin: 16 * 60,
    opts: O,
});
ok(evLate.evaluated === false && /last entry/.test(evLate.noneReason), 'after 15:00 the engines stop taking entries');

// ═══════════════ card renders a STRATEGY entry when the fade is quiet ═══════════════
const stratCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.30xATR from VWAP' },
    plan: null,
    strategies: {
        winner: {
            key: 'orb', name: 'ORB (Opening Range Breakout)', side: 'CE', layers: 'ORB+OI',
            strength: 'STRONG', reasons: ['ORB breakout above 24500 (+0.21%)', 'RSI 62 confirms momentum'],
            confidence: 62, confidenceLabel: 'medium', winRateTag: '~58-65%', atr15: 16.2,
        },
        list: [],
    },
});
ok(stratCard.includes('STRATEGY'), 'strategy card names the engine header');
ok(stratCard.includes('BUY CE'), 'strategy card says BUY CE');
ok(stratCard.includes('tgbot2 backtest'), 'strategy card flags the win rate as tgbot2 backtest');
ok(stratCard.includes('not re-verified'), 'strategy card is honest about the unverified edge');
ok(stratCard.includes('EXIT AT'), 'strategy card sizes an exit');
ok(stratCard.includes('STOP'), 'strategy card gives a stop');
ok(!stratCard.includes('NO ENTRY'), 'a fired strategy card is not NO ENTRY');
ok(!/lean BULLISH|lean BEARISH/.test(stratCard), 'a fired strategy card shows no chain lean');
ok(!stratCard.includes('Sizing keeps the same 1R discipline'), 'the verbose strategy footer is gone');
ok(!stratCard.includes('ALL STRATEGIES'), 'single-winner fixture renders no ranked block');

// quiet card with a strategy noneReason shows why the engines stayed quiet
const quietStratCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.30xATR from VWAP', vwap: 24400, stretch: 0.3 },
    plan: null,
    strategies: { winner: null, list: [], noneReason: 'no strategy fired — PCR mid-band, no MACD cross' },
});
ok(quietStratCard.includes('NO ENTRY'), 'all-quiet card still says NO ENTRY');
ok(quietStratCard.includes('🧩 Strategies:'), 'all-quiet card says why the strategies stayed quiet');

// ranked-list variant: winner block + all strategies with their status
const rankedCard = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup - 0.30xATR from VWAP' },
    plan: null,
    strategies: {
        winner: {
            key: 'orb', name: 'ORB (Opening Range Breakout)', side: 'CE', layers: 'ORB+OI',
            strength: 'STRONG', reasons: ['ORB breakout above 24500 (+0.21%)'],
            confidence: 64, confidenceLabel: 'medium', winRateTag: '~58-65%', atr15: 16.2,
        },
        list: [
            { key: 'orb', name: 'ORB (Opening Range Breakout)', side: 'CE', score: 60, confidence: 64, confidenceLabel: 'medium' },
            { key: 'confluence', name: 'EMA+RSI+OI+VWAP Confluence', side: 'CE', score: 57, confidence: 67, confidenceLabel: 'high' },
        ],
        quiet: ['pcr-reversal', 'macd-mtf', 'mean-rev'],
    },
});
ok(rankedCard.includes('ALL STRATEGIES (ranked)'), 'ranked card shows the all-strategies block');
ok(rankedCard.includes('1️⃣ ORB · BUY CE'), 'ranked card lists the winner first');
ok(rankedCard.includes('2️⃣ Confluence · BUY CE'), 'ranked card lists the runner-up');
ok(rankedCard.includes('➖ PCR Reversal · no setup'), 'ranked card marks quiet strategies');
ok(rankedCard.includes('➖ MACD-MTF · no setup'), 'ranked card marks MACD-MTF quiet');
ok(rankedCard.includes('➖ Mean Reversion · no setup'), 'ranked card marks Mean Reversion quiet');
ok(!rankedCard.includes('Sizing keeps the same 1R discipline'), 'ranked card has no verbose footer either');

console.log(`\ncheck-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
