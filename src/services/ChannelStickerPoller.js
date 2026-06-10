/**
 * Track channel stickers to prevent duplicates.
 * Uses real-time events only - no polling.
 */

import { logger } from '../utils/logger.js';

const MAX_TRACKED_IDS = 300;

class ChannelStickerPoller {
    constructor(stickerForwarder) {
        this.stickerForwarder = stickerForwarder;
        this.channelJids = [];
        this.seenMessageIds = new Map();
    }

    setChannels(jids) {
        this.channelJids = [...new Set(jids || [])];
    }

    start(sock) {
        if (this.channelJids.length) {
            logger.info(`📡 Channel sticker tracking active (${this.channelJids.length} channel(s))`);
        }
    }

    stop() {}

    rememberId(channelJid, messageId) {
        if (!channelJid || !messageId) return;
        if (!this.seenMessageIds.has(channelJid)) {
            this.seenMessageIds.set(channelJid, new Set());
        }
        const set = this.seenMessageIds.get(channelJid);
        set.add(messageId);
        if (set.size > MAX_TRACKED_IDS) {
            const oldest = [...set].slice(0, set.size - MAX_TRACKED_IDS);
            oldest.forEach(id => set.delete(id));
        }
    }

    isSeen(channelJid, messageId) {
        return Boolean(messageId && this.seenMessageIds.get(channelJid)?.has(messageId));
    }

    isConfiguredChannel(jid) {
        return !this.channelJids.length || this.channelJids.includes(jid);
    }
}

export default ChannelStickerPoller;
