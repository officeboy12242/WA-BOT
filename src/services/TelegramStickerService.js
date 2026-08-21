/**
 * Telegram Sticker Service
 * Fetches sticker packs from Telegram via Bot API and converts to WhatsApp format.
 *
 * Usage: /tgstickers <t.me/addstickers/PACK_NAME or just PACK_NAME>
 *
 * Requires TELEGRAM_BOT_TOKEN env var — create a bot via @BotFather on Telegram.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';

const TG_API = 'https://api.telegram.org';
const STICKER_WEBP_MAX = 100 * 1024; // 100 KB — WhatsApp sticker limit
const DOWNLOAD_CONCURRENCY = 3;

class TelegramStickerService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-tg-stickers');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /** Telegram Bot API token from config. */
    get token() {
        return config.TELEGRAM_BOT_TOKEN;
    }

    get isConfigured() {
        return Boolean(this.token);
    }

    /**
     * Parse a Telegram sticker pack URL or name.
     * Accepts:
     *   - https://t.me/addstickers/PackName
     *   - tg://addstickers?set=PackName
     *   - PackName (raw)
     */
    parsePackInput(input) {
        if (!input || typeof input !== 'string') return null;
        const trimmed = input.trim();

        // Full URL: https://t.me/addstickers/PackName
        let m = trimmed.match(/t\.me\/addstickers\/([A-Za-z0-9_-]+)$/i);
        if (m) return m[1];

        // Protocol: tg://addstickers?set=PackName
        m = trimmed.match(/tg:\/\/addstickers\?set=([A-Za-z0-9_-]+)/i);
        if (m) return m[1];

        // Raw pack name (alphanumeric + underscores + hyphens, 1-64 chars)
        if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed;

        return null;
    }

    /**
     * Fetch sticker set metadata from Telegram Bot API.
     * @returns {{ name, title, stickers: Array<{ file_id, emoji, is_animated, is_video, thumbnail }>, sticker_type }}
     */
    async getStickerSet(packName) {
        if (!this.isConfigured) {
            throw new Error('Telegram Bot token not configured. Set TELEGRAM_BOT_TOKEN in .env');
        }

        const url = `${TG_API}/bot${this.token}/getStickerSet?name=${encodeURIComponent(packName)}`;
        const res = await axios.get(url, { timeout: 15000 });

        if (!res.data?.ok) {
            const desc = res.data?.description || 'Unknown error';
            throw new Error(`Telegram API: ${desc}`);
        }

        return res.data.result;
    }

    /**
     * Get the file download URL for a sticker by file_id.
     */
    async getFileUrl(fileId) {
        const url = `${TG_API}/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const res = await axios.get(url, { timeout: 10000 });

        if (!res.data?.ok) {
            throw new Error(`getFile failed: ${res.data?.description || 'unknown'}`);
        }

        const filePath = res.data.result.file_path;
        return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    }

    /**
     * Download a sticker file to a temp path.
     * @returns {{ tempPath, buffer, size, isAnimated, isVideo, emoji, format }
     */
    async downloadSticker(sticker, index) {
        const fileId = sticker.file_id;
        const isAnimated = sticker.is_animated || false;
        const isVideo = sticker.is_video || false;
        const emoji = sticker.emoji || '❓';
        const format = isVideo ? 'tgs' : isAnimated ? 'tgs' : 'webp';

        const fileUrl = await this.getFileUrl(fileId);
        const res = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        const buffer = Buffer.from(res.data);
        const ext = format === 'tgs' ? '.tgs' : '.webp';
        const tempPath = path.join(this.tempDir, `${crypto.randomBytes(8).toString('hex')}${ext}`);
        fs.writeFileSync(tempPath, buffer);

        return {
            tempPath,
            buffer,
            size: buffer.length,
            isAnimated,
            isVideo,
            emoji,
            format,
            index,
        };
    }

    /**
     * Decompress a TGS file (gzipped Lottie JSON) and extract the first frame as PNG buffer.
     */
    async tgsToStaticFrame(tgsBuffer) {
        // Decompress gzip to get Lottie JSON
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);

        const width = lottie.w || 512;
        const height = lottie.h || 512;

        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);

        // Render the first frame of Lottie layers
        this._renderLottieFrame(ctx, lottie, 0, width, height);

        return canvas.toBuffer('image/png');
    }

    /**
     * Minimal Lottie frame renderer — handles shapes, fills, strokes, and basic transforms.
     * Enough to produce a recognizable static frame from most Telegram animated stickers.
     */
    _renderLottieFrame(ctx, lottie, frame, w, h) {
        const layers = lottie.layers || [];
        const assets = lottie.assets || [];
        const assetMap = new Map();
        for (const a of assets) {
            if (a.id) assetMap.set(a.id, a);
        }

        // Layers are bottom-to-top; reverse to draw in order
        const sorted = [...layers].sort((a, b) => (a.zi ?? 0) - (b.zi ?? 0));

        for (const layer of sorted) {
            if (layer.ty === 0) continue; // precomp — skip for now
            if (layer.ty === 1) continue; // solid — skip
            if (layer.ty === 3) continue; // null layer

            // Check layer visibility (ip = in-point, op = out-point)
            const ip = layer.ip ?? 0;
            const op = layer.op ?? Infinity;
            if (frame < ip || frame > op) continue;

            // Get layer opacity
            const opacity = this._resolveProp(layer.ks?.o, frame) ?? 100;
            if (opacity <= 0) continue;

            ctx.save();
            ctx.globalAlpha = opacity / 100;

            // Apply layer transform
            this._applyTransform(ctx, layer.ks?.tr, frame, w, h);

            if (layer.ty === 4) {
                // Shape layer
                this._renderShapeGroup(ctx, layer.shapes, frame, assetMap);
            } else if (layer.ty === 2) {
                // Image layer
                const refId = layer.refId;
                const asset = assetMap.get(refId);
                if (asset?.u && asset?.p) {
                    // Asset has a path — we can't fetch it here, skip
                }
            }

            ctx.restore();
        }
    }

    /** Apply layer transform (position, scale, rotation) to ctx. */
    _applyTransform(ctx, tr, frame, w, h) {
        if (!tr) return;

        const pos = this._resolveProp(tr.p, frame);
        const anchor = this._resolveProp(tr.a, frame);
        const scale = this._resolveProp(tr.s, frame);
        const rotation = this._resolveProp(tr.r, frame) ?? 0;

        // Lottie origin is center; canvas origin is top-left
        const px = Array.isArray(pos) ? pos[0] : (w / 2);
        const py = Array.isArray(pos) ? pos[1] : (h / 2);
        const ax = Array.isArray(anchor) ? anchor[0] : 0;
        const ay = Array.isArray(anchor) ? anchor[1] : 0;
        const sx = Array.isArray(scale) ? scale[0] / 100 : 1;
        const sy = Array.isArray(scale) ? scale[1] / 100 : 1;

        ctx.translate(px, py);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.scale(sx, sy);
        ctx.translate(-ax, -ay);
    }

    /** Resolve a Lottie property to its value at a given frame. */
    _resolveProp(prop, frame) {
        if (!prop) return undefined;
        if (prop.k !== undefined && !Array.isArray(prop.k)) return prop.k;
        if (Array.isArray(prop.k) && prop.k.length <= 4) return prop.k;
        // Keyframed — find the value at frame
        if (prop.k?.[0]?.t !== undefined) {
            return this._interpolateKeyframes(prop.k, frame);
        }
        return prop.k;
    }

    /** Interpolate keyframes to find value at frame. */
    _interpolateKeyframes(keyframes, frame) {
        if (!keyframes?.length) return undefined;
        // Find the keyframe at or before frame
        let kf = keyframes[0];
        for (const k of keyframes) {
            if (k.t <= frame) kf = k;
            else break;
        }
        return kf.s ?? kf.e ?? kf.k;
    }

    /** Render a shape group (items array). */
    _renderShapeGroup(ctx, shapes, frame, assetMap) {
        if (!shapes) return;
        for (const shape of shapes) {
            this._renderShape(ctx, shape, frame, assetMap);
        }
    }

    /** Render a single shape item. */
    _renderShape(ctx, shape, frame, assetMap) {
        if (!shape) return;

        if (shape.ty === 'gr') {
            // Group — recurse
            const items = shape.it || [];
            ctx.save();
            // Apply group transforms
            for (const item of items) {
                if (item.ty === 'tr') {
                    this._applyTransform(ctx, item, frame, 0, 0);
                }
            }
            // Render shapes first, then modifiers
            for (const item of items) {
                if (item.ty !== 'tr') {
                    this._renderShape(ctx, item, frame, assetMap);
                }
            }
            ctx.restore();
        } else if (shape.ty === 'sh') {
            // Path shape
            const pathData = shape.ks;
            if (!pathData) return;
            const vertices = pathData.k?.v || pathData.v || [];
            const inTangents = pathData.k?.i || pathData.i || [];
            const outTangents = pathData.k?.o || pathData.o || [];
            const closed = pathData.k?.c ?? pathData.c ?? false;

            if (!vertices.length) return;

            ctx.beginPath();
            const first = vertices[0];
            ctx.moveTo(first[0], first[1]);

            for (let i = 1; i < vertices.length; i++) {
                const prev = vertices[i - 1];
                const curr = vertices[i];
                const cp1 = [prev[0] + (outTangents[i - 1]?.[0] || 0), prev[1] + (outTangents[i - 1]?.[1] || 0)];
                const cp2 = [curr[0] + (inTangents[i]?.[0] || 0), curr[1] + (inTangents[i]?.[1] || 0)];
                ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], curr[0], curr[1]);
            }
            if (closed) ctx.closePath();
        } else if (shape.ty === 'el') {
            // Ellipse
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [0, 0];
            const rx = (Array.isArray(size) ? size[0] : 0) / 2;
            const ry = (Array.isArray(size) ? size[1] : 0) / 2;
            const cx = Array.isArray(pos) ? pos[0] : 0;
            const cy = Array.isArray(pos) ? pos[1] : 0;
            ctx.beginPath();
            ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        } else if (shape.ty === 'rc') {
            // Rectangle
            const pos = this._resolveProp(shape.p, frame) ?? [0, 0];
            const size = this._resolveProp(shape.s, frame) ?? [0, 0];
            const sw = Array.isArray(size) ? size[0] : 100;
            const sh = Array.isArray(size) ? size[1] : 100;
            const cx = Array.isArray(pos) ? pos[0] : 0;
            const cy = Array.isArray(pos) ? pos[1] : 0;
            ctx.beginPath();
            ctx.rect(cx - sw / 2, cy - sh / 2, sw, sh);
        } else if (shape.ty === 'fl') {
            // Fill
            const color = shape.c?.k || [0, 0, 0, 1];
            const alpha = shape.o?.k ?? 100;
            ctx.fillStyle = this._rgba(color, alpha / 100);
            ctx.fill();
        } else if (shape.ty === 'st') {
            // Stroke
            const color = shape.c?.k || [0, 0, 0, 1];
            const alpha = shape.o?.k ?? 100;
            const width = shape.w?.k ?? 1;
            ctx.strokeStyle = this._rgba(color, alpha / 100);
            ctx.lineWidth = width;
            ctx.stroke();
        }
    }

    /** Convert Lottie RGBA [0-1] array to CSS string. */
    _rgba(color, alpha = 1) {
        const r = Math.round((color[0] || 0) * 255);
        const g = Math.round((color[1] || 0) * 255);
        const b = Math.round((color[2] || 0) * 255);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    /**
     * Check if a WebP buffer is a valid static sticker (not animated).
     * Animated WebPs start with "RIFF" and contain "WEBP" but have animation chunks.
     */
    isStaticWebp(buffer) {
        if (!buffer || buffer.length < 12) return false;
        // RIFF....WEBP header
        return buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
    }

    /**
     * Convert a sticker buffer (WebP or TGS) to WhatsApp-compatible format.
     * For TGS: extracts first frame as static sticker.
     * WhatsApp stickers must be: WebP, ≤100KB, 512x512 recommended.
     */
    async convertToWhatsAppSticker(buffer, emoji, format) {
        const sharp = (await import('sharp')).default;

        // Handle TGS (animated) — convert first frame to static WebP
        if (format === 'tgs') {
            try {
                const pngBuffer = await this.tgsToStaticFrame(buffer);
                const converted = await sharp(pngBuffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80, alphaQuality: 100 })
                    .toBuffer();
                return converted.length <= STICKER_WEBP_MAX ? converted :
                    await sharp(pngBuffer)
                        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                        .webp({ quality: 50, alphaQuality: 80 })
                        .toBuffer();
            } catch (err) {
                logger.warn(`TGS conversion failed: ${err.message}`);
                throw new Error('Animated sticker conversion failed');
            }
        }

        // Handle WebP (static)
        if (buffer.length <= STICKER_WEBP_MAX && this.isStaticWebp(buffer)) {
            return buffer;
        }

        const converted = await sharp(buffer)
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 80, alphaQuality: 100 })
            .toBuffer();

        if (converted.length > STICKER_WEBP_MAX) {
            return await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 50, alphaQuality: 80 })
                .toBuffer();
        }

        return converted;
    }

    /**
     * Fetch and convert an entire sticker pack.
     * @param {string} packName
     * @param {Function} [onProgress] - callback(progressText)
     * @returns {{ pack, stickers: Array<{ buffer, emoji, index }>, errors: string[] }}
     */
    async fetchAndConvertPack(packName, onProgress) {
        // onProgress(convertedCount, failedCount, phase)
        const report = (converted, failed, phase) => { try { onProgress?.(converted, failed, phase); } catch {} };

        const pack = await this.getStickerSet(packName);
        const totalStickers = pack.stickers?.length || 0;

        if (!totalStickers) {
            return { pack, stickers: [], errors: ['Empty sticker pack'] };
        }

        // Process all stickers — no artificial limit
        const toProcess = pack.stickers;

        const results = [];
        const errors = [];
        let convertedCount = 0;
        let failedCount = 0;

        // Download + convert in batches
        for (let i = 0; i < toProcess.length; i += DOWNLOAD_CONCURRENCY) {
            const batch = toProcess.slice(i, i + DOWNLOAD_CONCURRENCY);

            const downloads = await Promise.allSettled(
                batch.map((sticker, j) => this.downloadSticker(sticker, i + j))
            );

            for (let j = 0; j < downloads.length; j++) {
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
                    // Convert to WhatsApp format (static WebP for both static and animated)
                    const waBuffer = await this.convertToWhatsAppSticker(dl.buffer, dl.emoji, dl.format);
                    results.push({
                        buffer: waBuffer,
                        emoji: dl.emoji,
                        index: dl.index,
                    });
                    convertedCount++;
                    report(convertedCount, failedCount, 'convert');
                } catch (err) {
                    failedCount++;
                    errors.push(`Sticker ${i + j + 1} (${dl.emoji}): conversion failed — ${err.message}`);
                    report(convertedCount, failedCount, 'convert');
                } finally {
                    this._cleanup(dl.tempPath);
                }
            }
        }

        // Final progress callback — all done
        report(convertedCount, failedCount, 'done');

        return { pack, stickers: results, errors };
    }

    _cleanup(filePath) {
        try { fs.unlinkSync(filePath); } catch {}
    }

    /**
     * Clean up temp directory on shutdown.
     */
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
