/**
 * Sticker Forwarder Service
 * Forwards stickers from groups and joined channels to target groups.
 * Uses BullMQ/Redis queue for reliability (falls back to in-memory if Redis unavailable)
 */

import { Sticker } from 'wa-sticker-formatter';
import { logger } from '../utils/logger.js';
import { downloadStickerBuffer } from '../utils/stickerDownload.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';
import queueService from './QueueService.js';

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
        this.sock = null;
        this.queueInitialized = false;
    }

    /**
     * Initialize BullMQ queue for sticker processing
     */
    async initializeQueue(sock) {
        this.sock = sock;
        
        if (this.queueInitialized) return;

        // Create sticker queue with processor
        queueService.createQueue('sticker-forward', async (job) => {
            await this._processSticker(job.data);
        }, {
            concurrency: 1,
            limiter: { max: 3, duration: 1000 }, // Max 3 stickers per second
        });

        this.queueInitialized = true;
        logger.info('📦 Sticker forwarding queue initialized');
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
     * Uses BullMQ for reliable processing with retries
     */
    async forwardSticker(sock, waMessage, fromChat) {
        if (!this.shouldForwardFrom(fromChat)) {
            return false;
        }

        // Store sock reference for the processor
        if (!this.sock) this.sock = sock;

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

        // Store waMessage data for queue (can't serialize sock)
        const jobData = {
            messageId,
            fromChat,
            waMessageKey: waMessage?.key,
            waMessageContent: waMessage?.message,
            isChannel: isNewsletterChat(fromChat),
        };

        try {
            // Add to BullMQ queue
            await queueService.addJob('sticker-forward', jobData, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            });
            
            this.countQueued++;
            const stats = await queueService.getStats('sticker-forward');
            logger.info(`📥 Sticker queued from ${jobData.isChannel ? 'channel' : 'group'} | Queue: ${stats?.waiting || 0} waiting`);
            
            return true;
        } catch (err) {
            logger.error(`❌ Failed to queue sticker: ${err.message}`);
            return false;
        }
    }

    /**
     * Actually process and forward a single sticker (called by queue processor)
     */
    async _processSticker({ fromChat, waMessageKey, waMessageContent, isChannel, messageId }) {
        if (!this.sock) {
            throw new Error('Socket not initialized');
        }

        this.countReceived++;
        
        if (isChannel) {
            this.countFromChannels++;
        }

        // Reconstruct waMessage for download
        const waMessage = { key: waMessageKey, message: waMessageContent };
        
        const buffer = await downloadStickerBuffer(this.sock, waMessage);
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
                this.sock.sendMessage(
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
            const stats = await queueService.getStats('sticker-forward');
            logger.info(
                `✅ Sticker from ${sourceLabel} → ${successCount}/${this.targetGroups.length} groups | ` +
                    `Sent: ${this.countSent}, Queued: ${this.countQueued}, Waiting: ${stats?.waiting || 0}, ` +
                    `Channels: ${this.countFromChannels}, Err: ${this.countErrors}`
            );
        }
    }

    async getStats() {
        const queueStats = await queueService.getStats('sticker-forward');
        return {
            sent: this.countSent,
            received: this.countReceived,
            queued: this.countQueued,
            waiting: queueStats?.waiting || 0,
            active: queueStats?.active || 0,
            fromChannels: this.countFromChannels,
            errors: this.countErrors,
            duplicates: this.countDuplicates,
            redisEnabled: queueStats?.redis || false,
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
