/**
 * Sends daily good morning messages to configured phone numbers.
 */

import { logger } from '../utils/logger.js';
import { formatRomanticMorningMessage } from '../utils/morningEmojiFormatter.js';

function toWhatsAppJid(phone) {
    const digits = String(phone).replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
}

class MorningMessageController {
    constructor(morningDb, scraper, config) {
        this.morningDb = morningDb;
        this.scraper = scraper;
        this.config = config;
    }

    async sendDailyMorning(sock, botState) {
        if (!sock) {
            logger.info('Waiting for WhatsApp connection (morning messages)...');
            return;
        }

        if (!this.config.MORNING_MESSAGES_ENABLED) {
            return;
        }

        if (botState.isPaused) {
            logger.info('Bot is paused. Skipping morning messages.');
            return;
        }

        const recipients = this.config.MORNING_MESSAGE_NUMBERS;
        if (!recipients.length) {
            return;
        }

        logger.info('─── Sending daily good morning messages ───');

        try {
            const pick = await this.scraper.pickFreshMessage();
            if (!pick) {
                logger.warn('No fresh morning message available today');
                return;
            }

            const text = formatRomanticMorningMessage(pick.text);
            let sent = 0;

            for (const phone of recipients) {
                const jid = toWhatsAppJid(phone);
                try {
                    await sock.sendMessage(jid, { text });
                    sent++;
                    logger.info(`🌅 Morning message sent to ${phone}`);
                    await new Promise((resolve) => setTimeout(resolve, 1200));
                } catch (error) {
                    logger.error(`Morning message failed for ${phone}: ${error.message}`);
                }
            }

            if (sent > 0) {
                await this.morningDb.markSent(pick.text, pick.source);
                logger.info(`Daily morning message delivered to ${sent}/${recipients.length} recipient(s)`);
            }
        } catch (error) {
            logger.error(`Morning message job failed: ${error.message}`);
        }
    }
}

export default MorningMessageController;
