/**
 * Sticker Controller
 * Handles sticker creation, conversion, and metadata management
 */

import { downloadMediaMessage, downloadContentFromMessage, normalizeMessageContent } from 'baileys';
import { getTextFromWAMessage, buildQuotedTargetMessage } from '../utils/waMessage.js';
import { downloadStickerBuffer, createDownloadContext } from '../utils/stickerDownload.js';
import { extractStickerFromMessage } from '../utils/stickerExtract.js';
import WSF from 'wa-sticker-formatter';
const { Exif: StickerExif } = WSF;
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Get directory path for bundled assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_FONT_PATH = path.resolve(__dirname, '../../fonts/Roboto-Bold.ttf');

// Configure FFmpeg path
let ffmpegPath = process.env.FFMPEG_PATH;

if (!ffmpegPath) {
    try {
        const { default: ffmpegStatic } = await import('ffmpeg-static');
        const { existsSync } = await import('fs');
        ffmpegPath = (ffmpegStatic && existsSync(ffmpegStatic)) ? ffmpegStatic : 'ffmpeg';
    } catch (err) {
        ffmpegPath = 'ffmpeg';
    }
}

logger.info(`🎬 Sticker functionality using FFmpeg: ${ffmpegPath}`);
ffmpeg.setFfmpegPath(ffmpegPath);

class StickerController {
    constructor(config = {}) {
        this.defaultPack = config.STICKER_PACK_NAME || '';
        this.defaultAuthor = config.STICKER_PACK_AUTHOR || '';
        this.tempDir = path.join(os.tmpdir(), 'whatsapp-bot-stickers');
        this._ffmpegQueue = [];
        this._ffmpegActive = 0;
        this._ffmpegMax = 2;
        this._connectionProvider = null;
        this._ensureTempDir();
    }

    /** @param {{ getSock: () => import('baileys').WASocket, getIsReady: () => boolean }} provider */
    setConnectionProvider(provider) {
        this._connectionProvider = provider;
    }

    async _activeSock(fallbackSock, maxWaitMs = 20000) {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const sock = this._connectionProvider?.getSock?.() ?? fallbackSock;
            const ready = this._connectionProvider?.getIsReady?.() ?? Boolean(sock?.user);
            if (sock?.user && ready) {
                return sock;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return this._connectionProvider?.getSock?.() ?? fallbackSock;
    }

    _ensureTempDir() {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    _generateTempFileName(ext = '') {
        const randomId = crypto.randomBytes(8).toString('hex');
        return path.join(this.tempDir, `${randomId}${ext}`);
    }

    _safeUnlink(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (err) {
            logger.warn(`Failed to delete temp file ${filePath}: ${err.message}`);
        }
    }

    _runFfmpeg(command) {
        return new Promise((resolve, reject) => {
            command.on('end', resolve).on('error', reject);
        });
    }

    _runFfmpegWithTimeout(command, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { command.kill('SIGKILL'); } catch {}
                reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            command
                .on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } })
                .on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
        });
    }

    _enqueueFfmpeg(task) {
        return new Promise((resolve, reject) => {
            this._ffmpegQueue.push({ task, resolve, reject });
            this._pumpFfmpegQueue();
        });
    }

    _pumpFfmpegQueue() {
        while (this._ffmpegActive < this._ffmpegMax && this._ffmpegQueue.length > 0) {
            const job = this._ffmpegQueue.shift();
            this._ffmpegActive++;
            Promise.resolve()
                .then(job.task)
                .then(job.resolve, job.reject)
                .finally(() => {
                    this._ffmpegActive--;
                    this._pumpFfmpegQueue();
                });
        }
    }

    async _downloadStickerBuffer(sock, primaryMessage, stickerPayload = null) {
        const activeSock = await this._activeSock(sock);
        const ctx = createDownloadContext(activeSock);
        let lastError = null;

        const payload = stickerPayload || (primaryMessage && extractStickerFromMessage(primaryMessage.message));

        if (payload) {
            try {
                const stream = await downloadContentFromMessage(payload, 'sticker', ctx);
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                if (buffer.length) {
                    return buffer;
                }
            } catch (err) {
                lastError = err;
            }
        }

        if (primaryMessage) {
            try {
                return await downloadStickerBuffer(activeSock, primaryMessage);
            } catch (err) {
                lastError = err;
            }

            try {
                const buffer = await downloadMediaMessage(primaryMessage, 'buffer', {}, ctx);
                if (buffer?.length) {
                    return buffer;
                }
            } catch (err) {
                lastError = err;
            }
        }

        throw lastError || new Error('Failed to download sticker');
    }

    _parseStickerShape(args) {
        const circleMode = args.some((a) => ['circle', 'round', 'circular', 'c'].includes(String(a).toLowerCase()));
        const cropMode = !circleMode && args.includes('crop');
        if (circleMode) return 'circle';
        if (cropMode) return 'crop';
        return 'default';
    }

    _isAnimatedWebp(buffer) {
        return Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('ANIM'));
    }

    async _getSharp() {
        if (!this._sharp) {
            const mod = await import('sharp');
            this._sharp = mod.default;
        }
        return this._sharp;
    }

    async _renderCircleSticker(mediaPath, outputPath, { animated = false, inputBuffer = null } = {}) {
        const sharp = await this._getSharp();
        const buf = inputBuffer || fs.readFileSync(mediaPath);

        const isWebp = /\.webp$/i.test(mediaPath) || (buf[0] === 0x52 && buf[1] === 0x49);
        const isGif = /\.gif$/i.test(mediaPath) || (buf[0] === 0x47 && buf[1] === 0x49);
        const isVideo = /\.(mp4|mov|avi|mkv|3gp)$/i.test(mediaPath);
        const isAnim = animated || this._isAnimatedWebp(buf) || isGif;

        const CIRCLE_MASK = Buffer.from(
            '<svg width="512" height="512"><circle cx="256" cy="256" r="252" fill="white"/></svg>'
        );

        if (!isAnim) {
            const out = await sharp(buf)
                .resize(512, 512, { fit: 'cover' })
                .composite([{ input: CIRCLE_MASK, blend: 'dest-in' }])
                .webp({ quality: 90 })
                .toBuffer();
            await writeFile(outputPath, out);
            return;
        }

        if (isVideo) {
            const webpBuf = await this._convertToWebpViaFfmpeg(mediaPath, buf);
            await this._circleAnimatedFrames(sharp, webpBuf, CIRCLE_MASK, outputPath);
            return;
        }

        await this._circleAnimatedFrames(sharp, buf, CIRCLE_MASK, outputPath);
    }

    async _circleAnimatedFrames(sharp, buf, mask, outputPath) {
        const meta = await sharp(buf, { animated: true }).metadata();
        const pages = meta.pages || 1;

        if (pages <= 1) {
            const out = await sharp(buf)
                .resize(512, 512, { fit: 'cover' })
                .composite([{ input: mask, blend: 'dest-in' }])
                .webp({ quality: 90 })
                .toBuffer();
            await writeFile(outputPath, out);
            return;
        }

        const MAX_FRAMES = 50;
        const frameSkip = pages > MAX_FRAMES ? Math.ceil(pages / MAX_FRAMES) : 1;
        const baseDelay = meta.delay?.[0] || 100;
        const frameDelay = Math.max(50, Math.round(baseDelay * frameSkip));

        const pngFrames = [];
        for (let i = 0; i < pages && pngFrames.length < MAX_FRAMES; i += frameSkip) {
            const png = await sharp(buf, { animated: false, page: i })
                .resize(512, 512, { fit: 'cover' })
                .composite([{ input: mask, blend: 'dest-in' }])
                .ensureAlpha()
                .png()
                .toBuffer();
            pngFrames.push(png);
        }

        const frameHeight = 512;
        const totalHeight = frameHeight * pngFrames.length;

        let strip = await sharp({
            create: { width: 512, height: totalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).png().toBuffer();

        const composites = pngFrames.map((png, idx) => ({
            input: png,
            top: idx * frameHeight,
            left: 0,
        }));

        strip = await sharp(strip)
            .composite(composites)
            .png()
            .toBuffer();

        const out = await sharp(strip, { animated: false })
            .resize(512, totalHeight, { fit: 'fill' })
            .webp({
                quality: 65,
                loop: 0,
                delay: pngFrames.map(() => frameDelay),
                pageHeight: frameHeight,
            })
            .toBuffer();

        await writeFile(outputPath, out);
    }

    async _convertToWebpViaFfmpeg(mediaPath, buf) {
        const inputPath = /\.(mp4|gif|webp|mov|avi|mkv|3gp)$/i.test(mediaPath)
            ? mediaPath
            : (() => { const p = this._generateTempFileName('.mp4'); fs.writeFileSync(p, buf); return p; })();
        const outPath = this._generateTempFileName('.webp');

        try {
            await this._enqueueFfmpeg(() => this._runFfmpegWithTimeout(
                ffmpeg(inputPath)
                    .addOutputOptions([
                        '-vcodec', 'libwebp',
                        '-vf', "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=0x00000000,fps=12",
                        '-loop', '0',
                        '-t', '8',
                        '-preset', 'default',
                        '-an',
                        '-pix_fmt', 'yuva420p',
                    ])
                    .toFormat('webp')
                    .save(outPath),
                30000
            ));
            return fs.readFileSync(outPath);
        } finally {
            if (inputPath !== mediaPath) this._safeUnlink(inputPath);
            this._safeUnlink(outPath);
        }
    }

    async _renderStandardSticker(mediaPath, outputPath, shape, { animated = false, inputBuffer = null } = {}) {
        const isVideoFile = /\.(mp4|mov|avi|mkv|3gp)$/i.test(mediaPath);

        if (!isVideoFile && !animated) {
            const sharp = await this._getSharp();
            const buf = inputBuffer || fs.readFileSync(mediaPath);
            const resizeOpts = shape === 'crop'
                ? { width: 512, height: 512, fit: 'cover' }
                : { width: 512, height: 512, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } };

            const out = await sharp(buf).resize(resizeOpts).webp({ quality: 90 }).toBuffer();
            await writeFile(outputPath, out);
            return;
        }

        const outputOptions = shape === 'crop'
            ? [
                '-vcodec', 'libwebp',
                '-vf', "crop=w='min(min(iw,ih),512)':h='min(min(iw,ih),512)',scale=512:512,setsar=1,fps=12",
                '-loop', '0',
                '-t', '8',
                '-preset', 'default',
                '-an',
                '-pix_fmt', 'yuva420p',
                '-s', '512:512',
            ]
            : [
                '-vcodec', 'libwebp',
                '-vf', "scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:-1:-1:color=0x00000000",
                '-loop', '0',
                '-t', '8',
                '-preset', 'default',
                '-an',
                '-pix_fmt', 'yuva420p',
            ];

        await this._enqueueFfmpeg(() => this._runFfmpegWithTimeout(
            ffmpeg(mediaPath).addOutputOptions(outputOptions).toFormat('webp').save(outputPath),
            30000
        ));
    }

    async _sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata, quotedMsg) {
        const activeSock = await this._activeSock(sock);
        const rawBuffer = fs.readFileSync(stickerPath);
        let stickerBuffer = rawBuffer;

        if (!noMetadata) {
            try {
                const exif = new StickerExif({ pack: packName, author: authorName });
                stickerBuffer = await exif.add(rawBuffer);
            } catch (metaErr) {
                logger.warn(`Sticker metadata injection failed: ${metaErr?.message || metaErr}`);
            }
        }

        try {
            await activeSock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: quotedMsg });
        } catch (wsError) {
            logger.warn(`Sticker send with quote failed: ${wsError?.message || wsError}`);
            await activeSock.sendMessage(chatId, { sticker: rawBuffer });
        }
    }

    /**
     * Create sticker from image or video
     */
    async handleSticker(sock, chatId, waMessage, args, textContent) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Creating sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage) || {
                ...waMessage,
                message: waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage
                    ? waMessage.message.extendedTextMessage.contextInfo.quotedMessage
                    : waMessage.message,
            };

            const normalized = normalizeMessageContent(targetMessage.message) || targetMessage.message;
            const messageType = Object.keys(normalized)[0];
            const isImage = messageType === 'imageMessage';
            const isVideo = messageType === 'videoMessage';
            const isGifPlayback = isVideo && normalized.videoMessage?.gifPlayback;

            if (!isImage && !isVideo) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to an image or video/GIF (max 15 seconds).'
                });
                return;
            }

            if (isVideo && !isGifPlayback && normalized.videoMessage?.seconds > 15) {
                await sock.sendMessage(chatId, {
                    text: '❌ Video must be less than 15 seconds.'
                });
                return;
            }

            // Parse arguments
            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
            const shape = this._parseStickerShape(args);
            const noMetadata = args.includes('nometadata');

            if (!noMetadata) {
                const argsText = textContent.replace(/^\/\w+\s*/, ''); // Remove command
                if (argsText.includes('pack')) {
                    const packMatch = argsText.match(/pack\s+([^author]+)/i);
                    if (packMatch) packName = packMatch[1].trim();
                }
                if (argsText.includes('author')) {
                    const authorMatch = argsText.match(/author\s+([^pack]+)/i);
                    if (authorMatch) authorName = authorMatch[1].trim();
                }
            }

            const ext = isImage ? '.png' : (isGifPlayback ? '.gif' : '.mp4');
            const mediaPath = this._generateTempFileName(ext);
            
            try {
                const activeSock = await this._activeSock(sock);
                const buffer = await downloadMediaMessage(
                    targetMessage,
                    'buffer',
                    {},
                    createDownloadContext(activeSock)
                );
                if (!buffer || buffer.length === 0) {
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to download media. Please try again.'
                    });
                    return;
                }

                await writeFile(mediaPath, buffer);

                if (!fs.existsSync(mediaPath)) {
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to save media file. Please try again.'
                    });
                    return;
                }

                await this._buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, waMessage, isVideo || isGifPlayback);
            } catch (error) {
                logger.error('Media download error:', error);
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to process media. Please try again.'
                });
            }
        } catch (error) {
            logger.error('Sticker handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to create sticker.'
            });
        }
    }

    async _buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, quotedMsg, isAnimated = false) {
        const stickerPath = this._generateTempFileName('.webp');

        try {
            if (!fs.existsSync(mediaPath)) {
                throw new Error('Input media file not found');
            }

            if (shape === 'circle') {
                await this._renderCircleSticker(mediaPath, stickerPath, { animated: isAnimated });
            } else {
                await this._renderStandardSticker(mediaPath, stickerPath, shape, { animated: isAnimated });
            }

            if (!fs.existsSync(stickerPath)) {
                throw new Error('Output sticker file not created');
            }

            const stat = fs.statSync(stickerPath);
            if (stat.size > 1_000_000) {
                logger.warn(`Sticker exceeds 1MB (${(stat.size / 1024).toFixed(0)}KB), re-encoding at lower quality`);
                const sharp = await this._getSharp();
                const reEncoded = await sharp(fs.readFileSync(stickerPath), { animated: isAnimated })
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 40 })
                    .toBuffer();
                await writeFile(stickerPath, reEncoded);
            }

            await this._sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata, quotedMsg);
        } catch (err) {
            logger.error('buildSticker error:', err);
            await sock.sendMessage(chatId, {
                text: '❌ Failed to create sticker.',
            });
        } finally {
            this._safeUnlink(mediaPath);
            this._safeUnlink(stickerPath);
        }
    }

    /**
     * Steal sticker (change metadata)
     */
    async handleSteal(sock, chatId, waMessage, args, textContent) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Processing sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage);
            if (!targetMessage) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            const stickerPayload = extractStickerFromMessage(targetMessage.message);
            if (!stickerPayload) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
            const shape = this._parseStickerShape(args);
            const noMetadata = textContent.includes('stealn');

            if (!noMetadata) {
                const argsText = textContent.replace(/^\/\w+\s*/, '');
                if (argsText.includes('pack')) {
                    const packMatch = argsText.match(/pack\s+([^author]+)/i);
                    if (packMatch) packName = packMatch[1].trim();
                }
                if (argsText.includes('author')) {
                    const authorMatch = argsText.match(/author\s+([^pack]+)/i);
                    if (authorMatch) authorName = authorMatch[1].trim();
                }
            }

            let buffer;
            try {
                buffer = await this._downloadStickerBuffer(sock, targetMessage, stickerPayload);
            } catch (downloadErr) {
                logger.error(`Steal download failed: ${downloadErr.message}`);
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }

            const isAnimated = Boolean(stickerPayload.isAnimated) || this._isAnimatedWebp(buffer);

            logger.info(`Steal: shape=${shape} animated=${isAnimated} bytes=${buffer.length} args=${args.join(' ') || '(none)'}`);

            const stickerPath = this._generateTempFileName('.webp');
            await writeFile(stickerPath, buffer);

            try {
                if (shape === 'circle') {
                    const circlePath = this._generateTempFileName('.webp');
                    try {
                        try {
                            await this._renderCircleSticker(stickerPath, circlePath, {
                                animated: isAnimated,
                                inputBuffer: buffer,
                            });
                            await this._sendStickerFromPath(sock, chatId, circlePath, packName, authorName, noMetadata || isAnimated, waMessage);
                            logger.info(`✓ Sticker converted to circle`);
                        } catch (circleErr) {
                            logger.warn({ err: circleErr }, 'Circle render failed, sending original sticker');
                            await this._sendStickerFromPath(sock, chatId, stickerPath, packName, authorName, noMetadata || isAnimated, waMessage);
                            logger.info('✓ Sticker sent (circle fallback to original)');
                        }
                    } finally {
                        this._safeUnlink(circlePath);
                    }
                } else {
                    await this._sendStickerFromPath(
                        sock,
                        chatId,
                        stickerPath,
                        packName,
                        authorName,
                        noMetadata || isAnimated,
                        waMessage
                    );
                    logger.info('✓ Sticker metadata updated successfully');
                }
            } catch (error) {
                logger.error({ err: error }, 'Error in steal handler');
                await sock.sendMessage(chatId, {
                    text: shape === 'circle'
                        ? '❌ Failed to convert sticker to circle.'
                        : '❌ Failed to modify sticker metadata.',
                });
            } finally {
                this._safeUnlink(stickerPath);
            }
        } catch (error) {
            logger.error('Steal handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to steal sticker.'
            });
        }
    }

    /**
     * Convert sticker to image
     */
    async handleToImage(sock, chatId, waMessage) {
        void sock.sendMessage(chatId, {
            text: '🎨 _Converting sticker... you can use other commands meanwhile._',
        }, { quoted: waMessage }).catch(() => {});

        try {
            const targetMessage = buildQuotedTargetMessage(waMessage) || {
                ...waMessage,
                message: waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage || waMessage.message,
            };

            const messageType = Object.keys(targetMessage.message)[0];
            if (messageType !== 'stickerMessage') {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.',
                });
                return;
            }

            let buffer;
            try {
                buffer = await this._downloadStickerBuffer(sock, targetMessage);
            } catch {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.',
                });
                return;
            }

            const stickerPath = this._generateTempFileName('.webp');
            const imagePath = this._generateTempFileName('.png');

            await writeFile(stickerPath, buffer);

            await this._enqueueFfmpeg(() => this._runFfmpegWithTimeout(
                ffmpeg(stickerPath).fromFormat('webp_pipe').save(imagePath),
                15000
            ));

            if (!fs.existsSync(imagePath)) {
                throw new Error('Output image file not created');
            }

            const imageBuffer = fs.readFileSync(imagePath);
            await sock.sendMessage(chatId, {
                image: imageBuffer,
                caption: '✨ Sticker converted to image',
                mimetype: 'image/png',
            }, { quoted: waMessage });

            this._safeUnlink(stickerPath);
            this._safeUnlink(imagePath);
        } catch (error) {
            logger.error('ToImage handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to convert sticker.',
            });
        }
    }

    /**
     * Generate animated RGB/rainbow text sticker
     */
    async handleRgbSticker(sock, chatId, args, originalMsg = null) {
        let text = args.join(' ').replace(/^["']|["']$/g, '').trim();

        // If no args, try to get text from the replied/quoted message
        if (!text && originalMsg) {
            const quotedMsg = originalMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            if (quotedMsg) {
                text = getTextFromWAMessage(quotedMsg).trim();
            }
        }

        if (!text) {
            await sock.sendMessage(chatId, {
                text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    + '🌈 *RGB STICKER MAKER*\n'
                    + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                    + '*Usage:*\n'
                    + '• `/rgb Hello World` — type your text\n'
                    + '• Reply to any message with `/rgb` — uses that message\'s text\n\n'
                    + '*Examples:*\n'
                    + '• `/rgb Sassy Bot 🔥`\n'
                    + '• `/rgb GG EZ`\n\n'
                    + '💡 _Reply to any message with `/rgb` to convert it!_',
            }, { quoted: originalMsg || undefined });
            return;
        }

        const processingMsg = await sock.sendMessage(chatId, {
            text: '🎨 _Generating RGB sticker..._',
        }, { quoted: originalMsg || undefined });

        const frameFiles = [];
        let outputPath = null;
        let concatFile = null;

        try {
            const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');

            // Register bundled font for cross-platform compatibility
            let fontFamily = 'sans-serif';
            try {
                if (fs.existsSync(BUNDLED_FONT_PATH)) {
                    GlobalFonts.registerFromPath(BUNDLED_FONT_PATH, 'RobotoBold');
                    fontFamily = 'RobotoBold';
                    logger.info('RGB sticker using bundled Roboto font');
                } else {
                    // Fallback to system fonts
                    GlobalFonts.loadSystemFonts();
                    fontFamily = 'Arial, DejaVu Sans, Liberation Sans, sans-serif';
                    logger.warn('Bundled font not found, using system fonts');
                }
            } catch (e) {
                logger.warn(`Font loading failed: ${e.message}, using fallback`);
                fontFamily = 'sans-serif';
            }

            const SIZE = 512;

            const COLORS = [
                '#FF0000', '#FF4500', '#FF8C00', '#FFD700',
                '#00FF00', '#00FFCD', '#00FFFF', '#0080FF',
                '#8B00FF', '#FF00FF', '#FF1493', '#FF6347',
            ];

            // Draw each frame
            for (let i = 0; i < COLORS.length; i++) {
                const canvas = createCanvas(SIZE, SIZE);
                const ctx = canvas.getContext('2d');

                // Transparent background
                ctx.clearRect(0, 0, SIZE, SIZE);

                const color = COLORS[i];

                // Dynamic font size based on text length — no hard cap
                let fontSize = text.length <= 4 ? 130
                    : text.length <= 6 ? 110
                    : text.length <= 10 ? 88
                    : text.length <= 16 ? 70
                    : text.length <= 25 ? 54
                    : text.length <= 40 ? 42
                    : 32;

                // Use registered font
                ctx.font = `${fontSize}px ${fontFamily}`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // No glow — clean solid color fill
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.fillStyle = color;

                // Word-wrap if needed
                const maxWidth = SIZE - 40;
                const words = text.split(' ');
                const lines = [];
                let cur = '';
                for (const word of words) {
                    const test = cur ? `${cur} ${word}` : word;
                    if (ctx.measureText(test).width > maxWidth && cur) {
                        lines.push(cur);
                        cur = word;
                    } else {
                        cur = test;
                    }
                }
                lines.push(cur);

                const lineH = fontSize * 1.35;
                const startY = SIZE / 2 - ((lines.length - 1) * lineH) / 2;
                for (let j = 0; j < lines.length; j++) {
                    ctx.fillText(lines[j], SIZE / 2, startY + j * lineH);
                }

                const framePath = this._generateTempFileName('_rgb.png');
                fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
                frameFiles.push(framePath);
            }

            // Write ffmpeg concat list (each frame shown for 0.1s → ~10fps)
            concatFile = this._generateTempFileName('.txt');
            const concatContent = frameFiles
                .map(f => `file '${f.replace(/\\/g, '/')}'\nduration 0.10`)
                .join('\n');
            fs.writeFileSync(concatFile, concatContent);

            outputPath = this._generateTempFileName('.webp');

            const sharp = await this._getSharp();
            const framePngs = frameFiles.map(f => fs.readFileSync(f));
            let buffer;

            try {
                const totalHeight = SIZE * framePngs.length;
                let strip = await sharp({
                    create: { width: SIZE, height: totalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
                }).png().toBuffer();

                const composites = framePngs.map((png, idx) => ({
                    input: png,
                    top: idx * SIZE,
                    left: 0,
                }));

                strip = await sharp(strip).composite(composites).png().toBuffer();

                buffer = await sharp(strip, { animated: false })
                    .resize(SIZE, totalHeight, { fit: 'fill' })
                    .webp({
                        quality: 80,
                        loop: 0,
                        delay: framePngs.map(() => 100),
                        pageHeight: SIZE,
                    })
                    .toBuffer();
            } catch (sharpAnimErr) {
                logger.warn(`Sharp animated WebP assembly failed, falling back to FFmpeg: ${sharpAnimErr.message}`);
                await this._enqueueFfmpeg(() => this._runFfmpegWithTimeout(
                    ffmpeg()
                        .input(concatFile)
                        .inputOptions(['-f', 'concat', '-safe', '0'])
                        .outputOptions([
                            '-vcodec', 'libwebp',
                            '-vf', 'scale=512:512',
                            '-loop', '0',
                            '-preset', 'default',
                            '-pix_fmt', 'yuva420p',
                            '-an',
                            '-vsync', '0',
                        ])
                        .save(outputPath),
                    15000
                ));
                buffer = fs.readFileSync(outputPath);
            }
            try {
                const exif = new StickerExif({ pack: this.defaultPack, author: this.defaultAuthor });
                buffer = await exif.add(buffer);
            } catch (metaErr) {
                logger.warn(`RGB sticker metadata injection failed: ${metaErr.message}`);
            }
            try { await sock.sendMessage(chatId, { delete: processingMsg.key }); } catch {}
            await sock.sendMessage(chatId, { sticker: buffer }, { quoted: originalMsg || undefined });
            logger.info(`🌈 RGB sticker created for "${text}" in ${chatId}`);

        } catch (err) {
            logger.error('RGB sticker error:', err?.message || err);
            try { await sock.sendMessage(chatId, { delete: processingMsg.key }); } catch {}
            await sock.sendMessage(chatId, {
                text: '❌ Failed to generate RGB sticker. Try again!',
            }, { quoted: originalMsg || undefined });
        } finally {
            frameFiles.forEach(f => this._safeUnlink(f));
            if (outputPath) this._safeUnlink(outputPath);
            if (concatFile) this._safeUnlink(concatFile);
        }
    }
}

export default StickerController;
