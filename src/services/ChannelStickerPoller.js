/**
 * Channel sticker backfill — catches stickers missed by real-time events.
 */

import { logger } from '../utils/logger.js';
import { fetchNewsletterStickerMessages } from '../utils/channelMessages.js';
import { extractStickerFromMessage } from '../utils/stickerExtract.js';
import { isStickerDownloadReady } from '../utils/stickerDownload.js';

const POLL_INTERVAL_MS = 90_000;
const STICKERS_PER_FETCH = 10;
const CHANNEL_STAGGER_MS = 4000;

class ChannelStickerPoller {
    constructor(stickerForwarder) {
        this.stickerForwarder = stickerForwarder;
        this.channelJids = [];
        this._timer = null;
        this._sock = null;
        this._running = false;
    }

    setChannels(jids) {
        this.channelJids = [...new Set(jids || [])];
    }

    start(sock) {
        this._sock = sock;
        if (!this.channelJids.length) {
            return;
        }

        if (this._timer) {
            return;
        }

        logger.info(`📡 Channel sticker backfill active (${this.channelJids.length} channel(s), every ${POLL_INTERVAL_MS / 1000}s)`);
        this._timer = setInterval(() => {
            void this._pollAll();
        }, POLL_INTERVAL_MS);
        if (this._timer.unref) {
            this._timer.unref();
        }

        // First backfill shortly after connect
        setTimeout(() => void this._pollAll(), 15_000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._running = false;
        this._sock = null;
    }

    async _pollAll() {
        if (this._running || !this._sock || !this.channelJids.length) {
            return;
        }

        this._running = true;
        try {
            for (let i = 0; i < this.channelJids.length; i++) {
                const jid = this.channelJids[i];
                await this._pollChannel(jid);
                if (i < this.channelJids.length - 1) {
                    await new Promise((r) => setTimeout(r, CHANNEL_STAGGER_MS));
                }
            }
        } finally {
            this._running = false;
        }
    }

    async _pollChannel(channelJid) {
        if (!this._sock || !this.stickerForwarder) {
            return;
        }

        try {
            const stickers = await fetchNewsletterStickerMessages(
                this._sock,
                channelJid,
                STICKERS_PER_FETCH,
            );
            if (!stickers.length) {
                return;
            }

            let queued = 0;
            for (const msg of stickers) {
                const payload = extractStickerFromMessage(msg.message);
                if (!payload || !isStickerDownloadReady(payload)) {
                    continue;
                }

                const trackId = msg?.key?.id ? `${channelJid}:${msg.key.id}` : null;
                const contentHash = payload?.fileSha256
                    ? Buffer.from(payload.fileSha256).toString('hex')
                    : null;

                if (this.stickerForwarder.wasForwarded(trackId, contentHash)) {
                    continue;
                }

                const added = await this.stickerForwarder.forwardSticker(
                    this._sock,
                    msg,
                    channelJid,
                    { isBackfill: true },
                );
                if (added) queued++;
            }

            if (queued > 0) {
                logger.info(`📡 Channel backfill queued ${queued} sticker(s) from ${channelJid}`);
            }
        } catch (err) {
            logger.debug(`Channel backfill skipped for ${channelJid}: ${err.message}`);
        }
    }
}

export default ChannelStickerPoller;
