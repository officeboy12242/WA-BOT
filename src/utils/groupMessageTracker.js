/**
 * Ring buffer of recent group message keys for admin bulk-delete.
 */

import { getTextFromWAMessage, resolveConversationChatId } from './waMessage.js';

const MAX_PER_GROUP = 500;

const DELETE_CMD_RE = /^\/(dellast|delall|del)\b/i;

class GroupMessageTracker {
    constructor() {
        /** @type {Map<string, Array<{ key: import('baileys').proto.IMessageKey, ts: number }>>} */
        this._groups = new Map();
    }

    _normalizeGroupId(chatId) {
        if (!chatId?.endsWith('@g.us')) {
            return '';
        }
        return resolveConversationChatId({ remoteJid: chatId }) || chatId;
    }

    _lookupKeys(chatId) {
        const keys = [];
        const add = (value) => {
            if (value && !keys.includes(value)) {
                keys.push(value);
            }
        };

        add(chatId);
        add(this._normalizeGroupId(chatId));
        add(resolveConversationChatId({ remoteJid: chatId }));

        return keys;
    }

    _getList(chatId) {
        for (const key of this._lookupKeys(chatId)) {
            const list = this._groups.get(key);
            if (list?.length) {
                return { storageKey: key, list };
            }
        }

        const storageKey = this._normalizeGroupId(chatId) || chatId;
        return { storageKey, list: this._groups.get(storageKey) || [] };
    }

    /**
     * @param {import('baileys').proto.IWebMessageInfo} msg
     */
    track(msg) {
        const chatId = this._normalizeGroupId(msg?.key?.remoteJid);
        if (!chatId || !msg.key?.id || !msg.message) {
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

        if (list.some((entry) => entry.key.id === msg.key.id)) {
            return;
        }

        list.push({
            key: {
                remoteJid: chatId,
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
        const { list } = this._getList(chatId);
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
        let list = [...this._getList(chatId).list];

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
        let list = [...this._getList(chatId).list];
        if (beforeMessageId) {
            const cut = list.findIndex((entry) => entry.key.id === beforeMessageId);
            if (cut >= 0) {
                list = list.slice(0, cut);
            }
        }
        return list.length;
    }

    count(chatId) {
        return this._getList(chatId).list.length;
    }

    /**
     * @param {string} chatId
     * @param {string[]} messageIds
     */
    removeByIds(chatId, messageIds) {
        const idSet = new Set(messageIds);
        const { storageKey, list } = this._getList(chatId);
        if (!list.length) {
            return;
        }
        this._groups.set(
            storageKey,
            list.filter((entry) => !idSet.has(entry.key.id)),
        );
    }
}

export const groupMessageTracker = new GroupMessageTracker();
