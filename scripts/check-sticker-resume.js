/**
 * Self-checks for sticker-import resilience:
 *
 *  1. ImportProgressStore — the checkpoint that lets a re-run pick up where an
 *     interrupted import stopped, instead of redoing every download/render.
 *  2. sendStickerResiliently — bounded, retried sends. `sock.sendMessage` has
 *     no timeout of its own, so a wedged socket used to freeze an import
 *     indefinitely with no error at all.
 *  3. fetchAndConvertPack honouring skipIndices, so resumed runs don't re-fetch
 *     or re-render stickers that were already delivered.
 *
 * Run: node scripts/check-sticker-resume.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImportProgressStore } from '../src/utils/importProgress.js';
import { sendStickerResiliently } from '../src/controllers/CommandController.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { const note = await fn(); console.log(`OK   ${name}${note ? ` — ${note}` : ''}`); passed++; }
    catch (err) { console.error(`FAIL ${name}: ${err.message}`); failed++; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-resume-check-'));
const storePath = () => path.join(tmpDir, `p_${Math.random().toString(36).slice(2)}.json`);

/* ── 1. checkpoint store ─────────────────────────────────────────────────── */

await test('progress survives a fresh process (new store, same file)', async () => {
    const file = storePath();
    const a = new ImportProgressStore(file);
    a.markDone('chat@g.us', 'MyPack', 0);
    a.markDone('chat@g.us', 'MyPack', 1);
    a.markDone('chat@g.us', 'MyPack', 5);
    a.flush();

    const b = new ImportProgressStore(file);      // simulates a restart
    const done = b.getDone('chat@g.us', 'MyPack');
    assert.deepStrictEqual([...done].sort((x, y) => x - y), [0, 1, 5]);
    return `${done.size} indices restored`;
});

await test('checkpoints are scoped per chat and per pack', async () => {
    const file = storePath();
    const s = new ImportProgressStore(file);
    s.markDone('chatA', 'PackOne', 3);
    s.flush();

    assert.strictEqual(s.getDone('chatB', 'PackOne').size, 0, 'leaked across chats');
    assert.strictEqual(s.getDone('chatA', 'PackTwo').size, 0, 'leaked across packs');
    assert.ok(s.getDone('chatA', 'packone').has(3), 'pack name should be case-insensitive');
});

await test('clear() drops the checkpoint so a finished pack starts fresh', async () => {
    const file = storePath();
    const s = new ImportProgressStore(file);
    s.markDone('c', 'P', 1);
    s.clear('c', 'P');
    s.flush();
    assert.strictEqual(new ImportProgressStore(file).getDone('c', 'P').size, 0);
});

await test('duplicate markDone does not double-count', async () => {
    const s = new ImportProgressStore(storePath());
    s.markDone('c', 'P', 2);
    s.markDone('c', 'P', 2);
    assert.strictEqual(s.getDone('c', 'P').size, 1);
});

await test('a corrupt progress file is recovered from, not thrown on', async () => {
    const file = storePath();
    fs.writeFileSync(file, '{ this is not json');
    const s = new ImportProgressStore(file);
    assert.strictEqual(s.getDone('c', 'P').size, 0, 'should start clean');
    s.markDone('c', 'P', 0);
    s.flush();
    assert.ok(new ImportProgressStore(file).getDone('c', 'P').has(0), 'should be usable after recovery');
});

await test('stale checkpoints are pruned by TTL', async () => {
    const file = storePath();
    const old = new ImportProgressStore(file);
    old.markDone('c', 'P', 1);
    old.flush();
    // Re-open with a TTL of 0 — everything already written is now expired.
    const fresh = new ImportProgressStore(file, { ttlMs: -1 });
    assert.strictEqual(fresh.getDone('c', 'P').size, 0, 'expired entry should be gone');
});

await test('flush is atomic — no .tmp files left behind', async () => {
    const file = storePath();
    const s = new ImportProgressStore(file);
    s.markDone('c', 'P', 0);
    s.flush();
    const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'));
    assert.strictEqual(leftovers.length, 0, `left ${leftovers.join(', ')}`);
});

/* ── 2. resilient send ───────────────────────────────────────────────────── */

const okSock = { sendMessage: async () => ({ key: { id: 'x' } }) };

await test('a hanging send times out instead of freezing the import', async () => {
    // This is the actual reported bug: sendMessage that never settles.
    const hung = { sendMessage: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await sendStickerResiliently(
        hung, 'c', {}, null, null, null,
        { timeoutMs: 120, attempts: 2, backoffMs: 10 }
    );
    const elapsed = Date.now() - started;
    assert.strictEqual(result, false, 'should report failure, not hang');
    assert.ok(elapsed < 3000, `took ${elapsed}ms — timeout did not fire`);
    return `gave up after ${elapsed}ms`;
});

await test('a transient failure is retried and then succeeds', async () => {
    let calls = 0;
    const flaky = {
        sendMessage: async () => {
            calls++;
            if (calls < 3) throw new Error('transient socket error');
            return { key: { id: 'ok' } };
        },
    };
    const result = await sendStickerResiliently(
        flaky, 'c', {}, null, null, null, { timeoutMs: 500, attempts: 3, backoffMs: 5 }
    );
    assert.strictEqual(result, true, 'should succeed on the third attempt');
    assert.strictEqual(calls, 3);
    return `recovered on attempt ${calls}`;
});

await test('a permanently dead socket returns false rather than throwing', async () => {
    const dead = { sendMessage: async () => { throw new Error('connection closed'); } };
    const result = await sendStickerResiliently(
        dead, 'c', {}, null, null, null, { timeoutMs: 200, attempts: 3, backoffMs: 5 }
    );
    assert.strictEqual(result, false, 'must not throw — one bad sticker cannot kill the import');
});

await test('retries re-resolve the live socket after a reconnect', async () => {
    let calls = 0;
    const stale = { sendMessage: async () => { calls++; throw new Error('stale socket'); } };
    let freshCalls = 0;
    const fresh = { sendMessage: async () => { freshCalls++; return { key: { id: 'ok' } }; } };
    // getSock() starts returning the reconnected socket after the first failure.
    const getSock = () => (calls === 0 ? stale : fresh);

    const result = await sendStickerResiliently(
        stale, 'c', {}, null, getSock, null, { timeoutMs: 500, attempts: 3, backoffMs: 5 }
    );
    assert.strictEqual(result, true, 'should recover via the reconnected socket');
    assert.strictEqual(freshCalls, 1, 'should have used the fresh socket');
});

await test('an aborted import stops sending immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let calls = 0;
    const counting = { sendMessage: async () => { calls++; return { key: {} }; } };
    const result = await sendStickerResiliently(counting, 'c', {}, null, null, ctrl.signal, {});
    assert.strictEqual(result, false);
    assert.strictEqual(calls, 0, '/tgstop should prevent any further sends');
});

await test('a successful send happens on the first attempt', async () => {
    let calls = 0;
    const s = { sendMessage: async () => { calls++; return { key: {} }; } };
    assert.strictEqual(await sendStickerResiliently(s, 'c', {}, null, null, null, {}), true);
    assert.strictEqual(calls, 1, 'no needless retries on success');
});

void okSock;

/* ── 3. skipIndices plumbing ─────────────────────────────────────────────── */

await test('fetchAndConvertPack skips delivered indices before downloading', async () => {
    const { default: TelegramStickerService } = await import('../src/services/TelegramStickerService.js');
    const svc = new TelegramStickerService();

    const fakePack = { title: 'Fake', stickers: Array.from({ length: 6 }, (_, i) => ({ file_id: `f${i}`, emoji: '😀' })) };
    svc.getStickerSet = async () => fakePack;

    const downloaded = [];
    svc.downloadSticker = async (sticker, index) => {
        downloaded.push(index);
        return { tempPath: '', buffer: Buffer.from('x'), size: 1, emoji: '😀', format: 'webp', ext: '.webp', index };
    };
    svc.convertToWhatsAppSticker = async () => ({ buffer: Buffer.from('y'), type: 'sticker', isAnimated: false });
    svc.applyStickerMetadata = async (b) => b;
    svc._cleanup = () => {};

    const skipIndices = new Set([0, 2, 4]);
    const { stickers, skipped } = await svc.fetchAndConvertPack('Fake', null, null, { skipIndices });

    assert.strictEqual(skipped, 3, `expected 3 skipped, got ${skipped}`);
    assert.deepStrictEqual(downloaded.sort((a, b) => a - b), [1, 3, 5], 'skipped stickers must not be downloaded');
    assert.deepStrictEqual(
        stickers.map((s) => s.index),
        [1, 3, 5],
        'results must carry original pack indices so checkpoints stay correct'
    );
    return `downloaded only ${downloaded.length}/6`;
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\ncheck-sticker-resume: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
