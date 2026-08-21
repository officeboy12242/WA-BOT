/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * - Static WebP → resize + compress
 * - Animated TGS (gzipped Lottie JSON) → real Lottie frames via
 *   @lottiefiles/dotlottie-web (ThorVG WASM engine) on @napi-rs/canvas →
 *   MP4 video sticker (primary, most reliable on WhatsApp) or animated WebP.
 * - Video stickers (MP4/WEBM) → sent directly as WhatsApp video sticker.
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
import { execSync } from 'child_process';
import { createCanvas } from '@napi-rs/canvas';
import { DotLottie } from '@lottiefiles/dotlottie-web';

const TG_API = 'https://api.telegram.org';
const STICKER_WEBP_MAX = 100 * 1024; // 100 KB — WhatsApp sticker limit
const ANIM_WEBP_MAX = 500 * 1024;    // 500 KB — WhatsApp animated sticker limit
const VIDEO_STICKER_MAX = 1 * 1024 * 1024; // 1 MB — WhatsApp video sticker limit
const DOWNLOAD_CONCURRENCY = 3;
const ANIM_FRAME_COUNT = 20; // Frames to render for animated stickers
const ANIM_FPS = 15;         // Target FPS for animated WebP

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

    /** Get the file download URL for a sticker by file_id. */
    async getFileUrl(fileId) {
        const url = `${TG_API}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const res = await axios.get(url, { timeout: 10000 });

        if (!res.data?.ok) {
            throw new Error(`getFile failed: ${res.data?.description || 'unknown'}`);
        }

        const filePath = res.data.result.file_path;
        return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    }

    /** Download a sticker file to a temp path. */
    async downloadSticker(sticker, index) {
        const fileId = sticker.file_id;
        const isAnimated = sticker.is_animated || false;
        const isVideo = sticker.is_video || false;
        const emoji = sticker.emoji || '❓';
        const format = isVideo ? 'mp4' : isAnimated ? 'tgs' : 'webp';

        const fileUrl = await this.getFileUrl(fileId);
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        const buffer = Buffer.from(res.data);
        const ext = format === 'mp4' ? '.mp4' : format === 'tgs' ? '.tgs' : '.webp';
        const tempPath = path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        return { tempPath, buffer, size: buffer.length, isAnimated, isVideo, emoji, format, index };
    }

    /* ──────────────────────────────────────────────
     *  Lottie renderer — @lottiefiles/dotlottie-web (ThorVG WASM)
     *  running on @napi-rs/canvas. Replaces a hand-rolled SVG-based
     *  Lottie renderer that failed on the majority of real TGS packs
     *  (mattes, masks, expressions, precomps, gradient strokes, etc).
     * ────────────────────────────────────────────── */

    /**
     * Render N frames from a TGS (gzipped Lottie JSON) buffer as PNG buffers.
     * Uses the official LottieFiles WASM renderer; if it can't load a given
     * Lottie, that's a real bug in the Lottie file — no hand-written renderer
     * would be more forgiving.
     */
    async _renderLottieFrames(tgsBuffer, frameCount = ANIM_FRAME_COUNT) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);
        const width = lottie.w || 512;
        const height = lottie.h || 512;
        const frameRate = lottie.fr || 30;

        const canvas = createCanvas(width, height);
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

        const totalFrames = dot.totalFrames || lottie.op || 30;
        const step = Math.max(1, Math.floor(totalFrames / frameCount));
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
            const f = Math.min(totalFrames - 1, i * step);
            dot.setFrame(f);
            frames.push(await canvas.encode('png'));
        }
        dot.destroy();
        return { frames, width, height, frameRate };
    }

    /** Assemble PNG frames into an animated WebP with proper ANIM/ANMF chunks. */
    async tgsToAnimatedWebp(tgsBuffer) {
        const sharp = (await import('sharp')).default;
        const { Image: WebpImage } = await import('node-webpmux');
        await WebpImage.initLib();

        const { frames, width, height, frameRate } = await this._renderLottieFrames(tgsBuffer);
        const fps = Math.min(ANIM_FPS, frameRate);
        const delayMs = Math.round(1000 / fps);

        const webpFrames = [];
        for (const png of frames) {
            webpFrames.push(await sharp(png).webp({ quality: 80 }).toBuffer());
        }

        const img = new WebpImage();
        await img.load(webpFrames[0]);
        if (!img.hasAnim) await img.convertToAnim();

        const out = await img.save(null, {
            frames: webpFrames.map((buf) => ({ buffer: buf, delay: delayMs, blend: true, dispose: false })),
            width,
            height,
            loops: 0,
        });
        logger.info(`TGS → animated WebP: ${out.length} bytes, ${webpFrames.length} frames, ${fps}fps`);
        return out;
    }

    /** Assemble PNG frames into an MP4 video sticker via ffmpeg. */
    async tgsToMp4Video(tgsBuffer) {
        const { frames, width, height, frameRate } = await this._renderLottieFrames(tgsBuffer);
        const fps = Math.min(ANIM_FPS, frameRate);
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });
        try {
            for (let i = 0; i < frames.length; i++) {
                fs.writeFileSync(path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.png`), frames[i]);
            }
            const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(4).toString('hex')}.mp4`);
            execSync(
                `ffmpeg -y -framerate ${fps} -i "${path.join(frameDir, 'frame_%04d.png')}" `
                + `-vf "scale=${width}:${height},format=yuv420p" `
                + `-c:v libx264 -preset fast -crf 26 -pix_fmt yuv420p `
                + `-an -movflags +faststart -t 6 "${outputPath}" 2>&1`,
                { timeout: 30000, stdio: 'pipe' }
            );
            const mp4Buffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);
            return mp4Buffer;
        } finally {
            try { for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f)); fs.rmdirSync(frameDir); } catch {}
        }
    }

    /** First-frame PNG for the static fallback path. */
    async tgsToStaticFrame(tgsBuffer) {
        const { frames } = await this._renderLottieFrames(tgsBuffer, 1);
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
     * Convert a sticker buffer to WhatsApp-compatible format.
     * Returns { buffer, type } where type is 'sticker' or 'video'.
     */
    async convertToWhatsAppSticker(buffer, emoji, format) {
        const sharp = (await import('sharp')).default;

        // Video stickers — send as MP4 directly
        if (format === 'mp4') {
            if (buffer.length <= VIDEO_STICKER_MAX) {
                return { buffer, type: 'video' };
            }
            // Try to compress with ffmpeg
            try {
                const tmpIn = path.join(this.tempDir, `vid_${crypto.randomBytes(4).toString('hex')}.mp4`);
                const tmpOut = path.join(this.tempDir, `vid_${crypto.randomBytes(4).toString('hex')}.mp4`);
                fs.writeFileSync(tmpIn, buffer);
                execSync(
                    `ffmpeg -y -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2" ` +
                    `-c:v libx264 -preset fast -crf 28 -an -t 6 "${tmpOut}" 2>&1`,
                    { timeout: 20000, stdio: 'pipe' }
                );
                const compressed = fs.readFileSync(tmpOut);
                this._cleanup(tmpIn);
                this._cleanup(tmpOut);
                if (compressed.length <= VIDEO_STICKER_MAX) {
                    return { buffer: compressed, type: 'video' };
                }
            } catch {}
            // Fallback: send anyway, WhatsApp may accept slightly over limit
            return { buffer, type: 'video' };
        }

        // Animated TGS — MP4 first (WhatsApp accepts video stickers most reliably),
        // then animated WebP (some clients still prefer this), then static frame.
        if (format === 'tgs') {
            // 1st: MP4 video sticker — most reliable animated path on WhatsApp
            try {
                const mp4Buffer = await this.tgsToMp4Video(buffer);
                if (mp4Buffer && mp4Buffer.length > 0 && mp4Buffer.length <= VIDEO_STICKER_MAX) {
                    logger.info(`TGS → MP4 video sticker: ${mp4Buffer.length} bytes`);
                    return { buffer: mp4Buffer, type: 'video' };
                }
                logger.info(`TGS → MP4 too large or empty: ${mp4Buffer?.length ?? 0}b, trying animated WebP…`);
            } catch (err) {
                logger.warn(`TGS → MP4 failed: ${err.message}`);
            }

            // 2nd: Animated WebP (proper ANIM chunk via node-webpmux)
            try {
                const animWebp = await this.tgsToAnimatedWebp(buffer);
                if (animWebp && animWebp.length > 0 && animWebp.length <= ANIM_WEBP_MAX) {
                    const hasAnim = animWebp.includes(Buffer.from('ANIM'));
                    if (hasAnim) {
                        return { buffer: animWebp, type: 'sticker', isAnimated: true };
                    }
                    logger.info('Animated WebP missing ANIM marker, falling to static.');
                }
            } catch (err) {
                logger.warn(`TGS → animated WebP failed: ${err.message}`);
            }

            // 3rd: Static first frame fallback
            try {
                logger.info('TGS → static frame fallback');
                const pngBuffer = await this.tgsToStaticFrame(buffer);
                const fallback = await sharp(pngBuffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80, alphaQuality: 100 })
                    .toBuffer();
                return { buffer: fallback, type: 'sticker' };
            } catch (e2) {
                throw new Error(`Animated sticker conversion failed: ${e2.message}`);
            }
        }

        // Static WebP — compress if needed
        if (buffer.length <= STICKER_WEBP_MAX && this.isStaticWebp(buffer)) {
            return { buffer, type: 'sticker' };
        }

        const converted = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80, alphaQuality: 100 })
            .toBuffer();

        if (converted.length <= STICKER_WEBP_MAX) {
            return { buffer: converted, type: 'sticker' };
        }

        const smaller = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 50, alphaQuality: 80 })
            .toBuffer();

        return { buffer: smaller, type: 'sticker' };
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

            for (let j = 0; j < downloads.length; j++) {
                // Check abort before each conversion
                if (signal?.aborted) {
                    errors.push('Import cancelled by user');
                    break;
                }

                const result = downloads[j];
                const sticker = batch[j];

                if (result.status === 'rejected') {
                    failedCount++;
                    errors.push(`Sticker ${i + j + 1}: ${result.reason?.message || 'download failed'}`);
                    report(convertedCount, failedCount, 'convert');
                    continue;
                }

                const dl = result.value;

                try {
                    const { buffer: waBuffer, type, isAnimated } = await this.convertToWhatsAppSticker(dl.buffer, dl.emoji, dl.format);
                    results.push({
                        buffer: waBuffer,
                        emoji: dl.emoji,
                        index: dl.index,
                        type, // 'sticker' or 'video'
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
            }

            if (signal?.aborted) break;
        }

        report(convertedCount, failedCount, 'done');
        return { pack, stickers: results, errors };
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
