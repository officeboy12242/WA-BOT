/**
 * Sticker Forwarder Service
 * Forwards stickers from groups and joined channels to target groups.
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

        this.recentStickers = new Map();
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

    async forwardSticker(sock, waMessage, fromChat) {
        try {
            if (!this.shouldForwardFrom(fromChat)) {
                return false;
            }

            const stickerPayload = extractStickerFromMessage(waMessage?.message);
            const messageId =
                (stickerPayload?.fileSha256
                    ? Buffer.from(stickerPayload.fileSha256).toString('hex')
                    : null) || waMessage?.key?.id || null;

            if (messageId && this.recentStickers.has(messageId)) {
                this.countDuplicates++;
                return false;
            }

            this.countReceived++;
            const isChannel = isNewsletterChat(fromChat);
            if (isChannel) {
                this.countFromChannels++;
                logger.info(`📥 Downloading channel sticker from ${fromChat}...`);
            }

            const buffer = await downloadStickerBuffer(sock, waMessage);

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
                logger.warn(
                    `Sticker re-pack failed, sending original bytes: ${formatError.message}`
                );
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
                    logger.error(`❌ Failed to send sticker: ${result.reason?.message || result.reason}`);
                }
            }

            if (successCount > 0) {
                this.countSent++;
                if (messageId) {
                    this.recentStickers.set(messageId, Date.now());
                    if (this.recentStickers.size > 100) {
                        const firstKey = this.recentStickers.keys().next().value;
                        this.recentStickers.delete(firstKey);
                    }
                }

                const sourceLabel = isNewsletterChat(fromChat) ? 'channel' : 'group';
                logger.info(
                    `✅ Sticker from ${sourceLabel} ${fromChat} → ${successCount}/${this.targetGroups.length} groups | ` +
                        `Sent: ${this.countSent}, In: ${this.countReceived}, Channels: ${this.countFromChannels}, ` +
                        `Err: ${this.countErrors}, Dup: ${this.countDuplicates}`
                );
                return true;
            }

            return false;
        } catch (error) {
            this.countErrors++;
            logger.error(`❌ Error forwarding sticker: ${error.message}`);
            return false;
        }
    }

    getStats() {
        return {
            sent: this.countSent,
            received: this.countReceived,
            fromChannels: this.countFromChannels,
            errors: this.countErrors,
            duplicates: this.countDuplicates,
        };
    }

    resetStats() {
        this.countSent = 0;
        this.countReceived = 0;
        this.countFromChannels = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        logger.info('📊 Sticker stats reset');
    }
}

export default StickerForwarder;
