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
const DOWNLOAD_TIMEOUT_MS = 10000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

async function tryDirectDownload(url, directPath) {
    const downloadUrl = url || (directPath ? `https://mmg.whatsapp.net${directPath}` : null);
    if (!downloadUrl) return null;
    
    const https = await import('https');
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 8000);
        https.default.get(downloadUrl, (res) => {
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
        }).on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
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

    if (isChannel && sticker) {
        const directBuffer = await tryDirectDownload(sticker.url, sticker.directPath);
        if (directBuffer?.length > 100) {
            return directBuffer;
        }
        throw new Error('Channel sticker download failed');
    }

    if (sticker && hasMediaKey(sticker)) {
        try {
            return await tryDownloadMediaMessage(sock, waMessage);
        } catch {
            return await tryDownloadContent(sock, sticker);
        }
    }
    
    if (sticker) {
        return await tryDownloadMediaMessage(sock, waMessage);
    }

    throw new Error('No sticker found');
}
