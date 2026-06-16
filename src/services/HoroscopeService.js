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

const LUCKY_COLORS = [
    'Red', 'Blue', 'Green', 'Gold', 'Purple', 'Orange',
    'Pink', 'Yellow', 'Teal', 'Silver', 'Dark Green', 'Coral',
];

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

    _formatDate() {
        return new Date().toLocaleDateString('en-IN', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    }

    /**
     * Deterministic daily luck when extras API is unavailable
     */
    _generateDailyLuck(sign) {
        const today = new Date().toISOString().split('T')[0];
        const seed = `${sign}_${today}`;
        let hash = 0;

        for (let i = 0; i < seed.length; i++) {
            hash = ((hash << 5) - hash) + seed.charCodeAt(i);
            hash |= 0;
        }

        const abs = Math.abs(hash);
        return {
            luckyNumber: (abs % 99) + 1,
            luckyColor: LUCKY_COLORS[abs % LUCKY_COLORS.length],
            mood: ['Optimistic', 'Focused', 'Calm', 'Energetic', 'Reflective'][abs % 5],
            compatibility: ZODIAC_SIGNS[(abs + 3) % ZODIAC_SIGNS.length],
        };
    }

    async _fetchOhmanda(sign) {
        const response = await axios.get(
            `https://ohmanda.com/api/horoscope/${sign}/`,
            { timeout: 10000 }
        );

        if (!response.data?.horoscope) {
            throw new Error('Invalid Ohmanda response');
        }

        return response.data.horoscope.trim();
    }

    async _fetchVedikaExtras(sign) {
        const response = await axios.get(
            'https://api.vedika.io/sandbox/horoscope/daily',
            { params: { sign }, timeout: 10000 }
        );

        const data = response.data?.data;
        if (!data) {
            throw new Error('Invalid Vedika response');
        }

        return {
            horoscope: data.prediction?.trim() || '',
            luckyNumber: data.lucky_number,
            luckyColor: data.lucky_color,
            mood: data.mood,
            compatibility: data.compatibility,
        };
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

        const [ohmandaResult, vedikaResult] = await Promise.allSettled([
            this._fetchOhmanda(normalizedSign),
            this._fetchVedikaExtras(normalizedSign),
        ]);

        const horoscopeText = ohmandaResult.status === 'fulfilled'
            ? ohmandaResult.value
            : (vedikaResult.status === 'fulfilled' ? vedikaResult.value.horoscope : '');

        if (!horoscopeText) {
            logger.error(`Horoscope API error for ${normalizedSign}: all sources failed`);
            return { error: 'api_error' };
        }

        const extras = vedikaResult.status === 'fulfilled'
            ? vedikaResult.value
            : this._generateDailyLuck(normalizedSign);

        const data = {
            sign: normalizedSign,
            emoji: ZODIAC_EMOJIS[normalizedSign],
            dates: ZODIAC_DATES[normalizedSign],
            horoscope: horoscopeText,
            mood: extras.mood,
            luckyNumber: extras.luckyNumber,
            luckyColor: extras.luckyColor,
            compatibility: extras.compatibility,
            date: this._formatDate(),
        };

        this._cache.set(cacheKey, { data, timestamp: Date.now() });
        logger.info(`Fetched horoscope for ${normalizedSign}`);
        return data;
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
        msg += `\n🍀 *Today's Luck*\n`;
        msg += `🔢 *Lucky Number:* ${data.luckyNumber ?? '—'}\n`;
        msg += `🎨 *Lucky Color:* ${data.luckyColor ?? '—'}`;

        if (data.mood) {
            msg += `\n😊 *Mood:* ${data.mood}`;
        }
        if (data.compatibility) {
            const compat = String(data.compatibility).trim();
            const compatEmoji = ZODIAC_EMOJIS[compat.toLowerCase()] || '💫';
            msg += `\n💞 *Best Match:* ${compatEmoji} ${compat}`;
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
