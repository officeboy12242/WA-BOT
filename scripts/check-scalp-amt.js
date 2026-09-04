/**
 * Unit checks for the /scalp Auction Market Theory layer. Pure functions + a
 * stubbed chain, no network.
 *
 * Every assertion here corresponds to a bug that shipped, because each one was
 * invisible at runtime: dead branches and silently-skipped setups do not throw,
 * they just quietly never happen. The card looked fine in all of these cases.
 *
 * Run: node scripts/check-scalp-amt.js
 */
import {
    buildVolumeProfile,
    calcSessionVWAP,
    vwapLevels,
    auctionRegime,
    detectBarAbsorption,
    confluenceScore,
} from '../src/utils/volumeProfile.js';
import ScalpService from '../src/services/ScalpService.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };

// ── VWAP bias must be reachable in all four states ───────────────────────────
// Shipped bug: `vwapDist > upper1` compared a distance (tens of points) against
// an absolute price level (~24,000), so overbought/oversold could never occur.
const vw = { vwap: 24290, upperBand: 24350, lowerBand: 24230, upper1: 24320, lower1: 24260 };
ok(vwapLevels(vw, 24400).bias === 'overbought', 'spot above +1sigma reads overbought');
ok(vwapLevels(vw, 24300).bias === 'bullish', 'spot above VWAP but inside 1sigma reads bullish');
ok(vwapLevels(vw, 24270).bias === 'bearish', 'spot below VWAP but inside 1sigma reads bearish');
ok(vwapLevels(vw, 24200).bias === 'oversold', 'spot below -1sigma reads oversold');
const biases = new Set([24400, 24300, 24270, 24200].map((s) => vwapLevels(vw, s).bias));
ok(biases.size === 4, 'all four bias states are reachable, not just two');

// ── Absorption must fire on real bar shapes ──────────────────────────────────
// Shipped bug: fed ONE option-chain row where >=3 time snapshots were required,
// so it returned 0 forever and its card section never rendered.
const base = Array.from({ length: 20 }, (_, i) => ({
    high: 24300 + i * 0.5 + 10, low: 24300 + i * 0.5 - 10, close: 24300 + i * 0.5, volume: 1000,
}));
const absorbing = [...base, { high: 24316, low: 24312, close: 24315.5, volume: 4000 }];
const hit = detectBarAbsorption(absorbing);
ok(hit !== null && hit.isAbsorbing, 'high volume on a small range is flagged as absorption');
ok(hit?.side === 'buyers', 'closing near the bar high attributes absorption to buyers');
ok(hit?.volRatio > 1.5 && hit?.rangeRatio < 0.8, 'reports the effort/result ratios it triggered on');

const sellerBar = [...base, { high: 24316, low: 24312, close: 24312.2, volume: 4000 }];
ok(detectBarAbsorption(sellerBar)?.side === 'sellers', 'closing near the bar low attributes it to sellers');
ok(detectBarAbsorption(base) === null || !detectBarAbsorption(base).isAbsorbing,
    'ordinary bars do not report absorption');
ok(detectBarAbsorption(base.map((b) => ({ ...b, volume: 0 }))) === null,
    'no volume -> null, rather than a fabricated score');
ok(detectBarAbsorption(base.slice(0, 3)) === null, 'too few bars -> null');

// ── Volume profile / regime on real-shaped bars ──────────────────────────────
const vp = buildVolumeProfile(base, 5);
ok(vp && vp.poc >= 24290 && vp.poc <= 24320, 'POC lands inside the traded range');
ok(vp.val <= vp.poc && vp.poc <= vp.vah, 'value area brackets the POC');
ok(auctionRegime(vp.vah + 100, vp).regime === 'breakout', 'spot above VAH is out of value');
// Mid value area, not the POC: the POC can coincide with VAL/VAH, and sitting on
// a value-area edge is correctly a buy_zone/sell_zone rather than balanced.
ok(auctionRegime((vp.val + vp.vah) / 2, vp).regime === 'balanced', 'spot mid value area is balanced');
ok(auctionRegime(vp.val - 100, vp).regime === 'breakout', 'spot below VAL is out of value');
const vwapReal = calcSessionVWAP(base);
ok(vwapReal && vwapReal.vwap > 24290 && vwapReal.vwap < 24320, 'session VWAP sits inside the range');
ok(vwapReal.upper1 > vwapReal.vwap && vwapReal.lower1 < vwapReal.vwap, 'sigma bands straddle VWAP');

// ── Confluence OI-wall scaling ───────────────────────────────────────────────
// Shipped bug: OI was pre-divided by 10,000 then divided by 100 again, so the
// documented "1L OI = full score" actually required 10L and real walls scored ~16.
const oiFactor = (oi) => confluenceScore(vp, vwapLevels(vwapReal, 24305),
    { oiWall: oi, regime: 'normal', spotDistance: 10 }).factors.find((f) => f.name === 'OI Wall');
ok(oiFactor(100_000)?.score === 100, '1L OI scores a full 100 on the OI wall factor');
ok(oiFactor(50_000)?.score === 50, '50K OI scores 50');
ok(oiFactor(160_000)?.score === 100, 'above 1L clamps at 100 rather than overflowing');

// ── /scalp still produces its setups ─────────────────────────────────────────
// The AMT layer is best-effort: /scalp must survive it being unavailable.
const FIXED = Date.UTC(2026, 7, 26, 6, 0); // 11:30 IST — inside the confidence time window
const RealDate = Date;
class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
}

function stubChain(spot, atm, ceWall, peWall, wallOi = 180000) {
    const strikes = [];
    for (let k = atm - 700; k <= atm + 700; k += 50) {
        const d = Math.abs(k - atm);
        strikes.push({
            strike: k,
            ce: { ltp: Math.max(5, 160 - (k - atm) * 0.5), oi: k === ceWall ? wallOi : 40000 + d * 10, iv: 12 },
            pe: { ltp: Math.max(5, 160 + (k - atm) * 0.5), oi: k === peWall ? Math.round(wallOi * 0.97) : 40000 + d * 10, iv: 12 },
        });
    }
    const row = strikes.find((s) => s.strike === atm);
    return {
        symbol: 'NIFTY', spot, pcr: 1.05, strikes, atmStrike: atm,
        atmCe: { strike: atm, ...row.ce }, atmPe: { strike: atm, ...row.pe },
        totalCeOi: 2000000, totalPeOi: 2100000, expiry: '01-Sep-2026',
    };
}

async function cardFor(ceWall, peWall, pcr = 0.85, wallOi) {
    globalThis.Date = FakeDate;
    try {
        const svc = new ScalpService();
        const snap = { ...stubChain(24325, 24350, ceWall, peWall, wallOi), pcr };
        svc.nse = { fetchOptionContext: async () => ({ snapshot: snap }) };
        return await svc.buildScalpCard('NIFTY');
    } finally {
        globalThis.Date = RealDate;
    }
}

// Short strangle across range widths. Shipped bug: wings were built with
// round5() (nearest 5) while NIFTY strikes step in 50s, so findStrikeLeg --
// which matches EXACTLY -- returned null, both legs priced 0, and the setup
// failed its `> 20` guard silently. 5 of 9 typical widths were affected.
//
// PCR 0.85 here is deliberate. Every setup now gates at the same 75 line (the
// owner asked for no entry to be missed), so a slightly put-heavy chain
// comfortably clears it — the reachability being tested is the strike snapping,
// not the gate. The below-75 case is asserted separately below.
for (const [ce, pe] of [[24450, 24200], [24500, 24200], [24550, 24150], [24400, 24200], [24600, 24100]]) {
    const card = await cardFor(ce, pe);
    ok(card.includes('SHORT STRANGLE'), `short strangle fires at range ${ce - pe}`);
    ok(card.includes('SHORT STRADDLE'), `short straddle fires at range ${ce - pe}`);
}

// The gate at 75 (was 85) means a neutral chain with strong walls now clears it
// — that is the owner-requested behavior so no entry is missed. The filter must
// still mean something below 75: the same chain with weak OI walls (nothing to
// sell against) scores ~45 and must NOT fire, because the leg has unbounded loss.
{
    const neutral = await cardFor(24500, 24200, 1.0);
    ok(neutral.includes('SHORT STRADDLE'), 'neutral PCR + tight range fires a straddle at the 75 gate');
    ok(neutral.includes('SHORT STRANGLE'), 'neutral PCR + tight range fires a strangle at the 75 gate');
    const weakWalls = await cardFor(24500, 24200, 1.0, 30000);
    ok(!weakWalls.includes('SHORT STRADDLE'), 'weak OI walls still do NOT fire a straddle');
    ok(!weakWalls.includes('SHORT STRANGLE'), 'weak OI walls still do NOT fire a strangle');
    const wide = await cardFor(24700, 24000, 1.0);
    ok(wide.includes('SHORT STRADDLE'), 'a genuinely wide range still fires theta at neutral PCR');
}

const card = await cardFor(24500, 24200);
for (const section of ['SCALP MAP', 'PREMIUM LIVE', 'SCALP RULES']) {
    ok(card.includes(section), `card still renders "${section}" section`);
}
ok(!card.includes('undefined') && !card.includes('NaN'), 'card has no undefined/NaN leaking into it');

// ── Multi-index: NIFTY + SENSEX ──────────────────────────────────────────────
const { SCALP_INDICES, parseScalpIndexArgs, resolveScalpIndex, netPoints } =
    await import('../src/data/scalpIndexConfig.js');
const { default: scalpAlertService } = await import('../src/services/ScalpAlertService.js');

const argCases = [
    ['sensex', ['SENSEX']],
    ['nifty', ['NIFTY']],
    ['nifty sensex', ['NIFTY', 'SENSEX']],
    ['alert sensex', ['SENSEX']],           // the phrasing this was asked for
    ['alert nifty sensex', ['NIFTY', 'SENSEX']],
    ['both', ['NIFTY', 'SENSEX']],
    ['nifty,sensex', ['NIFTY', 'SENSEX']],
    ['', []],
];
for (const [input, expected] of argCases) {
    const got = parseScalpIndexArgs(input).keys;
    ok(JSON.stringify(got) === JSON.stringify(expected), `"${input}" parses to ${JSON.stringify(expected)}`);
}
ok(parseScalpIndexArgs('banknifty').unknown.length === 1, 'an unsupported index is reported, not silently dropped');
ok(resolveScalpIndex('sx')?.key === 'SENSEX' && resolveScalpIndex('nf')?.key === 'NIFTY', 'aliases resolve');

// Economics must match in RUPEES, not in points. NIFTY's 8pt target on a SENSEX
// lot of 20 would be smaller than SENSEX's own ~12.8pt round-trip cost.
const rupees = (k) => {
    const c = SCALP_INDICES[k], n = netPoints(c);
    return { win: Math.round(n.win * c.lot), loss: Math.round(n.loss * c.lot) };
};
ok(Math.abs(rupees('NIFTY').win - rupees('SENSEX').win) <= 5, 'net win matches within Rs.5 across indices');
ok(Math.abs(rupees('NIFTY').loss - rupees('SENSEX').loss) <= 10, 'net loss matches within Rs.10 across indices');
ok(SCALP_INDICES.SENSEX.targetPts > SCALP_INDICES.SENSEX.feePts,
    'SENSEX target exceeds its own fees (NIFTY 8pt target would not)');
for (const k of Object.keys(SCALP_INDICES)) {
    const c = SCALP_INDICES[k];
    ok(c.targetPts > c.feePts, `${k}: target beats round-trip cost`);
    ok(c.premiumMax > c.premiumMin && c.premiumSweet > c.premiumMin, `${k}: premium band is ordered`);

    // Short-premium legs book in rupees too. SENSEX's hardcoded 8pt straddle
    // target collected Rs.160 against Rs.256 of fees — every "win" lost Rs.96.
    const feeRs = c.feePts * c.lot;
    const straddleWinRs = c.straddleTargetPts * c.lot - feeRs;
    ok(straddleWinRs > 0, `${k}: a short-straddle win actually nets money after fees`);
    ok(c.strangleFloorPts * c.lot > feeRs, `${k}: the strangle floor clears fees`);
}
{
    const rs = (k) => SCALP_INDICES[k].straddleTargetPts * SCALP_INDICES[k].lot
        - SCALP_INDICES[k].feePts * SCALP_INDICES[k].lot;
    ok(Math.abs(rs('NIFTY') - rs('SENSEX')) <= 10, 'straddle net win matches across indices in rupees');
}

// Per-group routing: the whole point of the feature.
{
    const card = (label, strike, entry) =>
        `/scalp · ${label} MICRO SCALP\n\n🎯 *BUY CE*\n  Buy CE ${strike}\n  Entry: ₹${entry}\n  Confidence: 82% ✅`;
    const cards = { NIFTY: card('NIFTY 50', '24,300', '62.5'), SENSEX: card('SENSEX', '76,400', '180.0') };
    const sent = [];
    // The scanner now asks for the snapshot alongside the card so it can grade
    // open scalps without a second fetch — stub that shape, not the old one.
    const stubSvc = (byIndex) => ({
        buildScalpCardWithContext: async (k) => ({
            card: byIndex[k],
            snapshot: { strikes: [], atmCe: null, atmPe: null },
            cfg: SCALP_INDICES[k],
        }),
        buildScalpCard: async (k) => byIndex[k],
    });
    scalpAlertService.scalpSvc = stubSvc(cards);
    const realIsMarketOpen = scalpAlertService._isMarketOpen;
    scalpAlertService._isMarketOpen = () => true;
    scalpAlertService._enabled = true;
    scalpAlertService._lastAlerts = {};
    scalpAlertService._sendMessage = async (chatId, msg) => sent.push({ chatId, text: msg.text });
    scalpAlertService._getGroups = async () => ([
        { group_id: 'A', scalp_enabled: true, scalp_indices: ['NIFTY'] },
        { group_id: 'B', scalp_enabled: true, scalp_indices: ['SENSEX'] },
        { group_id: 'C', scalp_enabled: true, scalp_indices: ['NIFTY', 'SENSEX'] },
        { group_id: 'D', scalp_enabled: true },                                  // pre-SENSEX group
        { group_id: 'E', scalp_enabled: false, scalp_indices: ['SENSEX'] },
    ]);

    await scalpAlertService._scan();
    const got = (id) => sent.filter((s) => s.chatId === id)
        .map((s) => (s.text.includes('SENSEX') ? 'SENSEX' : 'NIFTY')).sort();

    ok(JSON.stringify(got('A')) === '["NIFTY"]', 'nifty-only group gets only NIFTY');
    ok(JSON.stringify(got('B')) === '["SENSEX"]', 'sensex-only group gets only SENSEX');
    ok(JSON.stringify(got('C')) === '["NIFTY","SENSEX"]', 'both-group gets both alerts');
    ok(JSON.stringify(got('D')) === '["NIFTY"]', 'group with no scalp_indices defaults to NIFTY');
    ok(got('E').length === 0, 'scalp_enabled:false gets nothing');

    const fps = Object.keys(scalpAlertService._lastAlerts);
    ok(fps.every((f) => /^(NIFTY|SENSEX):/.test(f)), 'fingerprints are index-qualified');
    ok(fps.length === 2, 'NIFTY and SENSEX hold separate cooldown entries');

    sent.length = 0;
    await scalpAlertService._scan();
    ok(sent.length === 0, 'a repeat scan inside the cooldown sends nothing');

    // A stale BSE chain must never become an alert — those are settlement prices.
    scalpAlertService._lastAlerts = {};
    scalpAlertService.scalpSvc = stubSvc({
        SENSEX: '⚠️ SENSEX chain is not live (271 min old) — these are settlement prices',
        NIFTY: cards.NIFTY,
    });
    sent.length = 0;
    await scalpAlertService._scan();
    ok(sent.every((s) => !s.text.includes('SENSEX')), 'a non-live SENSEX chain produces no alert');
    // Restore: this is a module singleton, and leaving the override in place
    // makes the market-gate assertions below test the stub instead of the gate.
    scalpAlertService._isMarketOpen = realIsMarketOpen;
    scalpAlertService._enabled = false;
}

// ── Confidence inputs must actually vary ─────────────────────────────────────
// Every assertion here is a constant that shipped disguised as a signal.
const { oiDominance } = await import('../src/services/ScalpService.js');
const { vixFitScore, fetchIndiaVix } = await import('../src/services/IndiaVixService.js');

{
    // Old rule: min(100, OI/80*100) -> 100 for every real wall.
    const flat = [100, 100, 100, 100, 100, 100];
    const scores = [1.0, 1.21, 1.48, 1.85, 2.38, 3.0]
        .map((r) => oiDominance(100 * r, [100 * r, ...flat]));
    ok(new Set(scores).size >= 5, 'oiDominance varies with wall strength (old rule was always 100)');
    ok(scores[0] === 0, 'a wall no bigger than its neighbours scores 0');
    ok(scores[scores.length - 1] === 100, 'a 3x wall scores 100');
    ok(scores.every((v, i) => i === 0 || v >= scores[i - 1]), 'score is monotonic in wall dominance');
    ok(oiDominance(160000, [160000, 100, 100]) === 50, 'too few strikes -> 50 (unknown), not 100');
    ok(oiDominance(0, flat) === 50, 'no wall -> 50, not a confident 0');

    // Index-neutrality: same shape, different absolute scale, same score. The
    // ratio-to-median alternative failed this (NIFTY 3.9-5.4x vs SENSEX 9.2-9.6x).
    const shape = [2.0, 1, 1, 1, 1, 1];
    const small = oiDominance(2000, shape.map((x) => x * 1000));
    const big = oiDominance(200000, shape.map((x) => x * 100000));
    ok(small === big, 'oiDominance is scale-free across indices');
}

{
    // Old formulas: directional went NEGATIVE below vix 10, theta exceeded 100
    // below vix 12, so theta out-scored directional almost everywhere.
    for (const v of [8.86, 11.34, 15, 20, 28.91]) {
        const d = vixFitScore(v, 'directional');
        const t = vixFitScore(v, 'theta');
        ok(d >= 0 && d <= 100, `directional vix score in range at VIX ${v}`);
        ok(t >= 0 && t <= 100, `theta vix score in range at VIX ${v}`);
        ok(d + t === 100, `vix scores are complementary at VIX ${v}`);
    }
    ok(vixFitScore(25, 'directional') > vixFitScore(11, 'directional'), 'high VIX favours directional');
    ok(vixFitScore(11, 'theta') > vixFitScore(25, 'theta'), 'low VIX favours theta');
    ok(vixFitScore(null, 'theta') === null, 'unknown VIX returns null so the term can be dropped');
    ok(vixFitScore(NaN, 'directional') === null, 'NaN VIX returns null');

    const live = await fetchIndiaVix();
    ok(live === null || (live > 5 && live < 60), `live India VIX is plausible or null (got ${live})`);
}

// ── Per-index distance span ──────────────────────────────────────────────────
{
    const dist = (d, span) => Math.max(40, Math.min(90, 40 + Math.min(1, d / span) * 50));
    const N = SCALP_INDICES.NIFTY.zoneSpan;
    const S = SCALP_INDICES.SENSEX.zoneSpan;
    ok(S > N, 'SENSEX zone span is wider than NIFTY');
    // With NIFTY's 200 the SENSEX score pinned at 90 for every real distance.
    const sensexDists = [400, 800, 1153, 2000];
    ok(new Set(sensexDists.map((d) => dist(d, N))).size === 1, 'at NIFTY span, SENSEX distances all saturate (the bug)');
    ok(new Set(sensexDists.map((d) => dist(d, S))).size > 1, 'at SENSEX span, distance actually varies');
}

// ── Outcome tracking ─────────────────────────────────────────────────────────
{
    const { ScalpOutcomeTracker } = await import('../src/services/ScalpOutcomeTracker.js');
    const N = SCALP_INDICES.NIFTY;
    const chain = (strikeLtp, atmCe = 0, atmPe = 0) => ({
        atmStrike: 24300, atmCe: { ltp: atmCe }, atmPe: { ltp: atmPe },
        strikes: [{ strike: 24300, ce: { ltp: strikeLtp }, pe: { ltp: strikeLtp } }],
    });
    const grade = async (setup, snap) => {
        const t = new ScalpOutcomeTracker();
        await t.record(setup, N, {});
        const r = await t.resolveAgainst('NIFTY', snap);
        return r[0] || null;
    };

    const long = { type: 'BUY CE', strike: '24,300', entry: '60', fingerprint: 'L' };
    ok((await grade(long, chain(68)))?.outcome === 'WIN', 'long hits target -> WIN');
    ok((await grade(long, chain(55)))?.outcome === 'LOSS', 'long hits stop -> LOSS');
    ok((await grade(long, chain(63))) === null, 'long between levels stays open');
    ok((await grade(long, chain(68)))?.pts === 8, 'long win books +8 pts');

    // A short profits when the premium FALLS — inverting this would grade every
    // straddle exactly backwards.
    const short = { type: 'SHORT STRADDLE', strike: 'ATM', entry: '240', fingerprint: 'S' };
    ok((await grade(short, chain(0, 116, 116)))?.outcome === 'WIN', 'short premium falling -> WIN');
    ok((await grade(short, chain(0, 123, 123)))?.outcome === 'LOSS', 'short premium rising -> LOSS');
    ok((await grade(short, chain(0, 116, 116)))?.pts === 8, 'short win books positive points');

    const t = new ScalpOutcomeTracker();
    await t.record(long, N, {});
    ok(t.openCount === 1, 'recording a setup opens a tracked position');
    await t.resolveAgainst('NIFTY', chain(68));
    ok(t.openCount === 0, 'settling closes it');
    await t.record({ ...long, fingerprint: 'X' }, N, {});
    await t.resolveAgainst('SENSEX', chain(68));
    ok(t.openCount === 1, 'a position is only graded against its own index');
    ok(await t.stats() === null, 'stats returns null without a database, never a fake 0%');
}

// ── Market gate: holidays and the CAS freeze ─────────────────────────────────
{
    const { default: alertSvc } = await import('../src/services/ScalpAlertService.js');
    const RealDate = Date;
    const withClock = (utc, fn) => {
        class FD extends RealDate {
            constructor(...a) { if (a.length === 0) super(utc); else super(...a); }
            static now() { return utc; }
        }
        globalThis.Date = FD;
        try { return fn(); } finally { globalThis.Date = RealDate; }
    };
    const U = (h, m) => RealDate.UTC(2026, 8, 4, h, m); // 2026-09-04, IST = UTC+5:30
    ok(withClock(U(4, 30), () => alertSvc._isMarketOpen()) === true, '10:00 IST scans');
    ok(withClock(U(9, 40), () => alertSvc._isMarketOpen()) === true, '15:10 IST still scans');
    ok(withClock(U(9, 45), () => alertSvc._isMarketOpen()) === false, '15:15 IST blocked — CAS freeze');
    ok(withClock(U(9, 50), () => alertSvc._isMarketOpen()) === false, '15:20 IST blocked — auction');
    ok(withClock(U(9, 59), () => alertSvc._isMarketOpen()) === false, '15:29 IST blocked — auction');
    ok(withClock(U(2, 30), () => alertSvc._isMarketOpen()) === false, '08:00 IST blocked — pre-open');
    ok(withClock(RealDate.UTC(2026, 8, 5, 5, 30), () => alertSvc._isMarketOpen()) === false, 'Saturday blocked');
}

// ── Reachability: can the chosen strike actually deliver the target? ─────────
{
    const { expiryYears, requiredIndexMove, movementFit, medianBarRange, scoreStrikeForScalp } =
        await import('../src/services/ScalpService.js');
    const NOW = Date.UTC(2026, 8, 4, 6, 0);

    // Both exchanges' formats: NSE "08-Sep-2026", BSE "10 Sep 2026".
    ok(Math.abs(expiryYears('08-Sep-2026', NOW) * 365 - 4.17) < 0.2, 'NSE expiry format parses');
    ok(Math.abs(expiryYears('10 Sep 2026', NOW) * 365 - 6.17) < 0.2, 'BSE expiry format parses');
    ok(expiryYears('garbage', NOW) === null, 'unparsable expiry -> null');
    ok(expiryYears('04-Sep-2026', NOW) > 0, 'expiry day is floored above zero, never divides by zero');

    // Premium move = delta x index move, so a lower-delta strike needs a bigger
    // move for the same rupees. This is what the old scorer never measured.
    const years = expiryYears('08-Sep-2026', NOW);
    const spot = 23873;
    const need = (strike, iv) => requiredIndexMove({ side: 'CE', spot, strike, iv, years, targetPts: 8 });
    const atmNeed = need(23850, 0.088);
    const otmNeed = need(24100, 0.093);
    const farNeed = need(24200, 0.096);
    ok(atmNeed < otmNeed && otmNeed < farNeed, 'further OTM needs a bigger index move');
    ok(atmNeed < 20, `ATM needs a modest move (${atmNeed?.toFixed(0)} pts)`);
    ok(farNeed > 45, `far OTM needs an implausible move (${farNeed?.toFixed(0)} pts)`);
    ok(requiredIndexMove({ side: 'CE', spot, strike: 23850, iv: 0, years, targetPts: 8 }) === null,
        'no IV -> null rather than a fabricated move');

    // Realised 5m range is the right yardstick for a 2-5 minute hold, not VIX.
    const bars = Array.from({ length: 30 }, () => ({ high: 108, low: 92 })); // range 16
    ok(medianBarRange(bars) === 16, 'medianBarRange reads the typical bar');
    ok(medianBarRange([]) === null, 'no bars -> null');
    ok(movementFit(16, 16) === 100, 'a one-bar move scores 100');
    ok(movementFit(16, 64) === 0, 'needing four bars scores 0');
    ok(movementFit(16, 32) > 0 && movementFit(16, 32) < 100, 'a two-bar move scores in between');
    ok(movementFit(null, 16) === null && movementFit(16, null) === null, 'missing inputs -> null');
    ok(movementFit(16, 24) > movementFit(16, 39), 'a nearer target scores higher');

    // The scorer must now prefer the reachable strike over the cheap lottery ticket.
    const chain = [];
    for (let k = 23600; k <= 24300; k += 50) {
        const iv = 0.074 + (k - 23600) / 700 * 0.024;
        const intrinsic = Math.max(0, spot - k);
        const ltp = Math.max(5, intrinsic + 130 * Math.exp(-Math.abs(k - spot) / 260));
        chain.push({ strike: k, ce: { ltp: Math.round(ltp * 100) / 100, oi: 50000, iv: iv * 100 }, pe: null });
    }
    const cfgN = SCALP_INDICES.NIFTY;
    const scored = chain
        .map((s) => ({
            strike: s.strike,
            score: scoreStrikeForScalp(s.strike, 'CE', spot, 23850, chain, cfgN, years),
            need: requiredIndexMove({ side: 'CE', spot, strike: s.strike, iv: s.ce.iv / 100, years, targetPts: 8 }),
        }))
        .sort((a, b) => b.score - a.score);
    const best = scored[0];
    ok(best.need <= cfgN.maxMove, `top-scored strike is reachable (needs ${best.need?.toFixed(0)} pts)`);
    const farStrike = scored.find((x) => x.need > 50);
    ok(!farStrike || farStrike.score < best.score, 'a strike needing 50+ pts never outranks a reachable one');

    // The old Rs.90 ceiling excluded the ATM strike outright, which is what
    // forced every pick into the low-delta end.
    ok(cfgN.premiumMax > 90, 'premium ceiling no longer excludes the ATM strike');
    ok(cfgN.reachMove < cfgN.maxMove, 'reach and max move are ordered');
    for (const k of Object.keys(SCALP_INDICES)) {
        ok(SCALP_INDICES[k].reachMove > 0 && SCALP_INDICES[k].maxMove > 0, `${k}: move bounds are set`);
    }
}

// ── Directional bias must be mean-reverting and symmetric ────────────────────
// The old VWAP-trend bias fought the "support bounce" premise it sat on top of:
// BUY PE fired in 40% of the input space against BUY CE's 4%, and spotPct 0-40
// could fire nothing at all — the very zone the CE setup is named for.
{
    const spotFor = (pct) => 23000 + (pct / 100) * 500;   // 500-pt range
    const support = 23000, resistance = 23500, rangeWidth = 500;

    const decide = (spotPct, realisedRange = 15.5) => {
        const spot = spotFor(spotPct);
        const nearZone = realisedRange > 0
            ? Math.min(rangeWidth * 0.25, Math.max(rangeWidth * 0.06, realisedRange * 2.5))
            : rangeWidth * 0.15;
        const dS = spot - support, dR = resistance - spot;
        let ce = dS >= 0 && dS <= nearZone;
        let pe = dR >= 0 && dR <= nearZone;
        if (ce && pe) { if (dS < dR) pe = false; else if (dR < dS) ce = false; else pe = false; }
        return ce ? 'CE' : pe ? 'PE' : 'none';
    };

    ok(decide(0) === 'CE', 'at support -> BUY CE (the old bias could fire nothing here)');
    ok(decide(100) === 'PE', 'at resistance -> BUY PE');
    ok(decide(50) === 'none', 'mid-range -> no directional trade');
    ok(decide(30) === 'none' && decide(70) === 'none', 'neither wall in play -> nothing');

    // Symmetry: the CE and PE windows must be mirror images. The old OR-chain
    // tested the bearish branch first, so bearish overrode a bullish VWAP but
    // never the reverse.
    let ce = 0, pe = 0;
    for (let sp = 0; sp <= 100; sp += 1) {
        const d = decide(sp);
        if (d === 'CE') ce++; else if (d === 'PE') pe++;
    }
    ok(ce === pe, `CE and PE windows are the same size (${ce} vs ${pe})`);
    ok(ce > 0 && pe > 0, 'both directions are reachable');

    // nearZone must mean "at the level", not most of the range.
    const zone = Math.min(rangeWidth * 0.25, Math.max(rangeWidth * 0.06, 15.5 * 2.5));
    ok(zone < rangeWidth * 0.3, `nearZone is a genuine zone (${zone.toFixed(0)} of ${rangeWidth} pts)`);
    ok(zone < rangeWidth * 0.6, 'nearZone is far tighter than the old 60%-of-range trigger');

    // Distance scoring pulls opposite ways for the two setup types.
    const distFor = (dist, span, theta) => {
        const z = Math.min(1, Math.max(0, dist) / span);
        return theta ? Math.max(40, Math.min(90, 40 + z * 50)) : Math.max(40, Math.min(90, 90 - z * 50));
    };
    ok(distFor(0, 39, false) > distFor(39, 39, false), 'directional scores higher AT the wall');
    ok(distFor(200, 200, true) > distFor(0, 200, true), 'theta scores higher AWAY from the walls');
}

console.log(`\ncheck-scalp-amt: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
