/**
 * Sticker Controller
 * Handles sticker creation, conversion, and metadata management
 */

import { downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import WSF from 'wa-sticker-formatter';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

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
        this.defaultPack = config.STICKER_PACK_NAME || 'Sassy Bot';
        this.defaultAuthor = config.STICKER_PACK_AUTHOR || 'Sassy';
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
            const cropMode = args.includes('crop') || args.includes('c');
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
                await this._buildSticker(sock, chatId, mediaPath, packName, authorName, cropMode, noMetadata, waMessage);
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

    async _buildSticker(sock, chatId, mediaPath, packName, authorName, cropMode, noMetadata, quotedMsg) {
        const stickerPath = this._generateTempFileName('.webp');

        try {
            if (!fs.existsSync(mediaPath)) {
                throw new Error('Input media file not found');
            }

            const outputOptions = cropMode
                ? [
                    '-vcodec', 'libwebp',
                    '-vf', "crop=w='min(min(iw,ih),500)':h='min(min(iw,ih),500)',scale=500:500,setsar=1,fps=15",
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:10.0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0',
                    '-s', '512:512'
                ]
                : [
                    '-vcodec', 'libwebp',
                    '-vf', "scale='min(220,iw)':min'(220,ih)':force_original_aspect_ratio=decrease,fps=15, pad=220:220:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse",
                    '-loop', '0',
                    '-ss', '00:00:00.0',
                    '-t', '00:00:10.0',
                    '-preset', 'default',
                    '-an',
                    '-vsync', '0'
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
                    if (!fs.existsSync(stickerPath)) {
                        throw new Error('Output sticker file not created');
                    }

                    // Add metadata if not disabled
                    let finalStickerBuffer;
                    if (!noMetadata) {
                        finalStickerBuffer = await WSF.setMetadata(packName, authorName, stickerPath);
                        // WSF.setMetadata returns a buffer, use it directly
                    } else {
                        // If no metadata, just read the file
                        finalStickerBuffer = fs.readFileSync(stickerPath);
                    }

                    // Send sticker
                    await sock.sendMessage(chatId, {
                        sticker: Buffer.from(finalStickerBuffer)
                    }, { quoted: quotedMsg });

                } catch (wsError) {
                    logger.error('Sticker creation error:', JSON.stringify(wsError));
                    logger.error('Sticker creation error type:', typeof wsError);
                    logger.error('Sticker creation error message:', wsError?.message);
                    logger.error('Sticker creation error stack:', wsError?.stack);
                    logger.error('Sticker creation error string:', String(wsError));
                    await sock.sendMessage(chatId, {
                        text: '❌ Failed to create sticker.'
                    });
                } finally {
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
                // Add metadata
                let stickerBuffer;
                if (noMetadata) {
                    stickerBuffer = await WSF.setMetadata(undefined, undefined, stickerPath);
                } else {
                    stickerBuffer = await WSF.setMetadata(packName, authorName, stickerPath);
                }

                // Send sticker
                await sock.sendMessage(chatId, {
                    sticker: Buffer.from(stickerBuffer)
                }, { quoted: waMessage });
            } catch (error) {
                logger.error('Error setting metadata type:', typeof error);
                logger.error('Error setting metadata:', JSON.stringify(error));
                logger.error('Error setting metadata message:', error?.message);
                logger.error('Error setting metadata stack:', error?.stack);
                logger.error('Error setting metadata string:', String(error));
                logger.error('Sticker path:', stickerPath);
                logger.error('Pack name:', packName);
                logger.error('Author name:', authorName);
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
                    const imageBuffer = fs.readFileSync(imagePath);
                    await sock.sendMessage(chatId, {
                        image: imageBuffer,
                        caption: '✨ Sticker converted to image',
                        mimetype: 'image/png'
                    }, { quoted: waMessage });
                } catch (error) {
                    logger.error('Image send error:', error);
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
}

export default StickerController;
