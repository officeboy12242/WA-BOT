/**
 * Auto-Delete Utility
 * Schedules bot messages for automatic deletion after a specified time
 */

import { logger } from './logger.js';
import { getSafeSendOptions } from './waMessage.js';

const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours default
const scheduledDeletes = [];

/**
 * Schedule a message for deletion
 * @param {object} sock - WhatsApp socket
 * @param {string} chatId - Chat ID
 * @param {object} messageKey - Message key from sent message
 * @param {number} delayMs - Delay in milliseconds (default 5 hours)
 */
export function scheduleAutoDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
    if (!sock || !chatId || !messageKey) return;
    
    const timer = setTimeout(async () => {
        try {
            await sock.sendMessage(chatId, { delete: messageKey });
            logger.info(`🗑️ Auto-deleted message in ${chatId}`);
        } catch (err) {
            // Silently fail - message might already be deleted or chat unavailable
        }
    }, delayMs);

    scheduledDeletes.push(timer);
    
    // Cleanup old timers periodically
    if (scheduledDeletes.length > 1000) {
        scheduledDeletes.splice(0, 500);
    }
}

/**
 * Helper to send a message and schedule it for auto-deletion
 * @param {object} sock - WhatsApp socket
 * @param {string} chatId - Chat ID
 * @param {object} content - Message content
 * @param {object} options - Send options (quoted, etc)
 * @param {number} deleteAfterMs - Delete after this many ms (default 5 hours)
 * @returns {Promise<object>} - Sent message info
 */
export async function sendAndDelete(sock, chatId, content, options = {}, deleteAfterMs = AUTO_DELETE_MS) {
    const sendOpts = options.quoted
        ? getSafeSendOptions(options.quoted, Object.fromEntries(
            Object.entries(options).filter(([key]) => key !== 'quoted'),
        ))
        : options;
    const sent = await sock.sendMessage(chatId, content, sendOpts);
    if (sent?.key) {
        scheduleAutoDelete(sock, chatId, sent.key, deleteAfterMs);
    }
    return sent;
}

/**
 * Clear all scheduled deletions (for shutdown)
 */
export function clearAllScheduledDeletes() {
    for (const timer of scheduledDeletes) {
        clearTimeout(timer);
    }
    scheduledDeletes.length = 0;
    logger.info('🗑️ Cleared all scheduled auto-deletes');
}

export const AUTO_DELETE_5_HOURS = AUTO_DELETE_MS;
export const AUTO_DELETE_1_HOUR = 60 * 60 * 1000;
export const AUTO_DELETE_30_MIN = 30 * 60 * 1000;
