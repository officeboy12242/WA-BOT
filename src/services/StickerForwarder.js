/**
 * Sticker Forwarder Service
 * Forwards stickers from any group to specified target groups
 */

import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { Sticker } from 'wa-sticker-formatter';
import { logger } from '../utils/logger.js';

class StickerForwarder {
    constructor(targetGroups, packName, packAuthor) {
        this.targetGroups = targetGroups || [];
        this.packName = packName || 'Course Bot 🤖';
        this.packAuthor = packAuthor;
        
        // Statistics
        this.countSent = 0;
        this.countReceived = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        
        // Track recent stickers with timestamp to prevent duplicate forwards within 5 seconds
        this.recentStickers = new Map(); // Map<checksum, timestamp>
    }

    async forwardSticker(sock, stickerMessage, fromGroup) {
        try {
            // Don't forward stickers from target groups (avoid loop)
            if (this.targetGroups.includes(fromGroup)) {
                logger.info(`⏭️  Skipping - sticker from target group (avoiding loop)`);
                return false;
            }

            // Get unique identifier for this message
            const messageId = stickerMessage.fileSha256
                ? Buffer.from(stickerMessage.fileSha256).toString('hex')
                : null;

            // Check if we already processed this exact message (prevents duplicate events)
            if (messageId && this.recentStickers.has(messageId)) {
                this.countDuplicates++;
                return false;
            }

            this.countReceived++;
            logger.info(`📥 Received sticker from ${fromGroup}`);

            // Download sticker
            logger.info(`⬇️ Downloading sticker...`);
            const stream = await downloadContentFromMessage(stickerMessage, 'sticker');
            const buffer = await this.streamToBuffer(stream);
            logger.info(`✅ Downloaded sticker: ${buffer.length} bytes`);

            // Forward to all target groups (using raw buffer - no metadata processing)
            let successCount = 0;
            
            for (const targetGroup of this.targetGroups) {
                try {
                    logger.info(`📤 Sending sticker to ${targetGroup}...`);
                    
                    await sock.sendMessage(
                        targetGroup,
                        { sticker: buffer }
                    );
                    
                    successCount++;
                    logger.info(`✅ Sticker sent successfully to ${targetGroup}`);
                } catch (err) {
                    logger.error(`❌ Failed to send to ${targetGroup}: ${err.message}`);
                    this.countErrors++;
                }
            }

            if (successCount > 0) {
                this.countSent++;
                // Mark this message as processed
                if (messageId) {
                    this.recentStickers.set(messageId, Date.now());
                    
                    // Clean up old entries (keep only last 100)
                    if (this.recentStickers.size > 100) {
                        const firstKey = this.recentStickers.keys().next().value;
                        this.recentStickers.delete(firstKey);
                    }
                }
                
                logger.info(
                    `✅ Sticker forwarded to ${successCount}/${this.targetGroups.length} groups | ` +
                    `Sent: ${this.countSent}, In: ${this.countReceived}, Err: ${this.countErrors}, Dup: ${this.countDuplicates}`
                );
                return true;
            } else {
                logger.error(`❌ Failed to send sticker to any target group`);
            }

            return false;
        } catch (error) {
            this.countErrors++;
            logger.error(`❌ Error forwarding sticker: ${error.message}`);
            logger.error(`Error stack: ${error.stack}`);
            return false;
        }
    }

    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    getStats() {
        return {
            sent: this.countSent,
            received: this.countReceived,
            errors: this.countErrors,
            duplicates: this.countDuplicates
        };
    }

    resetStats() {
        this.countSent = 0;
        this.countReceived = 0;
        this.countErrors = 0;
        this.countDuplicates = 0;
        logger.info('📊 Sticker stats reset');
    }
}

export default StickerForwarder;
