/**
 * Sticker Forwarder Service
 * Forwards stickers from groups and joined channels to target groups.
 * Uses a queue to ensure no stickers are skipped when they arrive rapidly.
 */

import { Sticker } from 'wa-sticker-formatter';
import { logger } from '../utils/logger.js';
import { downloadStickerBuffer } from '../utils/stickerDownload.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';

class StickerForwarder {
    /**
     * @param {string[]} targetGroups
     * @param {string} packName
     * @param {string} packAuthor
     * @param {string[]} [sourceChannels] empty = all joined @newsletter channels
     */
    constructor(targetGroups, packName, packAuthor, sourceChannels = []) {
        this.targetGroups = targetGroups || [];
        this.sourceChannels = sourceChannels || [];
        this.resolvedChannelNames = new Map();
        this.packName = packName || '';
        this.packAuthor = packAuthor;

        this.countSent = 0;
        this.countReceived = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        this.countFromChannels = 0;
        this.countQueued = 0;

        this.recentStickers = new Map();
        
        // Queue system to prevent skipping stickers
        this.queue = [];
        this.isProcessing = false;
        this.maxQueueSize = 50; // Prevent memory issues
    }

    setSourceChannels(jids, nameByJid = new Map()) {
        this.sourceChannels = jids || [];
        this.resolvedChannelNames = nameByJid;
    }

    shouldForwardFrom(chatId) {
        if (!chatId || this.targetGroups.includes(chatId)) {
            return false;
        }

        if (isNewsletterChat(chatId)) {
            if (!this.sourceChannels.length) {
                return true;
            }
            return this.sourceChannels.includes(chatId);
        }

        if (chatId.endsWith('@g.us')) {
            return true;
        }

        return false;
    }

    /**
     * Add sticker to queue for processing (public method)
     * This ensures no stickers are skipped even when they arrive rapidly
     */
    async forwardSticker(sock, waMessage, fromChat) {
        if (!this.shouldForwardFrom(fromChat)) {
            return false;
        }

        const stickerPayload = extractStickerFromMessage(waMessage?.message);
        const messageId =
            (stickerPayload?.fileSha256
                ? Buffer.from(stickerPayload.fileSha256).toString('hex')
                : null) || waMessage?.key?.id || null;

        // Check for duplicates before queueing
        if (messageId && this.recentStickers.has(messageId)) {
            this.countDuplicates++;
            return false;
        }

        // Mark as seen immediately to prevent duplicate queueing
        if (messageId) {
            this.recentStickers.set(messageId, Date.now());
            if (this.recentStickers.size > 200) {
                const firstKey = this.recentStickers.keys().next().value;
                this.recentStickers.delete(firstKey);
            }
        }

        // Check queue size limit
        if (this.queue.length >= this.maxQueueSize) {
            logger.warn(`⚠️ Sticker queue full (${this.maxQueueSize}), dropping oldest`);
            this.queue.shift();
        }

        // Add to queue
        this.queue.push({ sock, waMessage, fromChat, messageId });
        this.countQueued++;
        
        const isChannel = isNewsletterChat(fromChat);
        logger.info(`📥 Sticker queued from ${isChannel ? 'channel' : 'group'} | Queue: ${this.queue.length}`);

        // Start processing if not already running
        this._processQueue();
        
        return true;
    }

    /**
     * Process queue one at a time to prevent race conditions
     */
    async _processQueue() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await this._processSticker(item);
            } catch (error) {
                this.countErrors++;
                logger.error(`❌ Queue sticker error: ${error.message}`);
            }
            
            // Delay between processing to avoid rate limits and allow downloads
            if (this.queue.length > 0) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        this.isProcessing = false;
    }

    /**
     * Actually process and forward a single sticker
     */
    async _processSticker({ sock, waMessage, fromChat, messageId }) {
        this.countReceived++;
        const isChannel = isNewsletterChat(fromChat);
        
        if (isChannel) {
            this.countFromChannels++;
        }

        const buffer = await downloadStickerBuffer(sock, waMessage);
        if (!buffer) {
            throw new Error('Failed to download sticker buffer');
        }

        let stickerBuffer = buffer;
        try {
            const sticker = new Sticker(buffer, {
                pack: this.packName,
                author: this.packAuthor,
                type: 'default',
                quality: 50,
            });
            stickerBuffer = await sticker.toBuffer();
        } catch (formatError) {
            logger.warn(`Sticker re-pack failed, sending original: ${formatError.message}`);
        }

        const results = await Promise.allSettled(
            this.targetGroups.map((targetGroup) =>
                sock.sendMessage(
                    targetGroup,
                    { sticker: stickerBuffer },
                    {
                        ephemeralExpiration: 86400,
                        mediaUploadTimeoutMs: 60000,
                    }
                )
            )
        );

        const successCount = results.filter((r) => r.status === 'fulfilled').length;
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error(`❌ Send failed: ${result.reason?.message || result.reason}`);
            }
        }

        if (successCount > 0) {
            this.countSent++;
            const sourceLabel = isChannel ? 'channel' : 'group';
            logger.info(
                `✅ Sticker from ${sourceLabel} → ${successCount}/${this.targetGroups.length} groups | ` +
                    `Sent: ${this.countSent}, Queued: ${this.countQueued}, Queue: ${this.queue.length}, ` +
                    `Channels: ${this.countFromChannels}, Err: ${this.countErrors}`
            );
        }
    }

    getStats() {
        return {
            sent: this.countSent,
            received: this.countReceived,
            queued: this.countQueued,
            queueLength: this.queue.length,
            fromChannels: this.countFromChannels,
            errors: this.countErrors,
            duplicates: this.countDuplicates,
            isProcessing: this.isProcessing,
        };
    }

    resetStats() {
        this.countSent = 0;
        this.countReceived = 0;
        this.countQueued = 0;
        this.countFromChannels = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        logger.info('📊 Sticker stats reset');
    }
}

export default StickerForwarder;
