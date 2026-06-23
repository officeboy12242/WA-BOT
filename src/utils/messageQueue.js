/**
 * Per-chat send queue (ported from WhatsAppBotMultiDevice).
 * Serializes sends per chat to avoid delivery races.
 */

import { logger } from './logger.js';

class MessageQueue {
    constructor() {
        /** @type {Map<string, Array<{ run: () => Promise<unknown>, resolve: Function, reject: Function, priority: number }>>} */
        this.queues = new Map();
        /** @type {Map<string, boolean>} */
        this.processing = new Map();
        this.messageDelayMs = 50;
        this._cleanupInterval = setInterval(() => this.cleanupEmptyQueues(), 5 * 60 * 1000);
    }

    cleanupEmptyQueues() {
        for (const [chatId, queue] of this.queues.entries()) {
            if (!queue.length) {
                this.queues.delete(chatId);
                this.processing.delete(chatId);
            }
        }
    }

    /**
     * @param {string} chatId
     * @param {() => Promise<unknown>} sendFunction
     * @param {number} [priority]
     * @returns {Promise<unknown>}
     */
    enqueue(chatId, sendFunction, priority = 1) {
        if (!chatId) {
            return sendFunction();
        }

        return new Promise((resolve, reject) => {
            if (!this.queues.has(chatId)) {
                this.queues.set(chatId, []);
            }
            const queue = this.queues.get(chatId);
            queue.push({ run: sendFunction, resolve, reject, priority });
            queue.sort((a, b) => a.priority - b.priority);

            if (!this.processing.get(chatId)) {
                void this.processQueue(chatId);
            }
        });
    }

    async processQueue(chatId) {
        if (this.processing.get(chatId)) return;
        this.processing.set(chatId, true);

        const queue = this.queues.get(chatId);
        while (queue?.length) {
            const item = queue.shift();
            if (!item) continue;
            try {
                const result = await item.run();
                item.resolve(result);
            } catch (err) {
                item.reject(err);
            }
            if (queue.length > 0) {
                await new Promise((r) => setTimeout(r, this.messageDelayMs));
            }
        }

        this.processing.set(chatId, false);
        if (!queue?.length) {
            this.queues.delete(chatId);
        }
    }

    destroy() {
        clearInterval(this._cleanupInterval);
        this.queues.clear();
        this.processing.clear();
    }
}

export const messageQueue = new MessageQueue();
