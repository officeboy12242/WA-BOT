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

function stubChain(spot, atm, ceWall, peWall) {
    const strikes = [];
    for (let k = atm - 700; k <= atm + 700; k += 50) {
        const d = Math.abs(k - atm);
        strikes.push({
            strike: k,
            ce: { ltp: Math.max(5, 160 - (k - atm) * 0.5), oi: k === ceWall ? 180000 : 40000 + d * 10, iv: 12 },
            pe: { ltp: Math.max(5, 160 + (k - atm) * 0.5), oi: k === peWall ? 175000 : 40000 + d * 10, iv: 12 },
        });
    }
    const row = strikes.find((s) => s.strike === atm);
    return {
        symbol: 'NIFTY', spot, pcr: 1.05, strikes, atmStrike: atm,
        atmCe: { strike: atm, ...row.ce }, atmPe: { strike: atm, ...row.pe },
        totalCeOi: 2000000, totalPeOi: 2100000, expiry: '01-Sep-2026',
    };
}

async function cardFor(ceWall, peWall) {
    globalThis.Date = FakeDate;
    try {
        const svc = new ScalpService();
        svc.nse = { fetchOptionContext: async () => ({ snapshot: stubChain(24325, 24350, ceWall, peWall) }) };
        return await svc.buildScalpCard('NIFTY');
    } finally {
        globalThis.Date = RealDate;
    }
}

// Short strangle across range widths. Shipped bug: wings were built with
// round5() (nearest 5) while NIFTY strikes step in 50s, so findStrikeLeg --
// which matches EXACTLY -- returned null, both legs priced 0, and the setup
// failed its `> 20` guard silently. 5 of 9 typical widths were affected.
for (const [ce, pe] of [[24450, 24200], [24500, 24200], [24550, 24150], [24400, 24200], [24600, 24100]]) {
    const card = await cardFor(ce, pe);
    ok(card.includes('SHORT STRANGLE'), `short strangle fires at range ${ce - pe}`);
    ok(card.includes('SHORT STRADDLE'), `short straddle fires at range ${ce - pe}`);
}

const card = await cardFor(24500, 24200);
for (const section of ['SCALP MAP', 'PREMIUM LIVE', 'SCALP RULES']) {
    ok(card.includes(section), `card still renders "${section}" section`);
}
ok(!card.includes('undefined') && !card.includes('NaN'), 'card has no undefined/NaN leaking into it');

console.log(`\ncheck-scalp-amt: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
