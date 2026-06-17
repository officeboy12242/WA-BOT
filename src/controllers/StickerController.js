/**
 * Sticker Controller
 * Handles sticker creation, conversion, and metadata management
 */

import { downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import { getTextFromWAMessage } from '../utils/waMessage.js';
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
        this._ensureTempDir();
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

    /**
     * Create sticker from image or video
     */
    async handleSticker(sock, chatId, waMessage, args, textContent) {
        try {
            // Check if replying to media
            let targetMessage = waMessage;
            if (waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                targetMessage = {
                    ...waMessage,
                    message: waMessage.message.extendedTextMessage.contextInfo.quotedMessage
                };
            }

            const messageType = Object.keys(targetMessage.message)[0];
            const isImage = messageType === 'imageMessage';
            const isVideo = messageType === 'videoMessage';

            if (!isImage && !isVideo) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to an image or video (max 10 seconds).'
                });
                return;
            }

            // Check video duration
            if (isVideo && targetMessage.message.videoMessage?.seconds > 10) {
                await sock.sendMessage(chatId, {
                    text: '❌ Video must be less than 10 seconds.'
                });
                return;
            }

            // Parse arguments
            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
            const circleMode = args.some((a) => ['circle', 'round', 'circular'].includes(String(a).toLowerCase()));
            const cropMode = !circleMode && (args.includes('crop') || args.includes('c'));
            const shape = circleMode ? 'circle' : (cropMode ? 'crop' : 'default');
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

            // Download media
            const mediaPath = this._generateTempFileName(isImage ? '.png' : '.mp4');
            
            try {
                const buffer = await downloadMediaMessage(targetMessage, 'buffer', {});
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

                // Create sticker
                await this._buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, waMessage);
            } catch (error) {
                logger.error('Media download error:', error);
                this._safeUnlink(mediaPath);
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

    async _buildSticker(sock, chatId, mediaPath, packName, authorName, shape, noMetadata, quotedMsg) {
        const stickerPath = this._generateTempFileName('.webp');

        try {
            if (!fs.existsSync(mediaPath)) {
                throw new Error('Input media file not found');
            }

            const circleFilter = [
                "crop=w='min(iw,ih)':h='min(iw,ih)'",
                'scale=512:512',
                'format=rgba',
                "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-(W/2),Y-(H/2)),W/2-2),255,0)'",
                'fps=15',
            ].join(',');

            const outputOptions = shape === 'circle'
                ? [
                    '-vcodec', 'libwebp',
                    '-vf', circleFilter,
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:09.0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0',
                ]
                : shape === 'crop'
                ? [
                    '-vcodec', 'libwebp',
                    '-vf', "crop=w='min(min(iw,ih),500)':h='min(min(iw,ih),500)',scale=500:500,setsar=1,fps=15",
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:09.0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0',
                    '-s', '512:512'
                ]
                : [
                    '-vcodec', 'libwebp',
                    '-vf', "scale='min(220,iw)':min'(220,ih)':force_original_aspect_ratio=decrease,fps=15, pad=220:220:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"
                ];

            const ffmpegProcess = ffmpeg(mediaPath)
                .addOutputOptions(outputOptions)
                .toFormat('webp')
                .save(stickerPath);

            ffmpegProcess.on('error', (err) => {
                logger.error('FFmpeg error:', err);
                this._safeUnlink(mediaPath);
                this._safeUnlink(stickerPath);
                sock.sendMessage(chatId, {
                    text: '❌ Error converting media to sticker.'
                });
            });

            ffmpegProcess.on('end', async () => {
                try {
                    // Verify output file was created
                    if (!fs.existsSync(stickerPath)) {
                        throw new Error('Output sticker file not created');
                    }

                    // Read sticker buffer and optionally inject metadata via Exif
                    let stickerBuffer = fs.readFileSync(stickerPath);
                    if (!noMetadata) {
                        try {
                            const exif = new StickerExif({ pack: packName, author: authorName });
                            stickerBuffer = await exif.add(stickerBuffer);
                        } catch (metaErr) {
                            logger.warn(`Sticker metadata injection failed: ${metaErr.message}`);
                        }
                    }

                    await sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: quotedMsg });

                } catch (wsError) {
                    const errorMsg = wsError instanceof Error ? wsError.message : String(wsError);
                    const errorStack = wsError instanceof Error ? wsError.stack : '';
                    logger.error('Sticker creation error:', errorMsg);
                    logger.error('Sticker creation error stack:', errorStack);
                    
                    // Fallback: try sending without metadata
                    try {
                        if (fs.existsSync(stickerPath)) {
                            await sock.sendMessage(chatId, {
                                sticker: fs.readFileSync(stickerPath)
                            }, { quoted: quotedMsg });
                            logger.info('✓ Sticker sent successfully (fallback without metadata)');
                        } else {
                            throw new Error('No sticker file to send');
                        }
                    } catch (fallbackError) {
                        const fbErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                        logger.error('Fallback error:', fbErrorMsg);
                        await sock.sendMessage(chatId, {
                            text: '❌ Failed to create sticker.'
                        });
                    }
                } finally {
                    // Ensure cleanup happens
                    this._safeUnlink(mediaPath);
                    this._safeUnlink(stickerPath);
                }
            });
        } catch (err) {
            logger.error('buildSticker error:', err);
            await sock.sendMessage(chatId, {
                text: `❌ Error: ${err.message}`
            });
            this._safeUnlink(mediaPath);
            this._safeUnlink(stickerPath);
        }
    }

    /**
     * Steal sticker (change metadata)
     */
    async handleSteal(sock, chatId, waMessage, args, textContent) {
        try {
            logger.info('handleSteal called');
            // Check if replying to sticker
            const quotedMsg = waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage;
            logger.info(`quotedMsg exists: ${!!quotedMsg}, stickerMessage: ${!!quotedMsg?.stickerMessage}`);
            
            if (!quotedMsg || !quotedMsg.stickerMessage) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.'
                });
                return;
            }

            // Parse arguments
            let packName = this.defaultPack;
            let authorName = this.defaultAuthor;
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

            // Download sticker using stream approach (same as reference repo)
            const stickerMessage = quotedMsg.stickerMessage;
            const stream = await downloadContentFromMessage(stickerMessage, 'sticker');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.'
                });
                return;
            }

            const stickerPath = this._generateTempFileName('.webp');
            await writeFile(stickerPath, buffer);

            try {
                // Read buffer and inject metadata via Exif
                let finalBuffer = fs.readFileSync(stickerPath);
                if (!noMetadata) {
                    try {
                        const exif = new StickerExif({ pack: packName, author: authorName });
                        finalBuffer = await exif.add(finalBuffer);
                    } catch (metaErr) {
                        logger.warn(`Steal metadata injection failed: ${metaErr.message}`);
                    }
                }

                await sock.sendMessage(chatId, { sticker: finalBuffer }, { quoted: waMessage });
                logger.info('✓ Sticker metadata updated successfully');
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error('Error in steal handler:', errorMsg);
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to modify sticker metadata.'
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
        try {
            // Check if replying to sticker
            let targetMessage = waMessage;
            if (waMessage.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                targetMessage = {
                    ...waMessage,
                    message: waMessage.message.extendedTextMessage.contextInfo.quotedMessage
                };
            }

            const messageType = Object.keys(targetMessage.message)[0];
            if (messageType !== 'stickerMessage') {
                await sock.sendMessage(chatId, {
                    text: '❌ Please reply to a sticker.'
                });
                return;
            }

            // Download sticker using stream approach
            const stickerMessage = targetMessage.message.stickerMessage;
            const stream = await downloadContentFromMessage(stickerMessage, 'sticker');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            
            if (!buffer || buffer.length === 0) {
                await sock.sendMessage(chatId, {
                    text: '❌ Failed to download sticker.'
                });
                return;
            }

            const stickerPath = this._generateTempFileName('.webp');
            const imagePath = this._generateTempFileName('.png');

            await writeFile(stickerPath, buffer);

            // Convert to image
            const ffmpegProcess = ffmpeg(stickerPath)
                .fromFormat('webp_pipe')
                .save(imagePath);

            ffmpegProcess.on('error', (err) => {
                logger.error('FFmpeg error:', err);
                this._safeUnlink(stickerPath);
                this._safeUnlink(imagePath);
                sock.sendMessage(chatId, {
                    text: '❌ Failed to convert sticker. Only non-animated stickers can be converted to images.'
                });
            });

            ffmpegProcess.on('end', async () => {
                try {
                    if (!fs.existsSync(imagePath)) {
                        throw new Error('Output image file not created');
                    }

                    const imageBuffer = fs.readFileSync(imagePath);
                    await sock.sendMessage(chatId, {
                        image: imageBuffer,
                        caption: '✨ Sticker converted to image',
                        mimetype: 'image/png'
                    }, { quoted: waMessage });
                } catch (error) {
                    logger.error('Image send error:', error?.message || error);
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to send image.'
                    });
                } finally {
                    this._safeUnlink(stickerPath);
                    this._safeUnlink(imagePath);
                }
            });
        } catch (error) {
            logger.error('ToImage handler error:', error);
            await sock.sendMessage(chatId, {
                text: '⚠️ Failed to convert sticker.'
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

            // Combine frames → animated WebP
            await new Promise((resolve, reject) => {
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
                    .output(outputPath)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
            });

            // Read WebP buffer and inject metadata via Exif
            let buffer = fs.readFileSync(outputPath);
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
