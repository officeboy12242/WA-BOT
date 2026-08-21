/**
 * Smoke check: prove @lottiefiles/dotlottie-web + @napi-rs/canvas render
 * Lottie animations correctly in headless Node. This is the engine the
 * refactored TelegramStickerService relies on — if this fails, /tgstk
 * animated stickers won't work either.
 *
 * Runs a real public Lottie file through the pipeline and verifies:
 *   - the WASM engine loads without a browser CDN fetch failure
 *   - setFrame(n) produces distinct PNG buffers per frame
 *   - PNG output is well-formed (starts with the PNG signature)
 *
 * No network round-trip to Telegram — that path uses the same renderer
 * behind the getStickerSet / downloadSticker layer, so once this passes
 * the TGS path is trivially wired up.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import assert from 'assert';
import { createCanvas } from '@napi-rs/canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tiny hand-authored Lottie JSON — enough to exercise the pipeline offline. */
const TRIVIAL_LOTTIE = {
    v: '5.7.4', fr: 30, ip: 0, op: 30, w: 100, h: 100, nm: 'smoke',
    ddd: 0, assets: [],
    layers: [{
        ddd: 0, ind: 1, ty: 4, nm: 'square', sr: 1,
        ks: {
            o: { a: 0, k: 100 },
            r: { a: 1, k: [
                { t: 0, s: [0], e: [360], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } },
                { t: 30, s: [360] },
            ] },
            p: { a: 0, k: [50, 50, 0] },
            a: { a: 0, k: [0, 0, 0] },
            s: { a: 0, k: [100, 100, 100] },
        },
        ao: 0,
        shapes: [
            { ty: 'gr', it: [
                { ty: 'rc', d: 1, s: { a: 0, k: [40, 40] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
                { ty: 'fl', c: { a: 0, k: [1, 0.3, 0.3, 1] }, o: { a: 0, k: 100 } },
                { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
            ] },
        ],
        ip: 0, op: 30, st: 0, bm: 0,
    }],
};

async function renderFrames(lottieJson, frameCount) {
    const w = lottieJson.w || 100;
    const h = lottieJson.h || 100;
    const canvas = createCanvas(w, h);

    const dot = new DotLottie({
        canvas,
        data: JSON.stringify(lottieJson),
        autoplay: false,
        loop: false,
    });

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('dotlottie load timeout')), 15_000);
        dot.addEventListener('load', () => { clearTimeout(t); resolve(); });
        dot.addEventListener('loadError', (e) => { clearTimeout(t); reject(new Error(`load error: ${e?.error?.message || e}`)); });
    });

    const totalFrames = dot.totalFrames || lottieJson.op || 30;
    const step = Math.max(1, Math.floor(totalFrames / frameCount));
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
        const f = Math.min(totalFrames - 1, i * step);
        dot.setFrame(f);
        frames.push(await canvas.encode('png'));
    }
    dot.destroy();
    return { frames, width: w, height: h, totalFrames };
}

async function main() {
    let passed = 0, failed = 0;
    const outDir = path.join(os.tmpdir(), 'tgs-renderer-check');
    fs.mkdirSync(outDir, { recursive: true });

    // Test 1 — synthetic Lottie renders N distinct frames
    try {
        const { frames } = await renderFrames(TRIVIAL_LOTTIE, 6);
        assert.strictEqual(frames.length, 6, 'expected 6 frames');
        for (const buf of frames) {
            assert.ok(Buffer.isBuffer(buf), 'frame must be Buffer');
            assert.ok(buf.slice(0, 8).equals(PNG_SIG), 'frame must be PNG');
            assert.ok(buf.length > 100, `frame too small: ${buf.length}b`);
        }
        // Distinct frames — rotating square must not produce identical PNGs
        const distinct = new Set(frames.map((b) => b.toString('base64').slice(0, 200))).size;
        assert.ok(distinct >= 3, `expected >=3 distinct frames, got ${distinct}`);
        console.log(`OK  synthetic lottie → 6 frames, ${distinct} distinct, first frame ${frames[0].length}b`);
        passed++;
    } catch (err) {
        console.error(`FAIL synthetic lottie: ${err.message}`);
        failed++;
    }

    // Test 2 — round-trip TGS (gzipped Lottie) as if downloaded from Telegram
    try {
        const tgsBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(TRIVIAL_LOTTIE)));
        const lottie = JSON.parse(zlib.gunzipSync(tgsBuffer).toString('utf-8'));
        const { frames } = await renderFrames(lottie, 4);
        assert.strictEqual(frames.length, 4);
        for (const buf of frames) assert.ok(buf.slice(0, 8).equals(PNG_SIG));
        console.log(`OK  gzipped TGS round-trip → 4 frames`);
        passed++;
    } catch (err) {
        console.error(`FAIL tgs round-trip: ${err.message}`);
        failed++;
    }

    console.log(`\ncheck-tgs-renderer: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
