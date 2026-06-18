/**
 * Download sticker bytes from group or channel WAMessages.
 * Simplified: no longer uses newsletterFetchMessages (times out).
 * Relies on direct download + updateMediaMessage for channels.
 */

import {
    downloadContentFromMessage,
    downloadMediaMessage,
    normalizeMessageContent,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { logger } from './logger.js';
import { extractStickerFromMessage, isNewsletterChat } from './stickerExtract.js';

const baileysLogger = pino({ level: 'silent' });
const DOWNLOAD_TIMEOUT_MS = 30000; // Increased to 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function tryDirectDownload(url, directPath) {
    const downloadUrl = url || (directPath ? `https://mmg.whatsapp.net${directPath}` : null);
    if (!downloadUrl) return null;
    
    const https = await import('https');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 15000); // 15 second timeout
        
        const req = https.default.get(downloadUrl, { timeout: 15000 }, (res) => {
            if (res.statusCode !== 200) {
                clearTimeout(timeout);
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timeout);
                resolve(Buffer.concat(chunks));
            });
            res.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
        
        req.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        
        req.on('timeout', () => {
            req.destroy();
            clearTimeout(timeout);
            reject(new Error('request timeout'));
        });
    });
}

function hasMediaKey(media) {
    if (!media?.mediaKey) {
        return false;
    }
    if (Buffer.isBuffer(media.mediaKey)) {
        return media.mediaKey.length > 0;
    }
    if (media.mediaKey instanceof Uint8Array) {
        return media.mediaKey.length > 0;
    }
    return true;
}

function downloadContext(sock) {
    return {
        logger: baileysLogger,
        reuploadRequest: sock?.updateMediaMessage
            ? sock.updateMediaMessage.bind(sock)
            : undefined,
    };
}

/** @param {import('@whiskeysockets/baileys').WASocket} sock */
export function createDownloadContext(sock) {
    return downloadContext(sock);
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<Buffer>}
 */
async function tryDownloadMediaMessage(sock, waMessage) {
    const buffer = await withTimeout(
        downloadMediaMessage(waMessage, 'buffer', {}, downloadContext(sock)),
        DOWNLOAD_TIMEOUT_MS,
        'downloadMediaMessage'
    );
    if (!buffer?.length) {
        throw new Error('empty sticker buffer');
    }
    return buffer;
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} stickerPayload
 * @returns {Promise<Buffer>}
 */
async function tryDownloadContent(sock, stickerPayload) {
    const downloadPromise = (async () => {
        const stream = await downloadContentFromMessage(
            stickerPayload,
            'sticker',
            downloadContext(sock)
        );
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    })();
    return withTimeout(downloadPromise, DOWNLOAD_TIMEOUT_MS, 'downloadContentFromMessage');
}


/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<Buffer>}
 */
export async function downloadStickerBuffer(sock, waMessage) {
    const chatId = waMessage?.key?.remoteJid;
    const isChannel = isNewsletterChat(chatId);
    const sticker = extractStickerFromMessage(waMessage.message);

    // Channel stickers - use direct download
    if (isChannel && sticker) {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const directBuffer = await tryDirectDownload(sticker.url, sticker.directPath);
                if (directBuffer?.length > 100) {
                    return directBuffer;
                }
            } catch (err) {
                logger.debug(`Channel sticker download attempt ${attempt} failed: ${err.message}`);
                if (attempt < MAX_RETRIES) {
                    await delay(RETRY_DELAY_MS * attempt);
                }
            }
        }
        throw new Error('Channel sticker download failed after retries');
    }

    // Group stickers - try multiple methods with retries
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Method 1: downloadMediaMessage (preferred)
            if (sticker && hasMediaKey(sticker)) {
                try {
                    return await tryDownloadMediaMessage(sock, waMessage);
                } catch (err) {
                    // Fall through to method 2
                    lastError = err;
                }
            }
            
            // Method 2: downloadContentFromMessage
            if (sticker) {
                try {
                    return await tryDownloadContent(sock, sticker);
                } catch (err) {
                    lastError = err;
                }
            }
            
            // Method 3: Try downloadMediaMessage without mediaKey check
            if (sticker) {
                return await tryDownloadMediaMessage(sock, waMessage);
            }
        } catch (err) {
            lastError = err;
            logger.debug(`Sticker download attempt ${attempt} failed: ${err.message}`);
        }
        
        if (attempt < MAX_RETRIES) {
            logger.debug(`Retrying sticker download in ${RETRY_DELAY_MS * attempt}ms...`);
            await delay(RETRY_DELAY_MS * attempt);
        }
    }

    throw lastError || new Error('No sticker found');
}
