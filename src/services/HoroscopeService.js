/**
 * Horoscope Service
 * Fetches daily horoscope using free API
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const ZODIAC_SIGNS = [
    'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
    'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'
];

const ZODIAC_EMOJIS = {
    aries: '♈',
    taurus: '♉',
    gemini: '♊',
    cancer: '♋',
    leo: '♌',
    virgo: '♍',
    libra: '♎',
    scorpio: '♏',
    sagittarius: '♐',
    capricorn: '♑',
    aquarius: '♒',
    pisces: '♓'
};

const ZODIAC_DATES = {
    aries: 'Mar 21 - Apr 19',
    taurus: 'Apr 20 - May 20',
    gemini: 'May 21 - Jun 20',
    cancer: 'Jun 21 - Jul 22',
    leo: 'Jul 23 - Aug 22',
    virgo: 'Aug 23 - Sep 22',
    libra: 'Sep 23 - Oct 22',
    scorpio: 'Oct 23 - Nov 21',
    sagittarius: 'Nov 22 - Dec 21',
    capricorn: 'Dec 22 - Jan 19',
    aquarius: 'Jan 20 - Feb 18',
    pisces: 'Feb 19 - Mar 20'
};

class HoroscopeService {
    constructor() {
        this._cache = new Map();
        this._cacheExpiry = 6 * 60 * 60 * 1000; // 6 hours cache
    }

    /**
     * Normalize and validate zodiac sign input
     */
    normalizeSign(input) {
        if (!input) return null;
        const normalized = input.toLowerCase().trim();
        
        // Handle common abbreviations
        const aliases = {
            'cap': 'capricorn',
            'sag': 'sagittarius',
            'sagi': 'sagittarius',
            'aqua': 'aquarius',
            'scorp': 'scorpio',
            'leo': 'leo',
            'gem': 'gemini',
            'ari': 'aries',
            'tau': 'taurus',
            'can': 'cancer',
            'vir': 'virgo',
            'lib': 'libra',
            'pis': 'pisces'
        };
        
        if (aliases[normalized]) return aliases[normalized];
        if (ZODIAC_SIGNS.includes(normalized)) return normalized;
        
        // Partial match
        const match = ZODIAC_SIGNS.find(s => s.startsWith(normalized));
        return match || null;
    }

    /**
     * Get cache key for today
     */
    _getCacheKey(sign) {
        const today = new Date().toISOString().split('T')[0];
        return `${sign}_${today}`;
    }

    /**
     * Fetch horoscope from API
     */
    async fetchHoroscope(sign) {
        const normalizedSign = this.normalizeSign(sign);
        if (!normalizedSign) {
            return { error: 'invalid_sign' };
        }

        // Check cache
        const cacheKey = this._getCacheKey(normalizedSign);
        const cached = this._cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this._cacheExpiry) {
            logger.debug(`Horoscope cache hit for ${normalizedSign}`);
            return cached.data;
        }

        try {
            // Using Ohmanda Horoscope API (free, no key required)
            const response = await axios.get(
                `https://ohmanda.com/api/horoscope/${normalizedSign}/`,
                { timeout: 10000 }
            );

            if (response.data && response.data.horoscope) {
                const data = {
                    sign: normalizedSign,
                    emoji: ZODIAC_EMOJIS[normalizedSign],
                    dates: ZODIAC_DATES[normalizedSign],
                    horoscope: response.data.horoscope,
                    date: new Date().toLocaleDateString('en-IN', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    })
                };

                // Cache the result
                this._cache.set(cacheKey, { data, timestamp: Date.now() });
                logger.info(`Fetched horoscope for ${normalizedSign}`);
                return data;
            }

            throw new Error('Invalid API response');
        } catch (err) {
            logger.error(`Horoscope API error for ${normalizedSign}:`, err.message);
            
            // Try backup API
            return this._fetchBackup(normalizedSign);
        }
    }

    /**
     * Backup API if primary fails
     */
    async _fetchBackup(sign) {
        try {
            // Using Aztro-like endpoint
            const response = await axios.post(
                `https://aztro.sameerkumar.website/?sign=${sign}&day=today`,
                {},
                { timeout: 10000 }
            );

            if (response.data && response.data.description) {
                const data = {
                    sign: sign,
                    emoji: ZODIAC_EMOJIS[sign],
                    dates: ZODIAC_DATES[sign],
                    horoscope: response.data.description,
                    mood: response.data.mood,
                    luckyNumber: response.data.lucky_number,
                    luckyColor: response.data.color,
                    date: new Date().toLocaleDateString('en-IN', {
                        weekday: 'long',
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    })
                };

                const cacheKey = this._getCacheKey(sign);
                this._cache.set(cacheKey, { data, timestamp: Date.now() });
                return data;
            }

            throw new Error('Backup API failed');
        } catch (err) {
            logger.error(`Backup horoscope API error:`, err.message);
            return { error: 'api_error' };
        }
    }

    /**
     * Format horoscope message for WhatsApp
     */
    formatMessage(data) {
        if (data.error === 'invalid_sign') {
            return `❌ *Invalid zodiac sign!*\n\n` +
                `📜 *Valid signs:*\n` +
                ZODIAC_SIGNS.map(s => `  ${ZODIAC_EMOJIS[s]} ${s.charAt(0).toUpperCase() + s.slice(1)}`).join('\n') +
                `\n\n💡 *Usage:* \`/horo capricorn\` or \`/horo cap\``;
        }

        if (data.error === 'api_error') {
            return `⚠️ *Horoscope service temporarily unavailable*\n\nPlease try again in a few minutes.`;
        }

        let msg = `╔════════════════════════════╗\n`;
        msg += `║ ${data.emoji} *${data.sign.toUpperCase()}* ${data.emoji}\n`;
        msg += `╚════════════════════════════╝\n\n`;
        msg += `📅 *${data.date}*\n`;
        msg += `🗓️ _${data.dates}_\n\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `🔮 *Today's Horoscope:*\n\n`;
        msg += `${data.horoscope}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        // Add extra details if available from backup API
        if (data.mood) {
            msg += `\n😊 *Mood:* ${data.mood}`;
        }
        if (data.luckyNumber) {
            msg += `\n🔢 *Lucky Number:* ${data.luckyNumber}`;
        }
        if (data.luckyColor) {
            msg += `\n🎨 *Lucky Color:* ${data.luckyColor}`;
        }

        msg += `\n\n✨ _Have a wonderful day!_ ✨`;

        return msg;
    }

    /**
     * Get list of all zodiac signs formatted
     */
    getSignsList() {
        let msg = `🌟 *ZODIAC SIGNS* 🌟\n\n`;
        msg += `Choose your sign:\n\n`;
        
        for (const sign of ZODIAC_SIGNS) {
            const emoji = ZODIAC_EMOJIS[sign];
            const dates = ZODIAC_DATES[sign];
            const name = sign.charAt(0).toUpperCase() + sign.slice(1);
            msg += `${emoji} *${name}* — _${dates}_\n`;
        }
        
        msg += `\n💡 *Usage:* \`/horo <sign>\`\n`;
        msg += `📝 *Example:* \`/horo capricorn\` or \`/horo cap\``;
        
        return msg;
    }
}

export const horoscopeService = new HoroscopeService();
export default HoroscopeService;
