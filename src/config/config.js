/**
 * Configuration
 * Centralized configuration management
 */

import dotenv from 'dotenv';

dotenv.config();

function parsePhoneList(value) {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map((n) => n.trim().replace(/^\+/, '').replace(/\s/g, ''))
        .filter(Boolean);
}

export const config = {
    WHATSAPP_CHAT_ID: process.env.WHATSAPP_CHAT_ID || '',
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 180, // seconds
    NEWS_POST_TIMES: (process.env.NEWS_POST_TIMES || '10:00,22:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    NEWS_TIMEZONE: process.env.NEWS_TIMEZONE || 'Asia/Kolkata',
    NEWS_SCRAPE_INTERVAL: parseInt(process.env.NEWS_SCRAPE_INTERVAL) || 1800, // seconds — queue only, no post
    NEWS_MIN_ARTICLES: parseInt(process.env.NEWS_MIN_ARTICLES) || 10,
    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'telegramUdemy',
    OWNER_NUMBERS: parsePhoneList(process.env.OWNER_NUMBERS),
    MODERATOR_NUMBERS: parsePhoneList(process.env.MODERATOR_NUMBERS),
    MORNING_MESSAGES_ENABLED: process.env.MORNING_MESSAGES_ENABLED !== 'false',
    MORNING_MESSAGE_NUMBERS: parsePhoneList(process.env.MORNING_MESSAGE_NUMBERS),
    MORNING_MESSAGE_TIME_START: (
        process.env.MORNING_MESSAGE_TIME_START ||
        process.env.MORNING_MESSAGE_TIME ||
        '08:00'
    ).trim(),
    MORNING_MESSAGE_TIME_END: (process.env.MORNING_MESSAGE_TIME_END || '10:30').trim(),
    MORNING_TIMEZONE: process.env.MORNING_TIMEZONE || 'Asia/Kolkata',
    STICKER_TARGET_GROUPS: process.env.STICKER_TARGET_GROUPS
        ? process.env.STICKER_TARGET_GROUPS.split(',').map((g) => g.trim()).filter(Boolean)
        : [],
    STICKER_SOURCE_CHANNELS: process.env.STICKER_SOURCE_CHANNELS
        ? process.env.STICKER_SOURCE_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean)
        : [],
    STICKER_PACK_NAME: process.env.STICKER_PACK_NAME?.trim() || '',
    STICKER_PACK_AUTHOR: process.env.STICKER_PACK_AUTHOR?.trim() || '',
    TMDB_API_KEY: process.env.TMDB_API_KEY?.trim() || '',
    BOT_LOG_NUMBER: process.env.BOT_LOG_NUMBER?.trim() || '917887499710',
};
