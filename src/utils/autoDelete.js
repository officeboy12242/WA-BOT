/**
 * Auto-Delete Utility
 * Schedules bot messages for automatic deletion after a specified time
 * Uses BullMQ for persistence (survives bot restarts) or falls back to in-memory
 */

import { logger } from './logger.js';
import queueService from '../services/QueueService.js';

const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours default
const scheduledDeletes = [];

let sock = null;
let deleteQueueInitialized = false;

/**
 * Initialize the delete queue (call once after sock is ready)
 */
export async function initializeDeleteQueue(socketInstance) {
    sock = socketInstance;
    
    if (deleteQueueInitialized) return;

    // Create delete queue with processor
    queueService.createQueue('message-delete', async (job) => {
        const { chatId, messageKey } = job.data;
        if (!sock) {
            throw new Error('Socket not available for deletion');
        }
        try {
            await sock.sendMessage(chatId, { delete: messageKey });
            logger.info(`🗑️ Auto-deleted message in ${chatId}`);
        } catch (err) {
            // Don't retry - message might already be deleted
            logger.debug(`Delete skipped (may already be deleted): ${err.message}`);
        }
    }, {
        concurrency: 2,
        limiter: { max: 5, duration: 1000 },
    });

    deleteQueueInitialized = true;
    logger.info('📦 Auto-delete queue initialized');
}

/**
 * Schedule a message for deletion
 * @param {object} sockInstance - WhatsApp socket (used for fallback)
 * @param {string} chatId - Chat ID
 * @param {object} messageKey - Message key from sent message
 * @param {number} delayMs - Delay in milliseconds (default 5 hours)
 */
export async function scheduleAutoDelete(sockInstance, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
    if (!chatId || !messageKey) return;
    
    // Update sock reference
    if (sockInstance) sock = sockInstance;

    try {
        // Use BullMQ delayed job for persistence
        await queueService.addJob('message-delete', { chatId, messageKey }, {
            delay: delayMs,
            attempts: 1, // Don't retry deletions
            removeOnComplete: true,
            removeOnFail: true,
        });
    } catch (err) {
        // Fallback to in-memory timer
        const timer = setTimeout(async () => {
            try {
                if (sock) {
                    await sock.sendMessage(chatId, { delete: messageKey });
                    logger.info(`🗑️ Auto-deleted message in ${chatId}`);
                }
            } catch (e) {
                // Silently fail
            }
        }, delayMs);
        scheduledDeletes.push(timer);
        
        if (scheduledDeletes.length > 1000) {
            scheduledDeletes.splice(0, 500);
        }
    }
}

/**
 * Helper to send a message and schedule it for auto-deletion
 * @param {object} sockInstance - WhatsApp socket
 * @param {string} chatId - Chat ID
 * @param {object} content - Message content
 * @param {object} options - Send options (quoted, etc)
 * @param {number} deleteAfterMs - Delete after this many ms (default 5 hours)
 * @returns {Promise<object>} - Sent message info
 */
export async function sendAndDelete(sockInstance, chatId, content, options = {}, deleteAfterMs = AUTO_DELETE_MS) {
    const sent = await sockInstance.sendMessage(chatId, content, options);
    if (sent?.key) {
        await scheduleAutoDelete(sockInstance, chatId, sent.key, deleteAfterMs);
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
    logger.info('🗑️ Cleared all in-memory scheduled auto-deletes');
}

export const AUTO_DELETE_5_HOURS = AUTO_DELETE_MS;
export const AUTO_DELETE_1_HOUR = 60 * 60 * 1000;
export const AUTO_DELETE_30_MIN = 30 * 60 * 1000;
