/**
 * Sticker Forwarder Service
 * Forwards stickers from groups and joined channels to target groups.
 * Queue + retry loop — stickers are only marked done after a successful send.
 */

import { Sticker } from 'wa-sticker-formatter';
import { logger } from '../utils/logger.js';
import { downloadStickerBuffer, isValidWebpBuffer } from '../utils/stickerDownload.js';
import { extractStickerFromMessage, isNewsletterChat } from '../utils/stickerExtract.js';

const MAX_QUEUE_SIZE = 500;
const MAX_COMPLETED = 2000;
const MAX_RETRIES = 6;
const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 45000, 90000];
const INTER_SEND_DELAY_MS = 400;
const RETRY_TICK_MS = 3000;

function stickerKeys(waMessage, fromChat) {
    const stickerPayload = extractStickerFromMessage(waMessage?.message);
    const msgId = waMessage?.key?.id || null;
    const contentHash = stickerPayload?.fileSha256
        ? Buffer.from(stickerPayload.fileSha256).toString('hex')
        : null;

    return {
        trackId: msgId ? `${fromChat}:${msgId}` : null,
        contentHash,
    };
}

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
        this.countRetried = 0;

        /** Successfully forwarded message keys */
        this.completedTrackIds = new Set();
        /** Successfully forwarded sticker content (fileSha256) */
        this.completedContentHashes = new Set();
        /** Currently being processed */
        this.inFlightTrackIds = new Set();
        /** trackId -> { item, attempts, nextRetryAt } */
        this.retryLater = new Map();

        this.queue = [];
        this.isProcessing = false;
        this._retryTimer = null;
    }

    startBackgroundWorkers() {
        if (this._retryTimer) return;
        this._retryTimer = setInterval(() => {
            void this._drainRetryLater();
        }, RETRY_TICK_MS);
        if (this._retryTimer.unref) {
            this._retryTimer.unref();
        }
        logger.info('🔄 Sticker forward retry worker started');
    }

    stopBackgroundWorkers() {
        if (this._retryTimer) {
            clearInterval(this._retryTimer);
            this._retryTimer = null;
        }
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

    wasForwarded(trackId, contentHash) {
        if (trackId && this.completedTrackIds.has(trackId)) {
            return true;
        }
        if (contentHash && this.completedContentHashes.has(contentHash)) {
            return true;
        }
        return false;
    }

    /**
     * Queue a sticker for forwarding. Dedupes only completed forwards, not failures.
     */
    async forwardSticker(sock, waMessage, fromChat, { isRetry = false, isBackfill = false } = {}) {
        if (!this.shouldForwardFrom(fromChat)) {
            return false;
        }

        const { trackId, contentHash } = stickerKeys(waMessage, fromChat);

        if (!trackId && !contentHash) {
            return false;
        }

        if (this.wasForwarded(trackId, contentHash)) {
            this.countDuplicates++;
            return false;
        }

        if (trackId && this.inFlightTrackIds.has(trackId) && !isRetry) {
            return false;
        }

        if (trackId && this.retryLater.has(trackId) && !isRetry) {
            const pending = this.retryLater.get(trackId);
            pending.item = { sock, waMessage, fromChat, trackId, contentHash };
            return true;
        }

        if (this.queue.length >= MAX_QUEUE_SIZE) {
            logger.warn(`⚠️ Sticker queue at ${MAX_QUEUE_SIZE} — processing immediately`);
            void this._processQueue();
        }

        this.queue.push({ sock, waMessage, fromChat, trackId, contentHash, isBackfill });
        this.countQueued++;

        const isChannel = isNewsletterChat(fromChat);
        logger.info(
            `📥 Sticker queued from ${isChannel ? 'channel' : 'group'} | ` +
                `Queue: ${this.queue.length}${isRetry ? ' (retry)' : ''}${isBackfill ? ' (backfill)' : ''}`
        );

        void this._processQueue();
        return true;
    }

    async _drainRetryLater() {
        if (!this.retryLater.size) return;

        const now = Date.now();
        for (const [trackId, entry] of this.retryLater) {
            if (entry.nextRetryAt > now) continue;
            if (this.inFlightTrackIds.has(trackId)) continue;

            this.retryLater.delete(trackId);
            this.countRetried++;
            logger.info(`🔄 Auto-retry sticker ${trackId.slice(-16)} (attempt ${entry.attempts + 1})`);
            await this.forwardSticker(
                entry.item.sock,
                entry.item.waMessage,
                entry.item.fromChat,
                { isRetry: true },
            );
        }
    }

    async _processQueue() {
        if (this.isProcessing || this.queue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (item.trackId) {
                this.inFlightTrackIds.add(item.trackId);
            }

            try {
                const ok = await this._processSticker(item);
                if (ok && item.trackId) {
                    this.retryLater.delete(item.trackId);
                }
            } catch (error) {
                this.countErrors++;
                this._scheduleRetry(item, error);
            } finally {
                if (item.trackId) {
                    this.inFlightTrackIds.delete(item.trackId);
                }
            }

            if (this.queue.length > 0) {
                await new Promise((r) => setTimeout(r, INTER_SEND_DELAY_MS));
            }
        }

        this.isProcessing = false;
    }

    _scheduleRetry(item, error) {
        const trackId = item.trackId;
        if (!trackId) {
            logger.error(`❌ Sticker error (no track id): ${error.message}`);
            return;
        }

        const prev = this.retryLater.get(trackId);
        const attempts = (prev?.attempts ?? 0) + 1;

        if (attempts >= MAX_RETRIES) {
            this.retryLater.delete(trackId);
            logger.error(`❌ Sticker gave up after ${MAX_RETRIES} tries (${trackId.slice(-16)}): ${error.message}`);
            return;
        }

        const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
        this.retryLater.set(trackId, {
            item,
            attempts,
            nextRetryAt: Date.now() + delay,
        });
        logger.warn(
            `⏳ Sticker retry ${attempts}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s ` +
                `(${trackId.slice(-16)}): ${error.message}`
        );
    }

    _markCompleted(trackId, contentHash) {
        if (trackId) {
            this.completedTrackIds.add(trackId);
            if (this.completedTrackIds.size > MAX_COMPLETED) {
                const oldest = this.completedTrackIds.values().next().value;
                this.completedTrackIds.delete(oldest);
            }
        }
        if (contentHash) {
            this.completedContentHashes.add(contentHash);
            if (this.completedContentHashes.size > MAX_COMPLETED) {
                const oldest = this.completedContentHashes.values().next().value;
                this.completedContentHashes.delete(oldest);
            }
        }
    }

    /**
     * @returns {Promise<boolean>} true when at least one target received the sticker
     */
    async _processSticker({ sock, waMessage, fromChat, trackId, contentHash }) {
        this.countReceived++;
        const isChannel = isNewsletterChat(fromChat);

        if (isChannel) {
            this.countFromChannels++;
        }

        if (this.wasForwarded(trackId, contentHash)) {
            this.countDuplicates++;
            return true;
        }

        const buffer = await downloadStickerBuffer(sock, waMessage);
        if (!isValidWebpBuffer(buffer)) {
            throw new Error('Downloaded sticker is not valid WebP');
        }

        let stickerBuffer = buffer;
        try {
            const sticker = new Sticker(buffer, {
                pack: this.packName,
                author: this.packAuthor,
                type: 'default',
                quality: 50,
            });
            const repacked = await sticker.toBuffer();
            if (isValidWebpBuffer(repacked)) {
                stickerBuffer = repacked;
            } else {
                logger.warn('Sticker re-pack produced invalid WebP, sending original');
            }
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
                        mediaUploadTimeoutMs: 90000,
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

        if (successCount === 0) {
            throw new Error(`Send failed to all ${this.targetGroups.length} target group(s)`);
        }

        this._markCompleted(trackId, contentHash);
        this.countSent++;
        const sourceLabel = isChannel ? 'channel' : 'group';
        logger.info(
            `✅ Sticker from ${sourceLabel} → ${successCount}/${this.targetGroups.length} groups | ` +
                `Sent: ${this.countSent}, Queue: ${this.queue.length}, Retries pending: ${this.retryLater.size}, ` +
                `Channels: ${this.countFromChannels}, Err: ${this.countErrors}`
        );
        return true;
    }

    getStats() {
        return {
            sent: this.countSent,
            received: this.countReceived,
            queued: this.countQueued,
            queueLength: this.queue.length,
            retriesPending: this.retryLater.size,
            retried: this.countRetried,
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
        this.countRetried = 0;
        logger.info('📊 Sticker stats reset');
    }
}

export default StickerForwarder;
