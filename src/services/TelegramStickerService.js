/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * Every sticker type ends up as a single output format — a WhatsApp sticker
 * (`{ sticker: buffer }`), because that is the only thing WhatsApp renders as
 * a sticker:
 *
 * - Static WebP → resize + compress → static WebP sticker
 * - Animated TGS (gzipped Lottie JSON) → real Lottie frames via
 *   @lottiefiles/dotlottie-web (ThorVG WASM) on @napi-rs/canvas →
 *   animated WebP (VP8X/ANIM/ANMF, alpha preserved)
 * - Video stickers (WEBM/VP9, MP4) → animated WebP
 *
 * Animated output goes through ffmpeg's `libwebp_anim` encoder with
 * `yuva420p`, which keeps the alpha channel. Encoding to MP4/`yuv420p`
 * flattens alpha onto black and WhatsApp shows it as a video attachment
 * rather than a sticker, so that path is deliberately not used.
 *
 * Supports abort via AbortController (user sends /tgstop).
 *
 * Requires TELEGRAM_BOT_TOKEN env var.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { createCanvas } from '@napi-rs/canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';

const execFileAsync = promisify(execFile);

const TG_API = 'https://api.telegram.org';
const STICKER_WEBP_MAX = 100 * 1024; // 100 KB — WhatsApp static sticker limit
const ANIM_WEBP_MAX = 500 * 1024;    // 500 KB — WhatsApp animated sticker limit
// The pack/author EXIF chunk is appended after encoding (~210 bytes in
// practice). Reserve headroom so injecting it can't push a sticker that just
// squeaked under the limit back over it.
const EXIF_OVERHEAD = 1024;
const ANIM_BUDGET = ANIM_WEBP_MAX - EXIF_OVERHEAD;
const STATIC_BUDGET = STICKER_WEBP_MAX - EXIF_OVERHEAD;
const DOWNLOAD_CONCURRENCY = 3;
// Conversion is CPU-bound (Lottie raster + ffmpeg). Leave a core for the rest
// of the bot, and stay serial on single/dual-core hosts like small PaaS dynos.
const CONVERT_CONCURRENCY = Math.max(1, Math.min(3, (os.cpus()?.length || 1) - 1));
const STICKER_SIZE = 512;            // WhatsApp stickers are 512×512
const MAX_ANIM_SECONDS = 6;          // Cap animation length

/**
 * Encoder ladder for animated WebP. Tried in order until the output fits
 * ANIM_BUDGET. Real TGS packs vary wildly in complexity, so a fixed
 * quality either blows the size limit or wastes it.
 */
const ANIM_LADDER = [
    { fps: 24, quality: 75, size: 512 },
    { fps: 20, quality: 65, size: 512 },
    { fps: 15, quality: 55, size: 512 },
    { fps: 12, quality: 50, size: 448 },
    { fps: 10, quality: 45, size: 384 },
    { fps: 8, quality: 40, size: 320 },
];

/* ─── Active imports (for /tgstop) ─── */
export const activeImports = new Map(); // chatId → AbortController

export function abortImport(chatId) {
    const ctrl = activeImports.get(chatId);
    if (ctrl) {
        ctrl.abort();
        activeImports.delete(chatId);
        return true;
    }
    return false;
}

export function isImportActive(chatId) {
    return activeImports.has(chatId);
}

class TelegramStickerService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-tg-stickers');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    get token() {
        return config.TELEGRAM_BOT_TOKEN;
    }

    get isConfigured() {
        return Boolean(this.token);
    }

    /** Parse pack name from URL or raw input. */
    parsePackInput(input) {
        if (!input || typeof input !== 'string') return null;
        const trimmed = input.trim();

        let m = trimmed.match(/t\.me\/addstickers\/([A-Za-z0-9_-]+)$/i);
        if (m) return m[1];

        m = trimmed.match(/tg:\/\/addstickers\?set=([A-Za-z0-9_-]+)/i);
        if (m) return m[1];

        if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;
        return null;
    }

    /** Fetch sticker set metadata from Telegram Bot API. */
    async getStickerSet(packName) {
        if (!this.isConfigured) {
            throw new Error('Telegram Bot token not configured. Set TELEGRAM_BOT_TOKEN in .env');
        }

        const url = `${TG_API}/bot${this.token}/getStickerSet?name=${encodeURIComponent(packName)}`;
        const res = await axios.get(url, { timeout: 15000 });

        if (!res.data?.ok) {
            throw new Error(`Telegram API: ${res.data?.description || 'Unknown error'}`);
        }
        return res.data.result;
    }

    /**
     * Resolve an ffmpeg binary. Prefers FFMPEG_PATH, then the bundled
     * ffmpeg-static (which ships libwebp_anim), then whatever is on PATH.
     * Matches how StickerController resolves it.
     */
    get ffmpegPath() {
        if (this._ffmpegPath) return this._ffmpegPath;
        let resolved = process.env.FFMPEG_PATH;
        if (!resolved) {
            try {
                const req = createRequire(import.meta.url);
                const staticPath = req('ffmpeg-static');
                resolved = staticPath && fs.existsSync(staticPath) ? staticPath : 'ffmpeg';
            } catch {
                resolved = 'ffmpeg';
            }
        }
        this._ffmpegPath = resolved;
        return resolved;
    }

    /**
     * Run ffmpeg without blocking the event loop.
     *
     * execFileSync would stall every other conversion (and the rest of the
     * bot) for the duration of the encode, which made CONVERT_CONCURRENCY
     * meaningless — the parallel tasks just queued behind each other.
     */
    _runFfmpeg(args, timeout = 120000) {
        return execFileAsync(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
            timeout,
            maxBuffer: 1 << 24,
            windowsHide: true,
        });
    }

    /** Get the download URL and remote file path for a sticker by file_id. */
    async getFile(fileId) {
        const url = `${TG_API}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const res = await axios.get(url, { timeout: 10000 });

        if (!res.data?.ok) {
            throw new Error(`getFile failed: ${res.data?.description || 'unknown'}`);
        }

        const filePath = res.data.result.file_path;
        return {
            filePath,
            url: `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        };
    }

    /** Download a sticker file to a temp path. */
    async downloadSticker(sticker, index) {
        const fileId = sticker.file_id;
        const isAnimated = sticker.is_animated || false;
        const isVideo = sticker.is_video || false;
        const emoji = sticker.emoji || '❓';

        const { filePath, url: fileUrl } = await this.getFile(fileId);
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        // Trust the extension Telegram reports — video stickers are WEBM/VP9,
        // not MP4, and ffmpeg needs the right container hint.
        const remoteExt = (path.extname(filePath || '') || '').toLowerCase();
        const format = isAnimated ? 'tgs' : isVideo ? 'video' : 'webp';
        const ext = remoteExt || (format === 'tgs' ? '.tgs' : format === 'video' ? '.webm' : '.webp');

        const buffer = Buffer.from(res.data);
        const tempPath = path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        return { tempPath, buffer, size: buffer.length, isAnimated, isVideo, emoji, format, ext, index };
    }

    /* ──────────────────────────────────────────────
     *  Lottie renderer — @lottiefiles/dotlottie-web (ThorVG WASM)
     *  running on @napi-rs/canvas. Replaces a hand-rolled SVG-based
     *  Lottie renderer that failed on the majority of real TGS packs
     *  (mattes, masks, expressions, precomps, gradient strokes, etc).
     * ────────────────────────────────────────────── */

    /**
     * Render a TGS (gzipped Lottie JSON) into PNG frames with alpha intact.
     *
     * Frames are sampled evenly across the animation's real duration rather
     * than at a fixed count, so playback speed matches the original instead
     * of every sticker being squashed into the same runtime.
     *
     * Uses the official LottieFiles WASM renderer; if it can't load a given
     * Lottie, that's a real bug in the Lottie file — no hand-written renderer
     * would be more forgiving.
     */
    async _renderLottieFrames(tgsBuffer, { fps = 20, size = STICKER_SIZE } = {}) {
        // TGS is gzipped, but some packs serve bare JSON — accept both.
        let lottieJson;
        if (tgsBuffer[0] === 0x1f && tgsBuffer[1] === 0x8b) {
            lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        } else {
            lottieJson = tgsBuffer.toString('utf-8');
        }
        const lottie = JSON.parse(lottieJson);
        const srcFps = lottie.fr || 60;

        // Square canvas at sticker resolution — Lottie scales to fit the
        // canvas, and TGS is square by spec.
        const canvas = createCanvas(size, size);
        const dot = new DotLottie({
            canvas,
            data: lottieJson,
            autoplay: false,
            loop: false,
        });

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('dotlottie load timeout')), 15_000);
            dot.addEventListener('load', () => { clearTimeout(timer); resolve(); });
            dot.addEventListener('loadError', (e) => {
                clearTimeout(timer);
                reject(new Error(`lottie load error: ${e?.error?.message || 'unknown'}`));
            });
        });

        const totalFrames = dot.totalFrames || (lottie.op - lottie.ip) || srcFps;
        const durationSec = Math.min(MAX_ANIM_SECONDS, Math.max(0.2, totalFrames / srcFps));
        const frameCount = Math.max(2, Math.min(120, Math.round(durationSec * fps)));

        // Sampling spans the whole animation even when durationSec clamps, so an
        // over-long source plays slightly fast rather than being cut off — a
        // truncated loop looks broken every time a sticker repeats. Telegram caps
        // TGS at 3s anyway, so the clamp rarely bites.
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
            // Fractional frames are fine — ThorVG interpolates.
            dot.setFrame((i / frameCount) * totalFrames);
            frames.push(await canvas.encode('png'));
        }
        dot.destroy();

        if (!frames.length) throw new Error('lottie produced no frames');
        return { frames, size, fps, durationSec, totalFrames };
    }

    /** Write rendered PNG frames to a scratch dir for ffmpeg to consume. */
    _writeFrameDir(frames) {
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });
        for (let i = 0; i < frames.length; i++) {
            fs.writeFileSync(path.join(frameDir, `f_${String(i + 1).padStart(4, '0')}.png`), frames[i]);
        }
        return frameDir;
    }

    _rmFrameDir(frameDir) {
        try {
            for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f));
            fs.rmdirSync(frameDir);
        } catch {}
    }

    /**
     * Encode a frame dir into an animated WebP with real VP8X/ANIM/ANMF chunks.
     *
     * ffmpeg does the frame-rate drop and the downscale itself, so one set of
     * rasterised frames feeds every rung of the quality ladder — re-rendering
     * the Lottie per rung was costing ~4s a sticker.
     */
    async _encodeAnimatedWebp(frameDir, baseFps, { fps, quality, size }) {
        const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(6).toString('hex')}.webp`);
        try {
            await this._runFfmpeg([
                '-y',
                '-framerate', String(baseFps),
                '-i', path.join(frameDir, 'f_%04d.png'),
                '-vcodec', 'libwebp_anim',
                '-lossless', '0',
                '-q:v', String(quality),
                // compression_level 5 more than doubles encode time for ~5%
                // smaller output — not worth it when the ladder may re-encode.
                '-compression_level', '3',
                '-loop', '0',
                '-pix_fmt', 'yuva420p',
                '-vf', `fps=${fps},scale=${size}:${size}:flags=lanczos`,
                '-an', '-vsync', '0',
                outputPath,
            ]);
            return fs.readFileSync(outputPath);
        } finally {
            this._cleanup(outputPath);
        }
    }

    /** Pure-JS animated WebP assembly, for hosts whose ffmpeg lacks libwebp. */
    async _framesToAnimatedWebpMux(frames, { fps, quality, size }) {
        const sharp = (await import('sharp')).default;
        // node-webpmux is CommonJS — the named export is only reachable
        // through `.default` under ESM.
        const mod = await import('node-webpmux');
        const WebpImage = (mod.default ?? mod).Image;
        if (typeof WebpImage?.initLib !== 'function') {
            throw new Error('node-webpmux Image unavailable');
        }
        await WebpImage.initLib();

        const delay = Math.round(1000 / fps);
        const webpFrames = [];
        for (const png of frames) {
            webpFrames.push(
                await sharp(png)
                    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality, alphaQuality: 100 })
                    .toBuffer()
            );
        }

        const img = new WebpImage();
        await img.load(webpFrames[0]);
        if (!img.hasAnim) await img.convertToAnim();

        return await img.save(null, {
            frames: await Promise.all(
                webpFrames.map((buffer) => WebpImage.generateFrame({ buffer, delay }))
            ),
            width: size,
            height: size,
            loops: 0,
            bgColor: [0, 0, 0, 0],
        });
    }

    /** True if the buffer is an animated WebP (has an ANIM chunk). */
    _hasAnimChunk(buffer) {
        return Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('ANIM'));
    }

    /**
     * Walk the quality ladder until the animated WebP fits WhatsApp's limit.
     *
     * The Lottie is rasterised exactly once, at the top rung; ffmpeg derives
     * every lower rung from those frames. Rungs are also skipped predictively
     * — a sticker that came out 3× over the limit has no reason to try the
     * rung that only shaves 20% off.
     */
    async tgsToAnimatedWebp(tgsBuffer) {
        const top = ANIM_LADDER[0];
        const base = await this._renderLottieFrames(tgsBuffer, { fps: top.fps, size: STICKER_SIZE });
        const frameDir = this._writeFrameDir(base.frames);

        // Rough bits-per-output cost of a rung, used only to rank them.
        const weight = (r) => r.fps * r.size * r.size * (r.quality + 25);
        const topWeight = weight(top);

        let best = null;
        let ffmpegUsable = false;

        try {
            for (let i = 0; i < ANIM_LADDER.length; i++) {
                const rung = ANIM_LADDER[i];
                try {
                    const out = await this._encodeAnimatedWebp(frameDir, top.fps, rung);
                    if (!out?.length || !this._hasAnimChunk(out)) {
                        throw new Error('encoder produced no ANIM chunk');
                    }
                    ffmpegUsable = true;
                    if (!best || out.length < best.length) best = out;

                    if (out.length <= ANIM_BUDGET) {
                        logger.info(
                            `TGS → animated WebP: ${out.length}b, ${base.frames.length} src frames, `
                            + `${rung.fps}fps, q${rung.quality}, ${rung.size}px`
                        );
                        return out;
                    }

                    // Skip ahead to the first rung light enough to plausibly fit.
                    const needed = (ANIM_BUDGET / out.length) * (weight(rung) / topWeight);
                    while (i + 1 < ANIM_LADDER.length && weight(ANIM_LADDER[i + 1]) / topWeight > needed) {
                        i++;
                    }
                    logger.info(`TGS → ${out.length}b at ${rung.fps}fps/q${rung.quality} — over limit, stepping down`);
                } catch (err) {
                    logger.warn(`TGS ladder rung ${rung.fps}fps/q${rung.quality} failed: ${err.message}`);
                }
            }

            // Everything overshot the limit — send the smallest we managed rather
            // than dropping to a static frame; WhatsApp usually still accepts it.
            if (best) {
                logger.warn(`TGS → animated WebP stayed over limit (${best.length}b), sending smallest attempt`);
                return best;
            }

            if (!ffmpegUsable) {
                logger.warn('libwebp_anim unavailable, falling back to node-webpmux');
                return await this._framesToAnimatedWebpMux(base.frames, { fps: 15, quality: 60, size: STICKER_SIZE });
            }
            throw new Error('all animated WebP encodings failed');
        } finally {
            this._rmFrameDir(frameDir);
        }
    }

    /**
     * Convert a Telegram video sticker (WEBM/VP9, sometimes MP4) into an
     * animated WebP so WhatsApp renders it as a sticker instead of a video.
     */
    async videoToAnimatedWebp(buffer, ext = '.webm') {
        const inputPath = path.join(this.tempDir, `vin_${crypto.randomBytes(6).toString('hex')}${ext}`);
        fs.writeFileSync(inputPath, buffer);
        let best = null;

        try {
            for (const rung of ANIM_LADDER) {
                const outputPath = path.join(this.tempDir, `vout_${crypto.randomBytes(6).toString('hex')}.webp`);
                try {
                    await this._runFfmpeg([
                        '-y',
                        '-i', inputPath,
                        '-vcodec', 'libwebp_anim',
                        '-lossless', '0',
                        '-q:v', String(rung.quality),
                        '-compression_level', '3',
                        '-loop', '0',
                        '-pix_fmt', 'yuva420p',
                        '-vf',
                        `fps=${rung.fps},scale=${rung.size}:${rung.size}:force_original_aspect_ratio=decrease:flags=lanczos,`
                        + `pad=${rung.size}:${rung.size}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
                        '-an', '-vsync', '0',
                        '-t', String(MAX_ANIM_SECONDS),
                        outputPath,
                    ]);
                    const out = fs.readFileSync(outputPath);
                    if (!out.length || !this._hasAnimChunk(out)) throw new Error('no ANIM chunk');
                    if (!best || out.length < best.length) best = out;
                    if (out.length <= ANIM_BUDGET) {
                        logger.info(`video → animated WebP: ${out.length}b at ${rung.fps}fps/q${rung.quality}`);
                        return out;
                    }
                } catch (err) {
                    logger.warn(`video rung ${rung.fps}fps/q${rung.quality} failed: ${err.message}`);
                } finally {
                    this._cleanup(outputPath);
                }
            }
        } finally {
            this._cleanup(inputPath);
        }

        if (best) return best;
        throw new Error('video → animated WebP failed');
    }

    /** First-frame PNG for the static fallback path. */
    async tgsToStaticFrame(tgsBuffer) {
        const { frames } = await this._renderLottieFrames(tgsBuffer, { fps: 1, size: STICKER_SIZE });
        return frames[0];
    }

    /* ──────────────────────────────────────────────
     *  Sticker conversion pipeline
     * ────────────────────────────────────────────── */

    isStaticWebp(buffer) {
        if (!buffer || buffer.length < 12) return false;
        return buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
    }

    /**
     * Convert a sticker buffer to a WhatsApp sticker.
     * Returns { buffer, type: 'sticker', isAnimated }.
     *
     * Everything becomes a WebP sticker — animated where the source was
     * animated. Nothing is emitted as a video message, because WhatsApp
     * renders those as attachments rather than stickers.
     */
    async convertToWhatsAppSticker(buffer, emoji, format) {
        const sharp = (await import('sharp')).default;

        // Telegram video sticker (WEBM/VP9, occasionally MP4) → animated WebP
        if (format === 'video' || format === 'mp4' || format === 'webm') {
            try {
                const animWebp = await this.videoToAnimatedWebp(buffer, format === 'mp4' ? '.mp4' : '.webm');
                return { buffer: animWebp, type: 'sticker', isAnimated: true };
            } catch (err) {
                logger.warn(`video → animated WebP failed: ${err.message}, falling back to first frame`);
                const still = await this._videoFirstFrameWebp(buffer, format === 'mp4' ? '.mp4' : '.webm');
                return { buffer: still, type: 'sticker', isAnimated: false };
            }
        }

        // Animated TGS → animated WebP, static first frame only as last resort
        if (format === 'tgs') {
            try {
                const animWebp = await this.tgsToAnimatedWebp(buffer);
                return { buffer: animWebp, type: 'sticker', isAnimated: true };
            } catch (err) {
                logger.warn(`TGS → animated WebP failed: ${err.message}`);
            }

            try {
                logger.info('TGS → static frame fallback');
                const pngBuffer = await this.tgsToStaticFrame(buffer);
                const fallback = await sharp(pngBuffer)
                    .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80, alphaQuality: 100 })
                    .toBuffer();
                return { buffer: fallback, type: 'sticker', isAnimated: false };
            } catch (e2) {
                throw new Error(`Animated sticker conversion failed: ${e2.message}`);
            }
        }

        // Static WebP — pass through when it already fits, else recompress.
        // An animated source WebP must keep its frames, so decode it animated.
        const sourceIsAnimated = this._hasAnimChunk(buffer);

        if (!sourceIsAnimated && buffer.length <= STATIC_BUDGET && this.isStaticWebp(buffer)) {
            return { buffer, type: 'sticker', isAnimated: false };
        }

        const limit = sourceIsAnimated ? ANIM_BUDGET : STATIC_BUDGET;
        for (const quality of [80, 60, 45]) {
            const out = await sharp(buffer, { animated: sourceIsAnimated })
                .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality, alphaQuality: quality >= 60 ? 100 : 80 })
                .toBuffer();
            if (out.length <= limit || quality === 45) {
                return { buffer: out, type: 'sticker', isAnimated: sourceIsAnimated };
            }
        }
    }

    /** Single frame of a video sticker as a static WebP, for the failure path. */
    async _videoFirstFrameWebp(buffer, ext) {
        const inputPath = path.join(this.tempDir, `vf_${crypto.randomBytes(6).toString('hex')}${ext}`);
        const outputPath = path.join(this.tempDir, `vf_${crypto.randomBytes(6).toString('hex')}.webp`);
        fs.writeFileSync(inputPath, buffer);
        try {
            await this._runFfmpeg([
                '-y', '-i', inputPath,
                '-frames:v', '1',
                '-vcodec', 'libwebp', '-lossless', '0', '-q:v', '80',
                '-pix_fmt', 'yuva420p',
                '-vf',
                `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,`
                + `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=#00000000`,
                '-an',
                outputPath,
            ], 20000);
            return fs.readFileSync(outputPath);
        } finally {
            this._cleanup(inputPath);
            this._cleanup(outputPath);
        }
    }

    /**
     * Fetch and convert an entire sticker pack.
     * @param {string} packName
     * @param {Function} onProgress - (convertedCount, failedCount, phase)
     * @param {AbortSignal} [signal] - AbortSignal to cancel
     * @returns {{ pack, stickers, errors }}
     */
    async fetchAndConvertPack(packName, onProgress, signal) {
        const report = (converted, failed, phase) => {
            try { onProgress?.(converted, failed, phase); } catch {}
        };

        const pack = await this.getStickerSet(packName);
        const totalStickers = pack.stickers?.length || 0;

        if (!totalStickers) {
            return { pack, stickers: [], errors: ['Empty sticker pack'] };
        }

        const toProcess = pack.stickers;
        const results = [];
        const errors = [];
        let convertedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < toProcess.length; i += DOWNLOAD_CONCURRENCY) {
            // Check abort before each batch
            if (signal?.aborted) {
                errors.push('Import cancelled by user');
                break;
            }

            const batch = toProcess.slice(i, i + DOWNLOAD_CONCURRENCY);

            const downloads = await Promise.allSettled(
                batch.map((sticker, j) => this.downloadSticker(sticker, i + j))
            );

            // Convert in parallel — rendering and encoding are CPU-bound, so on
            // a multi-core host this is close to a linear speedup. CONVERT_
            // CONCURRENCY collapses to 1 on small instances so the rest of the
            // bot keeps its share of the CPU.
            for (let k = 0; k < downloads.length; k += CONVERT_CONCURRENCY) {
                if (signal?.aborted) {
                    errors.push('Import cancelled by user');
                    break;
                }

                const slice = downloads.slice(k, k + CONVERT_CONCURRENCY);
                await Promise.all(slice.map(async (result, s) => {
                    const j = k + s;

                    if (result.status === 'rejected') {
                        failedCount++;
                        errors.push(`Sticker ${i + j + 1}: ${result.reason?.message || 'download failed'}`);
                        report(convertedCount, failedCount, 'convert');
                        return;
                    }

                    const dl = result.value;
                    try {
                        const { buffer: converted, type, isAnimated } =
                            await this.convertToWhatsAppSticker(dl.buffer, dl.emoji, dl.format);
                        const waBuffer = await this.applyStickerMetadata(converted);
                        results.push({
                            buffer: waBuffer,
                            emoji: dl.emoji,
                            index: dl.index,
                            type,
                            isAnimated: isAnimated || false,
                        });
                        convertedCount++;
                        report(convertedCount, failedCount, 'convert');
                    } catch (err) {
                        failedCount++;
                        errors.push(`Sticker ${i + j + 1} (${dl.emoji}): ${err.message}`);
                        report(convertedCount, failedCount, 'convert');
                    } finally {
                        this._cleanup(dl.tempPath);
                    }
                }));
            }

            if (signal?.aborted) break;
        }

        // Parallel conversion finishes out of order — restore pack order.
        results.sort((a, b) => a.index - b.index);

        report(convertedCount, failedCount, 'done');
        return { pack, stickers: results, errors };
    }

    /**
     * Stamp the bot's default pack/author EXIF onto a sticker, so imported
     * Telegram stickers carry the same attribution as ones the bot makes
     * itself (STICKER_PACK_NAME / STICKER_PACK_AUTHOR).
     *
     * Verified not to disturb the ANIM/ANMF chunks or the alpha channel of an
     * animated WebP — it only appends an EXIF chunk (~210 bytes). Best-effort:
     * a sticker without metadata still beats no sticker.
     */
    async applyStickerMetadata(buffer) {
        const pack = config.STICKER_PACK_NAME || '';
        const author = config.STICKER_PACK_AUTHOR || '';
        if (!pack && !author) return buffer;

        try {
            const WSF = (await import('wa-sticker-formatter')).default;
            const exif = new WSF.Exif({ pack, author });
            const stamped = await exif.add(buffer);
            return stamped?.length ? stamped : buffer;
        } catch (err) {
            logger.warn(`Sticker metadata injection failed: ${err?.message || err}`);
            return buffer;
        }
    }

    _cleanup(filePath) {
        try { fs.unlinkSync(filePath); } catch {}
    }

    cleanup() {
        try {
            const files = fs.readdirSync(this.tempDir);
            for (const f of files) {
                fs.unlinkSync(path.join(this.tempDir, f));
            }
        } catch {}
    }
}

export const telegramStickerService = new TelegramStickerService();
export default TelegramStickerService;
