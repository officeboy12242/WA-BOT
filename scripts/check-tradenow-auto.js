/**
 * Self-checks for the continuous /tradenow auto-trigger.
 *
 * The gate is the model's self-reported "Primary Confidence", so the guards
 * around it are what keep this from spamming a group or firing on premiums it
 * cannot trust. Those guards are pure functions, tested here without a socket,
 * an LLM, or the clock.
 *
 * Run: node scripts/check-tradenow-auto.js
 */
import assert from 'node:assert';
import { evaluateSignal, msToNextScan, istDayKey } from '../src/utils/tradeNowScheduler.js';
import { parseTradeSignal } from '../src/utils/tradeSignalParser.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { const note = await fn(); console.log(`OK   ${name}${note ? ` — ${note}` : ''}`); passed++; }
    catch (err) { console.error(`FAIL ${name}: ${err.message}`); failed++; }
}

/** Minimal card in the shape tradeAnalysisPrompt asks the model to emit. */
function card({ ceConf = 0, peConf = 0, primary = 'NO TRADE', primaryConf = 0, stale = false } = {}) {
    return (
        (stale ? '⚠️ *STALE DATA — 12 min old*\n_NSE is unreachable right now._\n\n' : '')
        + '━━━ CALL (CE) SETUP ━━━\n'
        + `Verdict: ${ceConf >= 50 ? '✅ BUY CE' : '❌ AVOID'}\n`
        + `Confidence: ${ceConf}%\n`
        + '━━━ PUT (PE) SETUP ━━━\n'
        + `Verdict: ${peConf >= 50 ? '✅ BUY PE' : '❌ AVOID'}\n`
        + `Confidence: ${peConf}%\n`
        + `Primary Pick: ${primary}\n`
        + `Primary Confidence: ${primaryConf}%\n`
    );
}

const base = {
    minConfidence: 65,
    index: 'NIFTY',
    nowMs: 1_000_000_000,
    cooldownMs: 30 * 60_000,
    postedToday: 0,
    maxPerDay: 6,
};

/* ── the threshold itself ────────────────────────────────────────────────── */

await test('fires at exactly the configured threshold', async () => {
    const v = evaluateSignal(card({ ceConf: 65, primary: '✅ BUY CE', primaryConf: 65 }), base);
    assert.strictEqual(v.fire, true, v.reason);
    assert.strictEqual(v.side, 'CE');
    assert.strictEqual(v.confidence, 65);
    return 'CE @65%';
});

await test('holds one point below the threshold', async () => {
    const v = evaluateSignal(card({ ceConf: 64, primary: '✅ BUY CE', primaryConf: 64 }), base);
    assert.strictEqual(v.fire, false);
    assert.match(v.reason, /below threshold/);
});

await test('a PE setup fires on the PE side', async () => {
    const v = evaluateSignal(card({ peConf: 80, primary: '✅ BUY PE', primaryConf: 80 }), base);
    assert.strictEqual(v.fire, true, v.reason);
    assert.strictEqual(v.side, 'PE');
});

await test('NO TRADE never fires, however high the number', async () => {
    const v = evaluateSignal(card({ primary: '❌ NO TRADE', primaryConf: 99 }), base);
    assert.strictEqual(v.fire, false);
    assert.match(v.reason, /no actionable side/);
});

await test('the threshold is configurable, not hardcoded to 70', async () => {
    const c = card({ ceConf: 68, primary: '✅ BUY CE', primaryConf: 68 });
    assert.strictEqual(evaluateSignal(c, { ...base, minConfidence: 65 }).fire, true, 'should fire at 65');
    assert.strictEqual(evaluateSignal(c, { ...base, minConfidence: 75 }).fire, false, 'should hold at 75');
    // The default parser gate is untouched for every existing caller.
    assert.strictEqual(parseTradeSignal(c).isActionable, false, 'default 70 gate must be unchanged');
    return '65 fires, 75 holds, default 70 preserved';
});

/* ── anti-spam guards ────────────────────────────────────────────────────── */

await test('cooldown blocks a repeat on the same index+side', async () => {
    const lastPosted = new Map([['NIFTY:CE', base.nowMs - 5 * 60_000]]);
    const v = evaluateSignal(
        card({ ceConf: 90, primary: '✅ BUY CE', primaryConf: 90 }),
        { ...base, lastPosted }
    );
    assert.strictEqual(v.fire, false);
    assert.match(v.reason, /cooling down/);
    return v.reason;
});

await test('the opposite side is not blocked by the other side cooldown', async () => {
    const lastPosted = new Map([['NIFTY:CE', base.nowMs - 60_000]]);
    const v = evaluateSignal(
        card({ peConf: 90, primary: '✅ BUY PE', primaryConf: 90 }),
        { ...base, lastPosted }
    );
    assert.strictEqual(v.fire, true, 'a genuine reversal should still post');
});

await test('cooldown expires', async () => {
    const lastPosted = new Map([['NIFTY:CE', base.nowMs - 31 * 60_000]]);
    const v = evaluateSignal(
        card({ ceConf: 90, primary: '✅ BUY CE', primaryConf: 90 }),
        { ...base, lastPosted }
    );
    assert.strictEqual(v.fire, true, v.reason);
});

await test('daily cap stops further alerts', async () => {
    const v = evaluateSignal(
        card({ ceConf: 99, primary: '✅ BUY CE', primaryConf: 99 }),
        { ...base, postedToday: 6 }
    );
    assert.strictEqual(v.fire, false);
    assert.match(v.reason, /daily cap/);
});

/* ── the premium-safety guard ────────────────────────────────────────────── */

await test('never fires on a stale option chain', async () => {
    // Entry premiums come from the chain; a cached one reads like a live one.
    const v = evaluateSignal(
        card({ ceConf: 95, primary: '✅ BUY CE', primaryConf: 95, stale: true }),
        { ...base, chainStale: true }
    );
    assert.strictEqual(v.fire, false, 'a 95% signal on stale premiums must not fire');
    assert.match(v.reason, /stale/i);
    return 'blocked at 95%';
});

/* ── scheduling helpers ──────────────────────────────────────────────────── */

await test('scan waits land on the interval boundary plus settle', async () => {
    const interval = 5 * 60_000;
    for (const now of [0, 1_000, 149_000, 299_999]) {
        const wait = msToNextScan(now, interval, 20_000);
        assert.ok(wait > 0, `wait must be positive, got ${wait}`);
        assert.ok(wait <= interval + 20_000, `wait ${wait} exceeds one interval`);
        assert.strictEqual((now + wait - 20_000) % interval, 0, 'should align to the boundary');
    }
});

await test('day key rolls in IST, so caps reset with the trading day', async () => {
    // IST is UTC+5:30, so the day rolls at 18:30 UTC.
    const morning = Date.parse('2026-08-25T04:00:00Z');       // 09:30 IST, mid-session
    const lateEvening = Date.parse('2026-08-25T18:00:00Z');   // 23:30 IST, still the 25th
    const afterMidnight = Date.parse('2026-08-25T19:00:00Z'); // 00:30 IST on the 26th

    assert.strictEqual(istDayKey(morning), '2026-08-25');
    assert.strictEqual(istDayKey(lateEvening), '2026-08-25', 'must not roll at UTC midnight');
    assert.strictEqual(istDayKey(afterMidnight), '2026-08-26', 'must roll at IST midnight');
    return `${istDayKey(lateEvening)} → ${istDayKey(afterMidnight)}`;
});

console.log(`\ncheck-tradenow-auto: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
