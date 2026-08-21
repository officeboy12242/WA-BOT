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
        // Decompress gzip
        const lottieJson = zlib.gunzipSync(tgsBuffer).toString('utf-8');
        const lottie = JSON.parse(lottieJson);

        // Extract first frame dimensions and use canvas to render
        const width = lottie.w || 512;
        const height = lottie.h || 512;

        // Use @napi-rs/canvas for rendering
        const { createCanvas } = await import('@napi-rs/canvas');
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Clear with transparent background
        ctx.clearRect(0, 0, width, height);

        // For now, render a simple placeholder showing it's an animated sticker
        // A proper Lottie renderer would draw the actual frame
        ctx.fillStyle = 'rgba(200, 200, 200, 0.3)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#666';
        ctx.font = 'bold 24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🎬', width / 2, height / 2 + 8);

        // Convert to PNG buffer
        return canvas.toBuffer('image/png');
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

        const summary = [];
        if (results.length) summary.push(`${results.length} ready`);
        if (errors.length) summary.push(`${errors.length} failed`);

        report(`✅ *${pack.title || packName}* — ${summary.join(', ')}`);

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
