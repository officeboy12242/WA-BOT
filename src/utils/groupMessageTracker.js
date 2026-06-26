/**
 * Ring buffer of recent group message keys for admin bulk-delete.
 */

import { getTextFromWAMessage } from './waMessage.js';

const MAX_PER_GROUP = 500;

const DELETE_CMD_RE = /^\/(dellast|delall|del)\b/i;

class GroupMessageTracker {
    constructor() {
        /** @type {Map<string, Array<{ key: import('baileys').proto.IMessageKey, ts: number }>>} */
        this._groups = new Map();
    }

    /**
     * @param {import('baileys').proto.IWebMessageInfo} msg
     */
    track(msg) {
        const chatId = msg?.key?.remoteJid;
        if (!chatId?.endsWith('@g.us') || !msg.key?.id || !msg.message) {
            return;
        }

        const text = getTextFromWAMessage(msg.message).trim();
        if (DELETE_CMD_RE.test(text)) {
            return;
        }

        let list = this._groups.get(chatId);
        if (!list) {
            list = [];
            this._groups.set(chatId, list);
        }

        list.push({
            key: {
                remoteJid: msg.key.remoteJid,
                id: msg.key.id,
                fromMe: Boolean(msg.key.fromMe),
                ...(msg.key.participant ? { participant: msg.key.participant } : {}),
                ...(msg.key.participantLid ? { participantLid: msg.key.participantLid } : {}),
            },
            ts: Date.now(),
        });

        if (list.length > MAX_PER_GROUP) {
            list.splice(0, list.length - MAX_PER_GROUP);
        }
    }

    /**
     * @param {string} chatId
     * @param {number} count
     * @returns {Array<{ key: import('baileys').proto.IMessageKey, ts: number }>}
     */
    getLast(chatId, count) {
        const list = this._groups.get(chatId) || [];
        if (!count || count >= list.length) {
            return [...list];
        }
        return list.slice(-count);
    }

    /**
     * Messages eligible for bulk delete: only tracked entries strictly before the
     * admin command, optionally limited to the oldest N (backlog cleanup).
     *
     * @param {string} chatId
     * @param {number} count
     * @param {string} [beforeMessageId] — exclude this message and anything after it
     * @returns {Array<{ key: import('baileys').proto.IMessageKey, ts: number }>}
     */
    getOldestBefore(chatId, count, beforeMessageId) {
        let list = this._groups.get(chatId) || [];

        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }

        if (!list.length) {
            return [];
        }

        if (!count || count >= list.length) {
            return [...list];
        }

        return list.slice(0, count);
    }

    /**
     * @param {string} chatId
     * @param {string} [beforeMessageId]
     * @returns {number}
     */
    countBefore(chatId, beforeMessageId) {
        let list = this._groups.get(chatId) || [];
        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }
        return list.length;
    }

    count(chatId) {
        return (this._groups.get(chatId) || []).length;
    }

    /**
     * @param {string} chatId
     * @param {string[]} messageIds
     */
    removeByIds(chatId, messageIds) {
        const idSet = new Set(messageIds);
        const list = this._groups.get(chatId);
        if (!list?.length) {
            return;
        }
        this._groups.set(
            chatId,
            list.filter((entry) => !idSet.has(entry.key.id)),
        );
    }
}

export const groupMessageTracker = new GroupMessageTracker();
