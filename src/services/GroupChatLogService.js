/**
 * Persist member messages per group/day for end-of-day recap.
 */

import { normalizeMessageContent, jidNormalizedUser } from 'baileys';
import { logger } from '../utils/logger.js';
import { getTextFromWAMessage, resolveConversationChatId } from '../utils/waMessage.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';

const REFRESH_MS = 5 * 60_000;

function normalizeGroupId(chatId) {
    if (!chatId?.endsWith('@g.us')) {
        return '';
    }
    const resolved = resolveConversationChatId({ remoteJid: chatId }) || chatId;
    return jidNormalizedUser(String(resolved).replace(/:\d+(?=@)/, '')) || resolved;
}

function describeMessageContent(message) {
    const content = normalizeMessageContent(message);
    if (!content) {
        return null;
    }

    const text = getTextFromWAMessage(message).trim();
    if (text.startsWith('/')) {
        return null;
    }

    if (content.stickerMessage) {
        return text ? `${text} [sticker]` : '[sticker]';
    }
    if (content.imageMessage) {
        return text || '[image]';
    }
    if (content.videoMessage) {
        return text || '[video]';
    }
    if (content.audioMessage || content.pttMessage) {
        return text || '[audio]';
    }
    if (content.documentMessage) {
        return text || '[document]';
    }
    if (content.pollCreationMessage || content.pollUpdateMessage) {
        return text || '[poll]';
    }
    if (content.reactionMessage) {
        return null;
    }

    return text || null;
}

class GroupChatLogService {
    /**
     * @param {import('mongodb').Db} mongoDb
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     */
    constructor(mongoDb, groupManager, config = {}) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.maxPerDay = Math.max(50, Number(config.GROUP_SUMMARY_MAX_MESSAGES) || 400);
        this.llmMaxMessages = Math.max(20, Number(config.GROUP_SUMMARY_LLM_MAX_MESSAGES) || 100);
        /** @type {Set<string>} */
        this._enabledGroups = new Set();
        this._refreshTimer = null;
        this.collection = null;
    }

    async init() {
        this.collection = this.mongoDb.collection('group_chat_log');
        await this.collection.createIndex(
            { group_id: 1, date: 1, message_id: 1 },
            { unique: true, name: 'group_chat_log_unique' }
        );
        await this.collection.createIndex(
            { created_at: 1 },
            { name: 'group_chat_log_ttl', expireAfterSeconds: 14 * 24 * 60 * 60 }
        );
        await this.refreshEnabledGroups();
        this._refreshTimer = setInterval(() => {
            void this.refreshEnabledGroups();
        }, REFRESH_MS);
        if (this._refreshTimer.unref) {
            this._refreshTimer.unref();
        }
        logger.info('Group chat log service ready');
    }

    stop() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }

    async refreshEnabledGroups() {
        if (!this.groupManager) {
            return;
        }
        const groups = await this.groupManager.getSummaryEnabledGroups();
        this._enabledGroups = new Set(
            groups.map((g) => normalizeGroupId(g.group_id)).filter(Boolean)
        );
    }

    isLoggingEnabled(groupId) {
        const normalized = normalizeGroupId(groupId);
        return Boolean(normalized && this._enabledGroups.has(normalized));
    }

    /**
     * @param {import('baileys').proto.IWebMessageInfo} msg
     * @param {string} senderJid
     * @param {string} chatId
     */
    async maybeLogMessage(msg, senderJid, chatId) {
        if (!this.collection || !this.isLoggingEnabled(chatId) || msg.key?.fromMe) {
            return;
        }

        const body = describeMessageContent(msg.message);
        if (!body) {
            return;
        }

        const storageGroupId = normalizeGroupId(chatId);
        if (!storageGroupId) {
            return;
        }

        const date = getTodayDateStrIST();
        const messageId = msg.key?.id;
        if (!messageId) {
            return;
        }

        const senderName = (msg.pushName || '').trim() || 'Member';
        const senderPhone = extractPhoneNumber(senderJid) || '';
        const ts = msg.messageTimestamp
            ? Number(msg.messageTimestamp) * 1000
            : Date.now();

        try {
            const count = await this.collection.countDocuments({ group_id: storageGroupId, date });
            if (count >= this.maxPerDay) {
                return;
            }

            await this.collection.updateOne(
                { group_id: storageGroupId, date, message_id: messageId },
                {
                    $setOnInsert: {
                        group_id: storageGroupId,
                        date,
                        message_id: messageId,
                        sender_name: senderName.slice(0, 64),
                        sender_phone: senderPhone.slice(0, 20),
                        text: body.slice(0, 500),
                        ts,
                        created_at: new Date(),
                    },
                },
                { upsert: true }
            );
        } catch (err) {
            if (err?.code !== 11000) {
                logger.debug(`Group chat log skip: ${err.message}`);
            }
        }
    }

    /**
     * @param {string} groupId
     * @param {string} dateStr
     */
    async getMessagesForDay(groupId, dateStr) {
        if (!this.collection) {
            return [];
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        return this.collection
            .find({ group_id: normalized, date: dateStr })
            .sort({ ts: 1 })
            .toArray();
    }

    async countMessagesForDay(groupId, dateStr) {
        if (!this.collection) {
            return 0;
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        return this.collection.countDocuments({ group_id: normalized, date: dateStr });
    }

    /**
     * @param {object[]} messages
     */
    computeStats(messages) {
        const senders = new Map();
        const hourCounts = new Array(24).fill(0);
        const hourFormatter = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            hour12: false,
        });

        for (const row of messages) {
            const name = row.sender_name || 'Member';
            senders.set(name, (senders.get(name) || 0) + 1);

            const hour = Number(hourFormatter.format(new Date(row.ts)));
            hourCounts[hour] += 1;
        }

        let busiestHour = 0;
        let busiestCount = 0;
        for (let h = 0; h < 24; h++) {
            if (hourCounts[h] > busiestCount) {
                busiestCount = hourCounts[h];
                busiestHour = h;
            }
        }

        let topSender = null;
        let topCount = 0;
        for (const [name, count] of senders) {
            if (count > topCount) {
                topCount = count;
                topSender = name;
            }
        }

        const formatHour = (h) => {
            const end = (h + 1) % 24;
            const fmt = (n) => {
                const period = n >= 12 ? 'PM' : 'AM';
                const hour12 = n % 12 || 12;
                return `${hour12} ${period}`;
            };
            return `${fmt(h)} – ${fmt(end)} IST`;
        };

        return {
            totalMessages: messages.length,
            uniqueMembers: senders.size,
            busiestHourLabel: busiestCount > 0 ? formatHour(busiestHour) : null,
            topSender: topSender ? { name: topSender, count: topCount } : null,
        };
    }

    buildPrompt(messages, groupName, dateLabel) {
        const maxLines = this.llmMaxMessages;
        let sampled = messages;
        if (messages.length > maxLines) {
            sampled = [];
            for (let i = 0; i < maxLines; i++) {
                const idx = Math.floor((i * messages.length) / maxLines);
                sampled.push(messages[idx]);
            }
        }

        const lines = sampled.map((row) => {
            const time = new Date(row.ts).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Kolkata',
            });
            const text = String(row.text || '').slice(0, 180);
            return `[${time}] ${row.sender_name}: ${text}`;
        });

        const sampledNote = messages.length > maxLines
            ? `\n(Showing ${maxLines} of ${messages.length} messages — evenly sampled.)`
            : '';

        let body = [
            `Group: ${groupName}`,
            `Date: ${dateLabel}`,
            `Messages (${messages.length}):${sampledNote}`,
            lines.join('\n'),
        ].join('\n\n');

        const maxChars = 12_000;
        if (body.length > maxChars) {
            body = `${body.slice(0, maxChars)}\n\n[...truncated...]`;
        }

        return body;
    }

    async purgeDay(groupId, dateStr) {
        if (!this.collection) {
            return;
        }
        const normalized = normalizeGroupId(groupId) || groupId;
        await this.collection.deleteMany({ group_id: normalized, date: dateStr });
    }
}

export default GroupChatLogService;
