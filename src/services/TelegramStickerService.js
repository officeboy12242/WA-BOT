/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * - Static WebP → resize + compress
 * - Animated TGS → render multiple Lottie frames → ffmpeg animated WebP
 * - Video stickers (MP4) → send directly as WhatsApp video sticker
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

    /** Create animated WebP from TGS using multi-frame Lottie rendering + ffmpeg. */
    async tgsToAnimatedWebp(tgsBuffer) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);

        const width = lottie.w || 512;
        const height = lottie.h || 512;
        const totalFrames = lottie.op || lottie.fr || 30;
        const frameRate = lottie.fr || 30;

        const { createCanvas } = await import('@napi-rs/canvas');

        // Create temp dir for frames
        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });

        try {
            // Calculate which frames to render (spread evenly across the animation)
            const frameStep = Math.max(1, Math.floor(totalFrames / ANIM_FRAME_COUNT));
            const framesToRender = [];
            for (let f = 0; f < totalFrames; f += frameStep) {
                if (framesToRender.length >= ANIM_FRAME_COUNT) break;
                framesToRender.push(f);
            }

            // Render each frame
            for (let i = 0; i < framesToRender.length; i++) {
                const frame = framesToRender[i];
                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, width, height);

                this._renderLottieFrame(ctx, lottie, frame, width, height);

                const framePath = path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.png`);
                fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
            }

            // Use ffmpeg to create animated WebP
            const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(4).toString('hex')}.webp`);
            const fps = Math.min(ANIM_FPS, frameRate);

            execSync(
                `ffmpeg -y -framerate ${fps} -i "${path.join(frameDir, 'frame_%04d.png')}" ` +
                `-vf "scale=${width}:${height}" ` +
                `-vcodec libwebp -lossless 0 -q:v 60 -loop 0 -preset drawing ` +
                `-an -vsync 0 "${outputPath}" 2>&1`,
                { timeout: 30000, stdio: 'pipe' }
            );

            const webpBuffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath);

            return webpBuffer;
        } finally {
            // Cleanup frame directory
            try {
                const files = fs.readdirSync(frameDir);
                for (const f of files) fs.unlinkSync(path.join(frameDir, f));
                fs.rmdirSync(frameDir);
            } catch {}
        }
    }

    /** Create MP4 video sticker from TGS using multi-frame Lottie rendering + ffmpeg. */
    async tgsToMp4Video(tgsBuffer) {
        const lottieJson = zlib.gzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);

        const width = lottie.w || 512;
        const height = lottie.h || 512;
        const totalFrames = lottie.op || lottie.fr || 30;
        const frameRate = lottie.fr || 30;

        const { createCanvas } = await import('@napi-rs/canvas');

        const frameDir = path.join(this.tempDir, `frames_${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(frameDir, { recursive: true });

        try {
            const frameStep = Math.max(1, Math.floor(totalFrames / ANIM_FRAME_COUNT));
            const framesToRender = [];
            for (let f = 0; f < totalFrames; f += frameStep) {
                if (framesToRender.length >= ANIM_FRAME_COUNT) break;
                framesToRender.push(f);
            }

            for (let i = 0; i < framesToRender.length; i++) {
                const frame = framesToRender[i];
                const canvas = createCanvas(width, height);
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, width, height);
                this._renderLottieFrame(ctx, lottie, frame, width, height);
                const framePath = path.join(frameDir, `frame_${String(i + 1).padStart(4, '0')}.png`);
                fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
            }

            const outputPath = path.join(this.tempDir, `anim_${crypto.randomBytes(4).toString('hex')}.mp4`);
            const fps = Math.min(ANIM_FPS, frameRate);

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
            try {
                const files = fs.readdirSync(frameDir);
                for (const f of files) fs.unlinkSync(path.join(frameDir, f));
                fs.rmdirSync(frameDir);
            } catch {}
        }
    }

    /** Fallback: extract just the first frame as static WebP. */
    async tgsToStaticFrame(tgsBuffer) {
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);

        const width = lottie.w || 512;
        const height = lottie.h || 512;

        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);

        this._renderLottieFrame(ctx, lottie, 0, width, height);

        return canvas.toBuffer('image/png');
    }

    /* ──────────────────────────────────────────────
     *  Minimal Lottie frame renderer
     * ────────────────────────────────────────────── */

    _renderLottieFrame(ctx, lottie, frame, w, h) {
        const layers = lottie.layers || [];
        const assets = lottie.assets || [];
        const assetMap = new Map();
        for (const a of assets) {
            if (a.id) assetMap.set(a.id, a);
        }

        const sorted = [...layers].sort((a, b) => (a.zi ?? 0) - (b.zi ?? 0));

        for (const layer of sorted) {
            this._renderLayer(ctx, layer, frame, w, h, assetMap, lottie);
        }
    }

    _renderLayer(ctx, layer, frame, w, h, assetMap, lottie) {
        if (!layer) return;

        // Skip invisible layers
        const ip = layer.ip ?? 0;
        const op = layer.op ?? Infinity;
        if (frame < ip || frame > op) return;

        const opacity = this._resolveProp(layer.ks?.o, frame) ?? 100;
        if (opacity <= 0) return;

        // Handle precomp layers (type 0) — recurse into nested composition
        if (layer.ty === 0) {
            const refId = layer.refId;
            const compAsset = assetMap.get(refId);
            if (compAsset?.layers) {
                ctx.save();
                this._applyTransform(ctx, layer.ks?.tr, frame, w, h);
                ctx.globalAlpha = opacity / 100;
                for (const subLayer of compAsset.layers) {
                    this._renderLayer(ctx, subLayer, frame, w, h, assetMap, lottie);
                }
                ctx.restore();
            }
            return;
        }

        if (layer.ty === 1) return; // solid — skip
        if (layer.ty === 3) return; // null layer
        if (layer.ty === 2) return; // image layer — can't fetch in Node

        ctx.save();
        ctx.globalAlpha = opacity / 100;

        // Apply layer transform
        this._applyTransform(ctx, layer.ks?.tr, frame, w, h);

        // Handle masks (mm = mask mode)
        if (layer.masks && layer.masks.length > 0) {
            this._applyMask(ctx, layer.masks, frame, assetMap, w, h);
        }

        if (layer.ty === 4) {
            // Shape layer
            this._renderShapeGroup(ctx, layer.shapes, frame, assetMap);
        }

        ctx.restore();
    }

    _applyMask(ctx, masks, frame, assetMap, w, h) {
        // Basic mask support — draw mask path as clip
        for (const mask of masks) {
            const maskRef = mask.refId ? assetMap.get(mask.refId) : null;
            if (maskRef?.shape) {
                ctx.save();
                ctx.beginPath();
                this._renderMaskPath(ctx, maskRef.shape, frame);
                ctx.clip();
                ctx.restore();
            }
        }
    }

    _renderMaskPath(ctx, shapes, frame) {
        if (!shapes) return;
        for (const shape of shapes) {
            if (shape.ty === 'sh') {
                const pathData = shape.ks;
                const vertices = pathData?.k?.v || pathData?.v || [];
                const closed = pathData?.k?.c ?? pathData?.c ?? false;
                if (vertices.length > 0) {
                    ctx.moveTo(vertices[0][0], vertices[0][1]);
                    for (let i = 1; i < vertices.length; i++) {
                        ctx.lineTo(vertices[i][0], vertices[i][1]);
                    }
                    if (closed) ctx.closePath();
                }
            } else if (shape.ty === 'gr') {
                this._renderMaskPath(ctx, shape.it || [], frame);
            }
        }
    }

    _applyTransform(ctx, tr, frame, w, h) {
        if (!tr) return;

        const pos = this._resolveProp(tr.p, frame);
        const anchor = this._resolveProp(tr.a, frame);
        const scale = this._resolveProp(tr.s, frame);
        const rotation = this._resolveProp(tr.r, frame) ?? 0;

        const px = Array.isArray(pos) ? pos[0] : w / 2;
        const py = Array.isArray(pos) ? pos[1] : h / 2;
        const ax = Array.isArray(anchor) ? anchor[0] : 0;
        const ay = Array.isArray(anchor) ? anchor[1] : 0;
        let sx = Array.isArray(scale) ? scale[0] / 100 : 1;
        let sy = Array.isArray(scale) ? scale[1] / 100 : 1;
        // Lottie scale is percentage-based; handle single-value scale
        if (!Array.isArray(scale) && typeof scale === 'number') sx = sy = scale / 100;

        ctx.translate(px, py);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(sx, sy);
        ctx.translate(-ax, -ay);
    }

    _resolveProp(prop, frame) {
        if (!prop) return undefined;
        if (prop.k !== undefined && !Array.isArray(prop.k)) return prop.k;
        if (Array.isArray(prop.k) && prop.k.length <= 4 && typeof prop.k[0] !== 'object') return prop.k;
        // Keyframed
        if (Array.isArray(prop.k) && prop.k.length > 0 && prop.k[0]?.t !== undefined) {
            return this._interpolateKeyframes(prop.k, frame);
        }
        return prop.k;
    }

    _interpolateKeyframes(keyframes, frame) {
        if (!keyframes?.length) return undefined;

        // Find keyframe at or before frame
        let prev = keyframes[0];
        let next = keyframes[keyframes.length - 1];

        for (let i = 0; i < keyframes.length; i++) {
            if (keyframes[i].t <= frame) prev = keyframes[i];
            if (keyframes[i].t > frame && next === keyframes[keyframes.length - 1]) {
                next = keyframes[i];
                break;
            }
        }

        // Same keyframe — return its value
        if (prev.t === next.t || next.t > frame) return prev.s ?? prev.e ?? prev.k;

        // Linear interpolation between keyframes
        const t = (frame - prev.t) / (next.t - prev.t);
        const from = prev.s ?? prev.e ?? prev.k;
        const to = next.s ?? next.e ?? next.k;

        if (Array.isArray(from) && Array.isArray(to)) {
            return from.map((v, i) => v + (to[i] - v) * t);
        }
        if (typeof from === 'number' && typeof to === 'number') {
            return from + (to - from) * t;
        }
        return from;
    }

    _renderShapeGroup(ctx, shapes, frame, assetMap) {
        if (!shapes) return;
        for (const shape of shapes) {
            this._renderShape(ctx, shape, frame, assetMap);
        }
    }

    _renderShape(ctx, shape, frame, assetMap) {
        if (!shape) return;

        if (shape.ty === 'gr') {
            const items = shape.it || [];
            ctx.save();
            for (const item of items) {
                if (item.ty === 'tr') this._applyTransform(ctx, item, frame, 0, 0);
            }
            // Render shapes first, then modifiers
            const renderItems = items.filter(it => it.ty !== 'tr');
            const pathItems = renderItems.filter(it => it.ty === 'sh' || it.ty === 'el' || it.ty === 'rc');
            const styleItems = renderItems.filter(it => it.ty === 'fl' || it.ty === 'st' || it.ty === 'gf');

            // Apply styles
            for (const si of styleItems) this._renderShape(ctx, si, frame, assetMap);
            // Then render paths (fill/stroke are applied to the current path)
            for (const pi of pathItems) this._renderShape(ctx, pi, frame, assetMap);

            ctx.restore();
        } else if (shape.ty === 'sh') {
            const pathData = shape.ks;
            if (!pathData) return;
            const vertices = pathData.k?.v || pathData.v || [];
            const inTangents = pathData.k?.i || pathData.i || [];
            const outTangents = pathData.k?.o || pathData.o || [];
            const closed = pathData.k?.c ?? pathData.c ?? false;

            if (!vertices.length) return;

            ctx.beginPath();
            ctx.moveTo(vertices[0][0], vertices[0][1]);

            for (let i = 1; i < vertices.length; i++) {
                const prev = vertices[i - 1];
                const curr = vertices[i];
                const cp1 = [prev[0] + (outTangents[i - 1]?.[0] || 0), prev[1] + (outTangents[i - 1]?.[1] || 0)];
                const cp2 = [curr[0] + (inTangents[i]?.[0] || 0), curr[1] + (inTangents[i]?.[1] || 0)];
                ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], curr[0], curr[1]);
            }
            if (closed) ctx.closePath();
        } else if (shape.ty === 'el') {
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [0, 0];
            const rx = (Array.isArray(size) ? size[0] : 0) / 2;
            const ry = (Array.isArray(size) ? size[1] : 0) / 2;
            const cx = Array.isArray(pos) ? pos[0] : 0;
            const cy = Array.isArray(pos) ? pos[1] : 0;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        } else if (shape.ty === 'rc') {
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [0, 0];
            const sw = Array.isArray(size) ? size[0] : 100;
            const sh = Array.isArray(size) ? size[1] : 100;
            const cx = Array.isArray(pos) ? pos[0] : 0;
            const cy = Array.isArray(pos) ? pos[1] : 0;
            const r = shape.r?.k ?? 0;
            if (r > 0) {
                // Rounded rectangle
                ctx.beginPath();
                ctx.roundRect(cx - sw / 2, cy - sh / 2, sw, sh, r);
            } else {
                ctx.beginPath();
                ctx.rect(cx - sw / 2, cy - sh / 2, sw, sh);
            }
        } else if (shape.ty === 'fl') {
            const color = shape.c?.k || [0, 0, 0, 1];
            const alpha = shape.o?.k ?? 100;
            ctx.fillStyle = this._rgba(color, alpha / 100);
            ctx.fill();
        } else if (shape.ty === 'st') {
            const color = shape.c?.k || [0, 0, 0, 1];
            const alpha = shape.o?.k ?? 100;
            const w = shape.w?.k ?? 1;
            ctx.strokeStyle = this._rgba(color, alpha / 100);
            ctx.lineWidth = w;
            ctx.stroke();
        } else if (shape.ty === 'gf') {
            // Gradient fill — simplified: use first/last color stops
            const colors = shape.g?.p || [];
            const stops = shape.g?.k || [];
            if (colors.length >= 2) {
                const c1 = colors[0]?.p || [0, 0, 0];
                const c2 = colors[colors.length - 1]?.p || [1, 1, 1];
                const grad = ctx.createLinearGradient(0, 0, w || 512, h || 512);
                grad.addColorStop(0, this._rgba(c1, 1));
                grad.addColorStop(1, this._rgba(c2, 1));
                ctx.fillStyle = grad;
                ctx.fill();
            }
        }
    }

    _rgba(color, alpha = 1) {
        const r = Math.round((color[0] || 0) * 255);
        const g = Math.round((color[1] || 0) * 255);
        const b = Math.round((color[2] || 0) * 255);
        return `rgba(${r},${g},${b},${alpha})`;
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

        // Animated TGS — convert to MP4 video sticker (most reliable WhatsApp support)
        if (format === 'tgs') {
            // Try MP4 video sticker first
            try {
                const mp4Buffer = await this.tgsToMp4Video(buffer);
                if (mp4Buffer && mp4Buffer.length > 0 && mp4Buffer.length <= VIDEO_STICKER_MAX) {
                    logger.info(`TGS → MP4 video sticker: ${mp4Buffer.length} bytes`);
                    return { buffer: mp4Buffer, type: 'video' };
                }
                logger.info(`TGS → MP4 too large (${mp4Buffer?.length || 0} bytes), trying animated WebP`);
            } catch (err) {
                logger.warn(`TGS → MP4 failed: ${err.message}, trying animated WebP`);
            }

            // Fallback: try animated WebP with isAnimated flag
            try {
                const animWebp = await this.tgsToAnimatedWebp(buffer);
                if (animWebp && animWebp.length > 0 && animWebp.length <= ANIM_WEBP_MAX) {
                    logger.info(`TGS → animated WebP: ${animWebp.length} bytes`);
                    return { buffer: animWebp, type: 'sticker', isAnimated: true };
                }
            } catch (err) {
                logger.warn(`TGS → animated WebP failed: ${err.message}`);
            }

            // Final fallback: static first frame
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
