/**
 * Configuration
 * Centralized configuration management
 */

import dotenv from 'dotenv';

dotenv.config();

export const config = {
    WHATSAPP_CHAT_ID: process.env.WHATSAPP_CHAT_ID || '',
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 180, // seconds
    DB_FILE: 'posted_courses.db',
    OWNER_NUMBERS: process.env.OWNER_NUMBERS ? process.env.OWNER_NUMBERS.split(',').map(n => n.trim()) : [],
    STICKER_TARGET_GROUPS: process.env.STICKER_TARGET_GROUPS ? process.env.STICKER_TARGET_GROUPS.split(',').map(g => g.trim()) : [],
    STICKER_PACK_NAME: process.env.STICKER_PACK_NAME?.trim() || 'Course Bot 🤖',
    STICKER_PACK_AUTHOR: process.env.STICKER_PACK_AUTHOR?.trim() || ''
};
