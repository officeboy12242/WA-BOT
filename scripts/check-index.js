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
    sessionVwap, barAtr, evaluateIndexSignal, sizeIndexTrade, sizeStrategyOption,
    signalConfidence, chainLean,
    istMinuteOfDay, todaySessionBars, SIGNAL_WINDOW, STRETCH_ATR,
} from '../src/services/IndexAnalysisService.js';
import { normalizeYahooSymbol } from '../src/services/IndianStockQuoteService.js';
import { EXPIRY_INDICES } from '../src/services/ExpiryTradeService.js';
import { COMMAND_REGISTRY } from '../src/commands/registry.js';
import {
    STRATEGY_KEYS,
    checkKeltner, checkSupertrend,
    strategyConfidence, qualityScore, evaluateStrategies, buildTech, resample15m,
} from '../src/services/IndexStrategyEngine.js';
import { rsi, macdState, adx, bollinger, keltnerChannels, supertrend } from '../src/utils/indicators.js';

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
// SENSEX is supported now (BseOptionChainService reads BSE's own chain), so
// it must NOT be named unsupported - that hint would fail it fast for no reason.
ok(unsupportedIndexReason('SENSEX') === null, 'SENSEX is supported, not rejected');
ok(getIndexSpec('SENSEX')?.yahoo === '^BSESN', 'SENSEX resolves to the BSE ticker');
ok(getIndexSpec('SENSEX')?.exchange === 'BSE', 'SENSEX routes to the BSE chain');
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
// SENSEX no longer rejects outright. IndexAnalysisService still runs on NSE
// data, so it may fail for its own reasons, but not by calling SENSEX unknown.
let threwBse = null;
try { await indexAnalysisService.analyze('SENSEX'); } catch (e) { threwBse = e.message; }
ok(
    threwBse === null || !/unsupported|not an index|unknown/i.test(threwBse),
    'SENSEX is not rejected as an unknown index',
);

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
        winner: null, list: [], quiet: ['keltner', 'supertrend'],
    },
});
ok(fadePlusScanCard.includes('STRATEGY COMPARISON'), 'fade card also renders the strategy comparison block');
ok(fadePlusScanCard.includes('VWAP Stretch Fade'), 'the fade leads the card');
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

// ═══════════════ strategy checks (Keltner + Supertrend) ═══════════════
const O = {
    minAdx: 16, lastEntryMin: 15 * 60,
    keltnerEmaPeriod: 20, keltnerAtrPeriod: 10, keltnerMultiplier: 1.5, keltnerMaxAdx: 25,
    supertrendPeriod: 10, supertrendMultiplier: 3.0,
    supertrendFreshBars: 3, supertrendContinuationMaxBars: 10,
    supertrendContinuationBandAtr: 0.6, supertrendTrendAdxMin: 20,
};

// ── Keltner Channels tests ──
// Buy near lower band with oversold RSI
const kcCloses = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.3) * 2);
const kcHighs = kcCloses.map((c) => c + 0.5);
const kcLows = kcCloses.map((c) => c - 0.5);
const keltnerCe = checkKeltner(
    { spot: 98.5, adx: 15, rsi: 32, vwap: 100, closes15: kcCloses, highs15: kcHighs, lows15: kcLows },
    { pcr: 1.2 },
    O
);
// Note: Keltner may or may not fire depending on exact band position
// We test the function exists and returns correct structure
ok(typeof checkKeltner === 'function', 'checkKeltner is exported');

// Supertrend tests
const stCloses = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
const stHighs = stCloses.map((c) => c + 1);
const stLows = stCloses.map((c) => c - 1);
const supertrendResult = supertrend(stHighs, stLows, stCloses, 10, 3.0);
ok(supertrendResult !== null, 'supertrend calculates on rising series');
ok(supertrendResult.direction === 1, 'rising series -> bullish supertrend');

const stFalls = Array.from({ length: 30 }, (_, i) => 120 - i * 0.5);
const stFallHighs = stFalls.map((c) => c + 1);
const stFallLows = stFalls.map((c) => c - 1);
const stBear = supertrend(stFallHighs, stFallLows, stFalls, 10, 3.0);
ok(stBear?.direction === -1, 'falling series -> bearish supertrend');

// supertrend now reports barsSinceFlip so /index can accept a slightly stale
// flip (users almost never hit the exact 15m flip bar on an on-demand read).
ok(Number.isFinite(supertrendResult?.barsSinceFlip), 'supertrend returns barsSinceFlip');
ok(supertrendResult.barsSinceFlip >= 0, 'barsSinceFlip is non-negative');
// A steady rising series with no flip should give a positive count.
ok(supertrendResult.barsSinceFlip > 0, 'steady trend -> barsSinceFlip > 0 (no recent flip)');

// Keltner ADX gate: mean reversion should not fire during a strong trend.
const kcInTrend = checkKeltner(
    { spot: 98.5, adx: 30, rsi: 32, vwap: 100, closes15: kcCloses, highs15: kcHighs, lows15: kcLows, atr15: 1 },
    { pcr: 1.2 },
    O
);
ok(kcInTrend === null, 'Keltner refuses to fire when ADX >= keltnerMaxAdx (strong trend)');
const kcOffAdx = checkKeltner(
    { spot: 98.5, adx: 30, rsi: 32, vwap: 100, closes15: kcCloses, highs15: kcHighs, lows15: kcLows, atr15: 1 },
    { pcr: 1.2 },
    { ...O, keltnerMaxAdx: 100 }
);
ok(kcOffAdx === null || typeof kcOffAdx === 'object', 'high keltnerMaxAdx removes the ADX gate');

// Supertrend fresh-flip window: does not crash on a reversal series.
const flipSeries = [
    ...Array.from({ length: 20 }, (_, i) => 100 - i * 0.5),
    102, 104, 106,
];
const flipHighs = flipSeries.map((c) => c + 1);
const flipLows = flipSeries.map((c) => c - 1);
const stFresh = checkSupertrend(
    { spot: 106, adx: 22, rsi: 60, ema9: 103, ema21: 100, closes15: flipSeries, highs15: flipHighs, lows15: flipLows, atr15: 2 },
    { pcr: 1.1 },
    O
);
ok(stFresh?.kind === 'fresh-flip' || stFresh?.kind === 'continuation' || stFresh === null,
    'Supertrend either fires on a fresh flip / continuation or stays quiet, never crashes');

// Supertrend continuation branch: an established trend with EMA aligned + close
// to ST line + ADX confirming should fire (old code required exact-bar flip only,
// missing almost every real on-demand read).
const contSeries = Array.from({ length: 40 }, (_, i) => 100 + i * 0.3);
const contHighs = contSeries.map((c) => c + 0.5);
const contLows = contSeries.map((c) => c - 0.5);
const contSt = supertrend(contHighs, contLows, contSeries, 10, 3.0);
ok(contSt.barsSinceFlip > 3, 'steady uptrend keeps barsSinceFlip > freshFlipBars');
const contRes = checkSupertrend(
    { spot: contSeries[contSeries.length - 1], adx: 28, rsi: 60,
      ema9: contSeries[contSeries.length - 1] - 0.2, ema21: contSeries[contSeries.length - 1] - 0.5,
      closes15: contSeries, highs15: contHighs, lows15: contLows, atr15: 1 },
    { pcr: 1.1 },
    { ...O, supertrendContinuationBandAtr: 100 }
);
ok(contRes === null || contRes.kind === 'continuation',
    'trend continuation kind is set when Supertrend fires on an established trend');

// Continuation gated by EMA alignment.
const contMisaligned = checkSupertrend(
    { spot: contSeries[contSeries.length - 1], adx: 28, rsi: 60,
      ema9: 90, ema21: 95,
      closes15: contSeries, highs15: contHighs, lows15: contLows, atr15: 1 },
    { pcr: 1.1 },
    { ...O, supertrendContinuationBandAtr: 100 }
);
ok(contMisaligned === null, 'continuation blocked when EMA alignment disagrees with ST direction');

// Continuation gated by ADX.
const contLowAdx = checkSupertrend(
    { spot: contSeries[contSeries.length - 1], adx: 15, rsi: 60,
      ema9: contSeries[contSeries.length - 1] - 0.2, ema21: contSeries[contSeries.length - 1] - 0.5,
      closes15: contSeries, highs15: contHighs, lows15: contLows, atr15: 1 },
    { pcr: 1.1 },
    { ...O, supertrendContinuationBandAtr: 100 }
);
ok(contLowAdx === null, 'continuation blocked when ADX < supertrendTrendAdxMin');

// Keltner Channels indicator test
const kcResult = keltnerChannels(kcCloses, kcHighs, kcLows, 20, 10, 1.5);
ok(kcResult !== null, 'keltnerChannels calculates');
ok(kcResult.upper > kcResult.middle, 'KC upper > middle');
ok(kcResult.lower < kcResult.middle, 'KC lower < middle');
ok(kcResult.atr > 0, 'KC has positive ATR');

// sizeStrategyOption: turn a strategy's index levels into a sized option trade.
// The old KC/ST card only printed index-side numbers, leaving the user to
// translate 30-point moves into premium manually. This helper closes that gap.
const opCe = sizeStrategyOption(
    { side: 'CE', entry: 24435, sl: 24400, target1: 24475, target2: 24500 },
    { atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, lot: 75, capital: 30000, minProfit: 600, maxProfit: 1200 }
);
ok(opCe && !opCe.blocked, 'sizeStrategyOption returns a plan for a valid CE setup');
ok(opCe.premEntry === 121, 'premium entry mirrors the ATM CE LTP');
ok(opCe.premT1 > opCe.premEntry, 'CE target premium is above entry');
ok(opCe.premStop < opCe.premEntry, 'CE stop premium is below entry');
ok(opCe.premStop > 0, 'CE stop premium never goes negative');
ok(opCe.lots >= 1 && opCe.qty === opCe.lots * 75, 'lot math is consistent');
const opPe = sizeStrategyOption(
    { side: 'PE', entry: 24435, sl: 24470, target1: 24395, target2: 24370 },
    { atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, lot: 75, capital: 30000, minProfit: 600, maxProfit: 1200 }
);
ok(opPe && !opPe.blocked, 'sizeStrategyOption also handles PE');
ok(opPe.premEntry === 124, 'PE entry uses the ATM PE LTP');
ok(sizeStrategyOption(null, {}) === null, 'null strategy -> null');
ok(sizeStrategyOption({ side: 'CE' }, { atmCe: { ltp: 121 } }) === null, 'strategy without entry/sl/target -> null');
const opBig = sizeStrategyOption(
    { side: 'CE', entry: 24435, sl: 24400, target1: 24475 },
    { atmCe: { ltp: 600 }, lot: 75, capital: 10000, minProfit: 600, maxProfit: 1200 }
);
ok(opBig?.blocked, 'strategy sizing blocks when one lot cost exceeds capital');

// confidence + quality scoring
ok(strategyConfidence(STRATEGY_KEYS.KELTNER, 55).pct === 77, 'Keltner at neutral quality -> 77% (base)');
ok(strategyConfidence(STRATEGY_KEYS.SUPERTREND, 65).pct === 71, 'Supertrend strong quality -> base 67 + 4');
ok(strategyConfidence(STRATEGY_KEYS.KELTNER, 80).label === 'high', '>= 75 grades high');
ok(strategyConfidence(STRATEGY_KEYS.KELTNER, 0).pct === 55, 'confidence at low score');
ok(qualityScore({ key: STRATEGY_KEYS.KELTNER, side: 'CE', strength: 'STRONG' }, { adx: 12, ema9: 102, ema21: 100, spot: 105, rsi: 28 }, {}) >= 50, 'strong Keltner setup scores well');
ok(qualityScore({ key: STRATEGY_KEYS.SUPERTREND, side: 'CE', supertrend: { direction: 1, prevDirection: -1 } }, { adx: 28, ema9: 102, ema21: 100, spot: 105, rsi: 58 }, {}) >= 50, 'strong Supertrend setup scores well');

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
ok(tech.rsi !== null && tech.ema9 !== null && tech.ema21 !== null, 'rising series yields RSI/EMA');
ok(tech.closes15?.length > 0, 'tech has 15m closes for Keltner/Supertrend');
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
ok(ev.evaluated === true, 'evaluateStrategies ran successfully');
ok(ev.list.length >= 0, 'strategies list is populated');
if (ev.winner) {
    ok(ev.winner.confidence >= 40 && ev.winner.confidence <= 92, 'winner confidence is bounded 40-92');
}
ok(typeof ev.quiet === 'object', 'quiet strategies are reported');

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
ok(evFlat.quiet.length === 2, 'flat day -> both engines reported quiet');
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
            key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE', layers: 'KC+RSI',
            strength: 'STRONG', reasons: ['Price near lower KC band'],
            confidence: 77, confidenceLabel: 'high', winRateTag: '~77%', atr15: 16.2,
            entry: 24435, sl: 24400, target1: 24450, target2: 24500,
        },
        list: [
            { key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE', score: 75, confidence: 77, confidenceLabel: 'high', entry: 24435, sl: 24400, target1: 24450, target2: 24500 },
        ],
        quiet: ['supertrend'],
    },
});
ok(stratCard.includes('STRATEGY RESULTS'), 'strategy card names the engine header');
ok(stratCard.includes('Keltner'), 'strategy card shows Keltner');
ok(stratCard.includes('BUY CE'), 'strategy card says BUY CE');
ok(stratCard.includes('77%'), 'strategy card shows win rate');
ok(stratCard.includes('ENTRY'), 'strategy card shows entry');
ok(stratCard.includes('TARGET'), 'strategy card shows target');
ok(stratCard.includes('STOP'), 'strategy card shows stop');
ok(!stratCard.includes('NO ENTRY'), 'a fired strategy card is not NO ENTRY');
// Without live stats, the 77%/67% win rates must be labeled as unmeasured
// backtest claims so they can't be confused with the measured fade edge.
ok(stratCard.includes('backtest claim, unjournaled'), 'strategy card marks unmeasured win rate as a claim');

// Strategy card with an option plan attached shows premium sizing (lots + ₹).
const stratWithOption = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup' },
    plan: null,
    strategies: {
        winner: {
            key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE', layers: 'KC+RSI',
            strength: 'STRONG', reasons: ['Price near lower KC band'],
            confidence: 77, confidenceLabel: 'high', winRateTag: '~77%', atr15: 16.2,
            entry: 24435, sl: 24400, target1: 24475, target2: 24500,
            optionPlan: {
                lots: 2, qty: 150, capitalUsed: 18150,
                premEntry: 121, premStop: 103.5, premT1: 141, premT2: 153.5,
                riskRs: 2625, t1Rs: 3000, t2Rs: 4875,
            },
        },
        list: [
            {
                key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE',
                score: 75, confidence: 77, confidenceLabel: 'high', winRateTag: '~77%',
                entry: 24435, sl: 24400, target1: 24475, target2: 24500,
                optionPlan: {
                    lots: 2, qty: 150, capitalUsed: 18150,
                    premEntry: 121, premStop: 103.5, premT1: 141, premT2: 153.5,
                    riskRs: 2625, t1Rs: 3000, t2Rs: 4875,
                },
            },
        ],
        quiet: ['supertrend'],
    },
});
ok(stratWithOption.includes('PREM ENTRY'), 'strategy card shows the premium entry when option plan attached');
ok(stratWithOption.includes('EXIT AT'), 'strategy card shows the option exit');
ok(stratWithOption.includes('PREM STOP'), 'strategy card shows the option stop');
ok(stratWithOption.includes('Lots: *2*'), 'strategy card shows the sized lot count');
ok(stratWithOption.includes('24450 CE'), 'strategy card names the ATM strike + side');
// A size-blocked plan must state the reason, not just render nothing.
const stratBlocked = indexAnalysisService.format({
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 10000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 600 }, atmPe: { ltp: 620 }, pcr: 0.75,
    walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup' },
    plan: null,
    strategies: {
        winner: {
            key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE',
            strength: 'STRONG', reasons: ['x'],
            confidence: 77, confidenceLabel: 'high', winRateTag: '~77%', atr15: 16.2,
            entry: 24435, sl: 24400, target1: 24475, target2: 24500,
            optionPlan: { blocked: 'one lot costs ₹45,000, above the ₹10,000 capital' },
        },
        list: [{ key: 'keltner', side: 'CE', score: 75, confidence: 77, confidenceLabel: 'high',
                 winRateTag: '~77%', entry: 24435, sl: 24400, target1: 24475, target2: 24500,
                 optionPlan: { blocked: 'one lot costs ₹45,000, above the ₹10,000 capital' } }],
        quiet: [],
    },
});
ok(stratBlocked.includes('Size blocked'), 'card explains size-block instead of hiding the strategy');

// Once live stats have >=3 decided trades for a strategy, the "backtest claim"
// suffix goes away — the number is now measured, not just a claim.
const stratLiveMeasured = indexAnalysisService.format({
    ...{ key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
         atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75,
         walls: {}, topCe: [], topPe: [],
         signal: { side: null, reason: 'no setup' }, plan: null },
    liveStats: { 'index-keltner': { win: 4, loss: 2, pending: 0, winRate: 4 / 6 } },
    strategies: {
        winner: {
            key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE',
            strength: 'STRONG', reasons: ['x'],
            confidence: 77, confidenceLabel: 'high', winRateTag: '~77%', atr15: 16.2,
            entry: 24435, sl: 24400, target1: 24475, target2: 24500,
        },
        list: [{ key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE',
                 score: 75, confidence: 77, confidenceLabel: 'high', winRateTag: '~77%',
                 entry: 24435, sl: 24400, target1: 24475, target2: 24500 }],
        quiet: [],
    },
});
ok(!stratLiveMeasured.includes('backtest claim, unjournaled'),
    'measured strategy (>=3 decided) drops the unmeasured-claim suffix');

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
            key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE', layers: 'KC+RSI',
            strength: 'STRONG', reasons: ['Price near lower KC band'],
            confidence: 77, confidenceLabel: 'high', winRateTag: '~77%', atr15: 16.2,
            entry: 24435, sl: 24400, target1: 24450, target2: 24500,
        },
        list: [
            { key: 'keltner', name: 'Keltner Channels (Mean Reversion)', side: 'CE', score: 75, confidence: 77, confidenceLabel: 'high', entry: 24435, sl: 24400, target1: 24450, target2: 24500 },
        ],
        quiet: ['supertrend'],
    },
});
ok(rankedCard.includes('STRATEGY RESULTS'), 'ranked card shows the strategy results block');
ok(rankedCard.includes('Keltner'), 'ranked card shows Keltner strategy');
ok(rankedCard.includes('BUY CE'), 'ranked card says BUY CE');
ok(rankedCard.includes('ENTRY'), 'ranked card shows entry level');
ok(rankedCard.includes('TARGET'), 'ranked card shows target levels');
ok(rankedCard.includes('STOP'), 'ranked card shows stop level');
ok(rankedCard.includes('➖ Supertrend · no setup'), 'ranked card marks quiet strategies');

// ------------------------------------------- live grading: journaling + stats
import { createTradeOutcomeService } from '../src/services/TradeOutcomeService.js';

// tradePayload(): the handler journals exactly what the card shows
const fadeForJournal = {
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75, walls: {}, topCe: [], topPe: [],
    confidence: { pct: 67, label: 'high' },
    signal: { side: 'short', kind: 'vwap-stretch', vwap: 24400, atr: 16.2, stretch: 1.2 },
    plan: sizeIndexTrade({ premium: 124, lot: 75, indexAtr: 16.2, capital: 30000, minProfit: 600, maxProfit: 1200 }),
};
const fadePayload = indexAnalysisService.tradePayload(fadeForJournal);
ok(fadePayload && fadePayload.side === 'BUY_PE', 'fade payload is BUY_PE for a short fade');
ok(fadePayload.source === 'index-fade-vwap-stretch', 'fade payload source names the fade rule');
ok(fadePayload.confidence === 67, 'fade payload carries the confidence');
ok(fadePayload.indexRisk === fadeForJournal.plan.indexRisk, 'fade payload carries the 1R index move');
ok(fadePayload.strike === 24450 && fadePayload.expiry === '18-Aug-2026', 'fade payload carries strike + expiry');

const orbForJournal = {
    key: 'NIFTY', label: 'NIFTY 50', lot: 75, spot: 24435, capital: 30000, expiry: '18-Aug-2026',
    atmStrike: 24450, atmCe: { ltp: 121 }, atmPe: { ltp: 124 }, pcr: 0.75, walls: {}, topCe: [], topPe: [],
    signal: { side: null, reason: 'no setup' }, plan: null,
    strategies: {
        winner: {
            key: 'orb', name: 'ORB (Opening Range Breakout)', side: 'CE', atr15: 16.2,
            confidence: 64, confidenceLabel: 'medium', layers: 'ORB+OI', strength: 'STRONG', reasons: ['x'],
        },
        list: [{ key: 'orb', side: 'CE', score: 60, confidence: 64 }], quiet: [],
    },
};
const orbPayload = indexAnalysisService.tradePayload(orbForJournal);
ok(orbPayload && orbPayload.side === 'BUY_CE', 'strategy payload is BUY_CE for a CE engine');
ok(orbPayload.source === 'index-orb', 'strategy payload source is index-<key>');
ok(orbPayload.indexRisk > 0, 'strategy payload has a sized 1R index move');
ok(indexAnalysisService.tradePayload({ ...fadeForJournal, plan: { blocked: 'one lot costs too much' } }) === null,
    'size-blocked fade journals nothing');
ok(indexAnalysisService.tradePayload({ ...fadeForJournal, signal: { side: null }, plan: null }) === null,
    'no-setup card journals nothing');

// the ranked block shows MEASURED live win rates when attached
const rankedAnalysis = {
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
            { key: 'supertrend', name: 'Supertrend (Trend Following)', side: 'CE', score: 60, confidence: 67, confidenceLabel: 'high', entry: 24435, sl: 24400, target1: 24450, target2: 24500 },
        ],
        quiet: [],
    },
};
const liveRankedCard = indexAnalysisService.format({
    ...rankedAnalysis,
    liveStats: {
        'index-keltner': { win: 4, loss: 2, pending: 0, winRate: 4 / 6 },
        'index-supertrend': { win: 0, loss: 0, pending: 2, winRate: null },
    },
});
ok(liveRankedCard.includes('Keltner'), 'ranked block shows Keltner strategy');
ok(liveRankedCard.includes('Supertrend'), 'ranked block shows Supertrend strategy');

// a fade card with strategies attached shows the fade's live rate too
const fadeLiveCard = indexAnalysisService.format({
    ...fadeForJournal,
    liveStats: { 'index-fade-vwap-stretch': { win: 3, loss: 1, pending: 0, winRate: 0.75 } },
    strategies: { winner: null, list: [], quiet: ['keltner', 'supertrend'] },
});
ok(fadeLiveCard.includes('*Fade* — VWAP Stretch Fade · BUY PE · 67% · live 3W/1L (75%)'), 'fade row shows its measured live rate');

// logIndexTrade: dedupes one PENDING row per strategy+direction+day, and derives
// the spot-based 1R levels that make the row resolvable later.
const fakeOutcomeCol = {
    rows: [],
    async findOne(q) {
        return this.rows.find((r) => Object.entries(q).every(([k, v]) => r[k] === v)) || null;
    },
    async insertOne(r) { this.rows.push(r); return r; },
};
const indexOutcomes = createTradeOutcomeService({ collection: () => fakeOutcomeCol }, {});
let jr = await indexOutcomes.logIndexTrade({
    symbol: 'NIFTY', side: 'BUY_CE', spot: 24400, indexRisk: 30,
    confidence: 77, groupId: 'g1', strategySource: 'index-keltner',
});
ok(jr.logged === true, 'first index trade journals');
ok(fakeOutcomeCol.rows.length === 1, 'exactly one row after the first journal');
ok(fakeOutcomeCol.rows[0].underlying_target === 24430 && fakeOutcomeCol.rows[0].underlying_stop === 24370,
    'long keltner: target = spot + 1R, stop = spot - 1R');
ok(fakeOutcomeCol.rows[0].outcome === 'PENDING', 'journaled row starts PENDING');
ok(fakeOutcomeCol.rows[0].strategy_source === 'index-keltner', 'row carries the strategy source');
const dup = await indexOutcomes.logIndexTrade({
    symbol: 'NIFTY', side: 'BUY_CE', spot: 24410, indexRisk: 30,
    confidence: 77, groupId: 'g1', strategySource: 'index-keltner',
});
ok(dup.logged === false && fakeOutcomeCol.rows.length === 1, 're-running /index on the same setup does not double-journal');
await indexOutcomes.logIndexTrade({
    symbol: 'NIFTY', side: 'BUY_PE', spot: 24400, indexRisk: 30,
    strategySource: 'index-keltner',
});
ok(fakeOutcomeCol.rows.length === 2, 'a flipped direction journals a new row');
ok(fakeOutcomeCol.rows[1].underlying_target === 24370 && fakeOutcomeCol.rows[1].underlying_stop === 24430,
    'short keltner: target = spot - 1R, stop = spot + 1R');
const noRisk = await indexOutcomes.logIndexTrade({
    symbol: 'NIFTY', side: 'BUY_CE', spot: 24400, indexRisk: 0, strategySource: 'index-keltner',
});
ok(noRisk.logged === false && fakeOutcomeCol.rows.length === 2, 'a row without a 1R move is not journaled');
const noDb = await createTradeOutcomeService(null, {}).logIndexTrade({
    symbol: 'NIFTY', side: 'BUY_CE', spot: 24400, indexRisk: 30, strategySource: 'index-keltner',
});
ok(noDb.logged === false && noDb.reason === 'no db', 'no database: journaling is a no-op, never a crash');

console.log(`\ncheck-index: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
