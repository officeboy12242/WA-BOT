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
        return;
    }
}

export default MorningMessageController;
