/**
 * Offline smoke check for the Telegram → WhatsApp sticker conversion pipeline.
 *
 * Runs entirely on synthetic Lottie/WebM input — no TELEGRAM_BOT_TOKEN and no
 * network — so it can gate CI. It asserts the properties that actually make a
 * WhatsApp animated sticker work, each of which has broken in the past:
 *
 *   - output is WebP, never MP4 (an MP4 sends as a video attachment, not a sticker)
 *   - real VP8X/ANIM/ANMF chunks (WhatsApp won't animate without them)
 *   - alpha survives (yuva420p, not yuv420p — yuv420p flattens onto black)
 *   - more than one frame actually made it in
 *   - output is 512×512 and within WhatsApp's size limits
 *   - the node-webpmux fallback works for hosts whose ffmpeg lacks libwebp
 *
 * Companion to check-tgs-renderer.js, which covers only the Lottie rasteriser.
 */

import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import {
    telegramStickerService as svc,
    Semaphore,
    MAX_CONCURRENT_IMPORTS,
} from '../src/services/TelegramStickerService.js';

const ANIM_MAX = 500 * 1024;
const STATIC_MAX = 100 * 1024;

/** Synthetic Lottie: rotating shapes on a transparent background. */
function lottie({ w = 512, h = 512, fr = 60, op = 60, shapes: n = 1 } = {}) {
    const shapes = [];
    for (let k = 0; k < n; k++) {
        shapes.push({ ty: 'gr', it: [
            { ty: 'el', d: 1, s: { a: 0, k: [120 + k * 9, 120 + k * 9] }, p: { a: 0, k: [k * 13 - 60, k * 7 - 40] } },
            { ty: 'fl', c: { a: 0, k: [(k % 3) / 3, ((k + 1) % 5) / 5, ((k + 2) % 7) / 7, 1] }, o: { a: 0, k: 90 } },
            { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
        ] });
    }
    return {
        v: '5.7.4', fr, ip: 0, op, w, h, nm: 't', ddd: 0, assets: [],
        layers: [{
            ddd: 0, ind: 1, ty: 4, nm: 'l', sr: 1,
            ks: {
                o: { a: 0, k: 100 },
                r: { a: 1, k: [
                    { t: 0, s: [0], e: [360], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
                    { t: op, s: [360] },
                ] },
                p: { a: 0, k: [w / 2, h / 2, 0] },
                a: { a: 0, k: [0, 0, 0] },
                s: { a: 0, k: [100, 100, 100] },
            },
            ao: 0, shapes, ip: 0, op, st: 0, bm: 0,
        }],
    };
}

const tgs = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(lottie(o))));

async function describe(buf) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(buf, { animated: true }).metadata();
    return {
        bytes: buf.length,
        pages: meta.pages ?? 1,
        width: meta.width,
        height: meta.pageHeight || meta.height,
        alpha: meta.hasAlpha,
        format: meta.format,
        anim: buf.includes(Buffer.from('ANIM')),
        anmf: buf.includes(Buffer.from('ANMF')),
    };
}

/** Assert everything that makes an animated WhatsApp sticker valid. */
async function assertAnimatedSticker(buf, label) {
    const d = await describe(buf);
    assert.strictEqual(d.format, 'webp', `${label}: must be WebP, got ${d.format}`);
    assert.ok(d.anim && d.anmf, `${label}: missing ANIM/ANMF chunks`);
    assert.ok(d.pages > 1, `${label}: only ${d.pages} frame(s)`);
    assert.strictEqual(d.alpha, true, `${label}: alpha channel was lost`);
    assert.strictEqual(d.width, 512, `${label}: width ${d.width} != 512`);
    assert.strictEqual(d.height, 512, `${label}: height ${d.height} != 512`);
    assert.ok(d.bytes <= ANIM_MAX, `${label}: ${d.bytes}b exceeds ${ANIM_MAX}b`);
    return d;
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        const note = await fn();
        console.log(`OK   ${name}${note ? ` — ${note}` : ''}`);
        passed++;
    } catch (err) {
        console.error(`FAIL ${name}: ${err.message}`);
        failed++;
    }
}

await test('TGS → animated WebP sticker', async () => {
    const out = await svc.convertToWhatsAppSticker(tgs(), '😀', 'tgs');
    assert.strictEqual(out.type, 'sticker', 'must be a sticker, never a video');
    assert.strictEqual(out.isAnimated, true);
    const d = await assertAnimatedSticker(out.buffer, 'tgs');
    return `${d.bytes}b, ${d.pages} frames`;
});

await test('heavy TGS is squeezed under the 500KB cap by the ladder', async () => {
    const out = await svc.convertToWhatsAppSticker(tgs({ shapes: 14, op: 120 }), '🔥', 'tgs');
    assert.strictEqual(out.isAnimated, true);
    const d = await assertAnimatedSticker(out.buffer, 'heavy-tgs');
    return `${d.bytes}b, ${d.pages} frames`;
});

await test('undersized source is normalised to 512×512', async () => {
    const out = await svc.convertToWhatsAppSticker(tgs({ w: 256, h: 256, fr: 24, op: 24 }), '🎯', 'tgs');
    const d = await assertAnimatedSticker(out.buffer, 'small-src');
    return `${d.width}x${d.height}`;
});

await test('bare (ungzipped) Lottie JSON is accepted', async () => {
    const out = await svc.convertToWhatsAppSticker(Buffer.from(JSON.stringify(lottie())), '📦', 'tgs');
    assert.strictEqual(out.isAnimated, true);
    await assertAnimatedSticker(out.buffer, 'bare-json');
});

await test('node-webpmux fallback (ffmpeg without libwebp) still animates', async () => {
    const { frames } = await svc._renderLottieFrames(tgs(), { fps: 15, size: 512 });
    const out = await svc._framesToAnimatedWebpMux(frames, { fps: 15, quality: 60, size: 512 });
    const d = await describe(out);
    assert.ok(d.anim && d.anmf, 'fallback lost ANIM/ANMF');
    assert.ok(d.pages > 1, `fallback produced ${d.pages} frame(s)`);
    assert.strictEqual(d.alpha, true, 'fallback lost alpha');
    return `${d.bytes}b, ${d.pages} frames`;
});

await test('video sticker (VP9 WebM w/ alpha) → animated WebP sticker', async () => {
    const { frames } = await svc._renderLottieFrames(tgs(), { fps: 20, size: 512 });
    const dir = svc._writeFrameDir(frames);
    const webmPath = path.join(svc.tempDir, `src_${Date.now()}.webm`);
    try {
        await svc._runFfmpeg([
            '-y', '-framerate', '20', '-i', path.join(dir, 'f_%04d.png'),
            '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '400k', '-an', webmPath,
        ], 180000);

        const out = await svc.convertToWhatsAppSticker(fs.readFileSync(webmPath), '🎬', 'video');
        assert.strictEqual(out.type, 'sticker', 'video stickers must not send as video messages');
        assert.strictEqual(out.isAnimated, true);
        const d = await assertAnimatedSticker(out.buffer, 'webm');
        return `${d.bytes}b, ${d.pages} frames`;
    } finally {
        svc._rmFrameDir(dir);
        svc._cleanup(webmPath);
    }
});

await test('pack/author EXIF is stamped on without breaking the animation', async () => {
    const { config } = await import('../src/config/config.js');
    if (!config.STICKER_PACK_NAME && !config.STICKER_PACK_AUTHOR) {
        return 'skipped — no STICKER_PACK_NAME/AUTHOR configured';
    }

    const out = await svc.convertToWhatsAppSticker(tgs(), '😀', 'tgs');
    const stamped = await svc.applyStickerMetadata(out.buffer);

    assert.ok(stamped.includes(Buffer.from('EXIF')), 'EXIF chunk was not added');
    // The metadata must not cost us the animation, the alpha, or the size cap.
    await assertAnimatedSticker(stamped, 'exif-stamped');
    assert.ok(
        stamped.length - out.buffer.length < 4096,
        `EXIF added ${stamped.length - out.buffer.length}b — more than the reserved headroom`
    );
    return `+${stamped.length - out.buffer.length}b`;
});

await test('static WebP passes through as a non-animated sticker', async () => {
    const sharp = (await import('sharp')).default;
    const src = await sharp({
        create: { width: 400, height: 300, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    }).webp({ quality: 90 }).toBuffer();

    const out = await svc.convertToWhatsAppSticker(src, '🙂', 'webp');
    assert.strictEqual(out.type, 'sticker');
    assert.strictEqual(out.isAnimated, false);
    assert.ok(out.buffer.length <= STATIC_MAX, `${out.buffer.length}b exceeds ${STATIC_MAX}b`);
    return `${out.buffer.length}b`;
});

await test('semaphore never exceeds its bound and drains every task', async () => {
    const gate = new Semaphore(3);
    let running = 0;
    let peak = 0;
    const order = [];

    await Promise.all(Array.from({ length: 25 }, (_, i) => gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        // Uneven durations so fast tasks finish while slow ones hold slots.
        await new Promise((r) => setTimeout(r, (i % 5) * 4));
        order.push(i);
        running--;
    })));

    assert.ok(peak <= 3, `concurrency peaked at ${peak}, bound was 3`);
    assert.ok(peak > 1, `gate never ran anything in parallel (peak ${peak})`);
    assert.strictEqual(order.length, 25, `only ${order.length}/25 tasks completed`);
    assert.strictEqual(running, 0, 'slots leaked after drain');
    return `peak ${peak}/3, all 25 drained`;
});

await test('a task that throws still releases its slot', async () => {
    const gate = new Semaphore(2);
    const results = await Promise.allSettled([
        gate.run(async () => { throw new Error('boom'); }),
        gate.run(async () => { throw new Error('boom'); }),
        gate.run(async () => 'ok'),
        gate.run(async () => 'ok'),
    ]);
    assert.strictEqual(results[2].status, 'fulfilled', 'deadlocked after a rejection');
    assert.strictEqual(results[3].status, 'fulfilled', 'deadlocked after a rejection');
});

await test(`${MAX_CONCURRENT_IMPORTS} packs converting at once all succeed`, async () => {
    // Simulates several /tgstk imports overlapping: distinct sources converting
    // simultaneously must not collide over temp files, ffmpeg, or the renderer.
    const sources = [
        { label: 'tgs-simple', buf: tgs(), format: 'tgs' },
        { label: 'tgs-heavy', buf: tgs({ shapes: 10, op: 90 }), format: 'tgs' },
        { label: 'tgs-small', buf: tgs({ w: 256, h: 256, fr: 24, op: 24 }), format: 'tgs' },
        { label: 'tgs-fast', buf: tgs({ fr: 30, op: 30 }), format: 'tgs' },
    ];
    // Kept to one round: run-all-checks executes every check concurrently, and
    // this is the CPU-heaviest one — doubling the work here made the whole
    // suite flake under contention.
    const jobs = sources;

    const settled = await Promise.allSettled(
        jobs.map((s) => svc.convertToWhatsAppSticker(s.buf, '😀', s.format))
    );

    const rejected = settled
        .map((r, i) => (r.status === 'rejected' ? `${jobs[i].label}: ${r.reason?.message}` : null))
        .filter(Boolean);
    assert.strictEqual(rejected.length, 0, `concurrent conversions failed — ${rejected.join(' | ')}`);

    for (let i = 0; i < settled.length; i++) {
        await assertAnimatedSticker(settled[i].value.buffer, `concurrent:${jobs[i].label}`);
    }
    return `${jobs.length} concurrent conversions, all valid`;
});

await test('no scratch files are left behind after conversions', async () => {
    const before = fs.readdirSync(svc.tempDir).length;
    await Promise.all([
        svc.convertToWhatsAppSticker(tgs(), '😀', 'tgs'),
        svc.convertToWhatsAppSticker(tgs({ shapes: 6 }), '🔥', 'tgs'),
    ]);
    const after = fs.readdirSync(svc.tempDir).length;
    assert.strictEqual(after, before, `leaked ${after - before} temp entries`);
    return `${after} entries, unchanged`;
});

await test('cleanup() spares files still in use by a running import', async () => {
    // A fresh scratch file stands in for another import's in-flight frames.
    const inFlight = path.join(svc.tempDir, `inflight_${Date.now()}.png`);
    fs.writeFileSync(inFlight, 'x');
    try {
        svc.cleanup();                       // default 30-minute age gate
        assert.ok(fs.existsSync(inFlight), 'cleanup() deleted an in-flight file');

        // Negative age ⇒ cutoff in the future ⇒ sweep everything. The margin is
        // generous because a freshly written file's mtime can read slightly
        // ahead of Date.now() on Windows.
        assert.strictEqual(svc.cleanup(-5000), 1, 'forced sweep should reclaim it');
        assert.ok(!fs.existsSync(inFlight), 'forced sweep left the file behind');
    } finally {
        try { fs.unlinkSync(inFlight); } catch {}
    }
});

console.log(`\ncheck-sticker-pipeline: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
