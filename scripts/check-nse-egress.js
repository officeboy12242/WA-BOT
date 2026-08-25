/**
 * Self-checks for NSE egress routing and option-chain caching.
 *
 * Background: NSE blocks foreign datacenter IPs, and the bot runs on Render
 * (singapore), which is why "Option chain unavailable for NIFTY" showed up in
 * production while the same code worked from an Indian IP. Requests can now be
 * routed through India-resident proxies, and a cached chain is served (clearly
 * labelled) when NSE is unreachable.
 *
 * Offline — no network, no NSE_PROXY_URL needed.
 *
 * Run: node scripts/check-nse-egress.js
 */
import assert from 'node:assert';
import {
    DIRECT,
    egressOrder,
    egressRequestConfig,
    isBlockError,
    maskProxy,
    noteDirectBlocked,
    noteDirectOk,
    _resetEgressState,
} from '../src/utils/nseEgress.js';
import { staleBanner } from '../src/services/OptionChainAiService.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { const note = await fn(); console.log(`OK   ${name}${note ? ` — ${note}` : ''}`); passed++; }
    catch (err) { console.error(`FAIL ${name}: ${err.message}`); failed++; }
}

const P1 = 'http://user:secret@1.2.3.4:8080';
const P2 = 'socks5://5.6.7.8:1080';

/* ── egress ordering ─────────────────────────────────────────────────────── */

await test('no proxies configured → direct only', async () => {
    _resetEgressState();
    assert.deepStrictEqual(egressOrder({ proxyUrls: '', mode: 'auto' }), [DIRECT]);
});

await test('auto mode tries direct first, then each proxy', async () => {
    _resetEgressState();
    const order = egressOrder({ proxyUrls: `${P1},${P2}`, mode: 'auto' });
    assert.deepStrictEqual(order, [DIRECT, P1, P2]);
});

await test('after a direct block, proxies are tried first', async () => {
    _resetEgressState();
    noteDirectBlocked();
    const order = egressOrder({ proxyUrls: `${P1},${P2}`, mode: 'auto' });
    assert.deepStrictEqual(order, [P1, P2, DIRECT], 'blocked direct should sink to last');
    return 'direct demoted, still kept as last resort';
});

await test('a later direct success clears the block memory', async () => {
    _resetEgressState();
    noteDirectBlocked();
    noteDirectOk();
    assert.deepStrictEqual(egressOrder({ proxyUrls: P1, mode: 'auto' }), [DIRECT, P1]);
});

await test('mode=always never goes direct', async () => {
    _resetEgressState();
    assert.deepStrictEqual(egressOrder({ proxyUrls: `${P1},${P2}`, mode: 'always' }), [P1, P2]);
});

await test('mode=off ignores configured proxies', async () => {
    _resetEgressState();
    assert.deepStrictEqual(egressOrder({ proxyUrls: `${P1},${P2}`, mode: 'off' }), [DIRECT]);
});

await test('proxy list tolerates spaces and empty entries', async () => {
    _resetEgressState();
    assert.deepStrictEqual(
        egressOrder({ proxyUrls: `  ${P1} , , ${P2}  ,`, mode: 'always' }),
        [P1, P2]
    );
});

/* ── block detection ─────────────────────────────────────────────────────── */

await test('NSE refusals are recognised as blocks, not transient errors', async () => {
    for (const msg of [
        'NSE returned HTML (rate limit / bot detection)',
        'Request failed with status code 403',
        'Request failed with status code 429',
    ]) {
        assert.ok(isBlockError(new Error(msg)), `should flag: ${msg}`);
    }
    // A genuine timeout is not a block — it must not demote direct forever.
    assert.ok(!isBlockError(new Error('timeout of 22000ms exceeded')), 'timeout is not a block');
});

/* ── credential safety ───────────────────────────────────────────────────── */

await test('proxy credentials never reach the logs', async () => {
    const masked = maskProxy(P1);
    assert.ok(!masked.includes('secret'), `password leaked: ${masked}`);
    assert.ok(!masked.includes('user'), `username leaked: ${masked}`);
    assert.ok(masked.includes('1.2.3.4'), 'host should still be identifiable');
    assert.strictEqual(maskProxy(DIRECT), DIRECT);
    return masked;
});

/* ── agent construction ──────────────────────────────────────────────────── */

await test('DIRECT adds no agent; a proxy produces a reusable one', async () => {
    assert.deepStrictEqual(egressRequestConfig(DIRECT), {});

    const cfg = egressRequestConfig(P1);
    assert.ok(cfg.httpsAgent, 'expected an https agent for a proxy egress');
    assert.strictEqual(cfg.proxy, false, 'axios env-proxy handling must be disabled');

    // Cached — a fresh agent per request would leak sockets.
    assert.strictEqual(egressRequestConfig(P1).httpsAgent, cfg.httpsAgent, 'agent should be cached');
    return 'agent built and cached';
});

await test('a malformed proxy URL degrades to direct instead of throwing', async () => {
    const cfg = egressRequestConfig('not a url at all');
    assert.ok(typeof cfg === 'object', 'must not throw');
});

/* ── stale labelling ─────────────────────────────────────────────────────── */

await test('fresh data carries no stale warning', async () => {
    assert.strictEqual(staleBanner({ stale: false, ageSec: 0 }), '');
    assert.strictEqual(staleBanner(null), '');
});

await test('cached data is loudly labelled with its age', async () => {
    const banner = staleBanner({ stale: true, ageSec: 754 });
    assert.ok(/STALE/i.test(banner), 'must say STALE');
    assert.ok(banner.includes('12 min'), `should show age, got: ${banner}`);
    assert.ok(/not.*live/i.test(banner), 'must warn the premiums are not live');
    return '12 min old, warned';
});

/* ── stale data must never reach trade pricing ───────────────────────────── */

/**
 * Regression guard. A cache that served stale chains to every caller silently
 * fed hour-old premiums into entry pricing and into SvmkrPositionTracker's
 * target/stop-loss checks, which read like live quotes. Stale is opt-in, and
 * only for advisory surfaces that display the age.
 */
await test('pricing callers get null on failure — never a stale premium', async () => {
    const { default: NseOptionChainService } = await import('../src/services/NseOptionChainService.js');
    const svc = new NseOptionChainService();

    const fakeChain = {
        context: 'ctx',
        snapshot: { symbol: 'NIFTY', spot: 24120, atmStrike: 24100, expiry: '25-Aug-2026', strikes: [] },
    };

    // Prime the cache with one good fetch, then make NSE fail.
    let live = true;
    svc._fetchChainForNse = async () => {
        if (!live) throw new Error('NSE returned HTML (rate limit / bot detection)');
        return fakeChain;
    };
    const first = await svc.fetchOptionContext('NIFTY');
    assert.ok(first, 'setup: first fetch should succeed');
    assert.strictEqual(first.snapshot.stale, false);

    live = false;

    // Default (pricing: position tracker, scans, morning pick, entry premiums)
    const pricing = await svc.fetchOptionContext('NIFTY');
    assert.strictEqual(
        pricing, null,
        'pricing callers must get null and skip — a wrong premium is worse than none'
    );

    // Opt-in advisory caller still gets the cached chain, flagged.
    const advisory = await svc.fetchOptionContext('NIFTY', { allowStale: true });
    assert.ok(advisory, 'advisory caller should still get the cached chain');
    assert.strictEqual(advisory.snapshot.stale, true, 'must be flagged stale');
    assert.ok(staleBanner(advisory.snapshot).includes('STALE'), 'must render the warning');

    return 'pricing → null, advisory → labelled';
});

await test('no cache reuse by default, even while NSE is healthy', async () => {
    const { default: NseOptionChainService } = await import('../src/services/NseOptionChainService.js');
    const svc = new NseOptionChainService();

    let fetches = 0;
    svc._fetchChainForNse = async () => {
        fetches++;
        return { context: 'c', snapshot: { symbol: 'NIFTY', spot: 100 + fetches, strikes: [] } };
    };

    await svc.fetchOptionContext('NIFTY');
    const second = await svc.fetchOptionContext('NIFTY');
    assert.strictEqual(fetches, 2, 'premiums move every tick — default must refetch, not reuse');
    assert.strictEqual(second.snapshot.spot, 102, 'caller should see the newer chain');

    // An explicit reuse window is honoured when a caller asks for it.
    const reused = await svc.fetchOptionContext('NIFTY', { maxAgeMs: 60_000 });
    assert.strictEqual(fetches, 2, 'explicit maxAgeMs should serve from cache');
    assert.strictEqual(reused.snapshot.stale, false, 'a fresh reuse is not stale');
    return 'default refetches; maxAgeMs opt-in reuses';
});

console.log(`\ncheck-nse-egress: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
