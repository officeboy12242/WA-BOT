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
        // Raised from 100: the summary LLM used to get at most ~60 sampled lines
        // for a 150-message day AND the call layer sliced the prompt at 5000
        // chars, so the model saw less than half the conversation — recaps came
        // out "half and not to the points". The sample now fits the ~14k-char
        // first attempt in NvidiaDeepSeekService.completeWithSummaryRetry.
        this.llmMaxMessages = Math.max(20, Number(config.GROUP_SUMMARY_LLM_MAX_MESSAGES) || 140);
        this.chunkThreshold = Math.max(80, Number(config.GROUP_SUMMARY_CHUNK_THRESHOLD) || 150);
        this.chunkSize = Math.max(30, Math.min(60, Number(config.GROUP_SUMMARY_CHUNK_SIZE) || 50));
        this.narrative = config.GROUP_SUMMARY_NARRATIVE !== false;
        /** @type {Set<string>} */
        this._enabledGroups = new Set();
        /** @type {Map<string, number>} in-memory daily counts — avoid countDocuments on every msg */
        this._dayCounts = new Map();
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
            const countKey = `${storageGroupId}|${date}`;
            let count = this._dayCounts.get(countKey);
            if (count === undefined) {
                count = await this.collection.countDocuments({ group_id: storageGroupId, date });
                this._dayCounts.set(countKey, count);
                // Bound memory — drop oldest keys if map grows
                if (this._dayCounts.size > 200) {
                    const first = this._dayCounts.keys().next().value;
                    if (first !== undefined) this._dayCounts.delete(first);
                }
            }
            if (count >= this.maxPerDay) {
                return;
            }

            const result = await this.collection.updateOne(
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
            if (result.upsertedCount) {
                this._dayCounts.set(countKey, count + 1);
            }
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
        const senders = new Map(); // Map<sender_phone, { name: string, count: number }>
        const hourCounts = new Array(24).fill(0);
        const hourFormatter = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            hour12: false,
        });

        for (const row of messages) {
            const name = row.sender_name || 'Member';
            const phone = row.sender_phone;

            if (phone) {
                const senderStats = senders.get(phone) || { name: name, count: 0 };
                senderStats.count++;
                // Ensure the name is updated in case it changed or was initially 'Member'
                senderStats.name = name;
                senders.set(phone, senderStats);
            }

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

    /** Scale down LLM input for busier days to avoid API timeouts. */
    getLlmSampleLimit(totalMessages) {
        if (totalMessages <= 80) {
            return Math.min(this.llmMaxMessages, totalMessages);
        }
        if (totalMessages <= 150) {
            return Math.min(120, this.llmMaxMessages);
        }
        if (totalMessages <= 250) {
            return Math.min(90, this.llmMaxMessages);
        }
        // Very busy days: one compact sample beats many sequential chunk calls
        return Math.min(70, this.llmMaxMessages);
    }

    /** Keep conversation edges plus evenly spaced middle messages. */
    sampleMessages(messages, maxLines) {
        if (messages.length <= maxLines) {
            return messages;
        }

        const picked = [];
        const used = new Set();

        const addAt = (idx) => {
            if (idx < 0 || idx >= messages.length || used.has(idx)) {
                return;
            }
            used.add(idx);
            picked.push(messages[idx]);
        };

        for (let i = 0; i < Math.min(4, messages.length); i++) {
            addAt(i);
        }
        for (let i = Math.max(0, messages.length - 4); i < messages.length; i++) {
            addAt(i);
        }

        const slots = maxLines - picked.length;
        for (let i = 0; i < slots; i++) {
            const idx = Math.floor(((i + 0.5) * messages.length) / slots);
            addAt(idx);
        }

        return picked.sort((a, b) => a.ts - b.ts);
    }

    formatMessageLines(messages, textLimit = 120) {
        return messages.map((row) => {
            const time = new Date(row.ts).toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Kolkata',
            });
            const text = String(row.text || '').slice(0, textLimit);
            return `[${time}] ${row.sender_name}: ${text}`;
        });
    }

    buildPrompt(messages, groupName, dateLabel) {
        const maxLines = this.getLlmSampleLimit(messages.length);
        const textLimit = messages.length > 150 ? 80 : messages.length > 80 ? 100 : 140;
        const sampled = this.sampleMessages(messages, maxLines);
        const lines = this.formatMessageLines(sampled, textLimit);

        const sampledNote = messages.length > maxLines
            ? `\n(Showing ${sampled.length} of ${messages.length} messages — sampled for recap.)`
            : '';

        const narrativeLines = this.narrative
            ? [
                  'Below is the actual member conversation for the day (name: message).',
                  'Summarize what people actually discussed — themes, who said what, questions, opinions, decisions — not just that chatting happened.',
                  'Extract 3-5 topics with detail on what was discussed and by whom.',
              ]
            : ['Extract 3-5 concrete topics with short details from the chat lines below.'];

        const body = [
            `Group: ${groupName}`,
            `Date: ${dateLabel}`,
            `Messages (${messages.length}):${sampledNote}`,
            ...narrativeLines,
            lines.join('\n'),
        ].join('\n\n');

        return body;
    }

    /**
     * Split a busy day into at most 3 compact LLM prompts (map-reduce).
     * Samples within each time window so chunks stay small and reliable.
     * @returns {string[]}
     */
    buildChunkPrompts(messages, groupName, dateLabel) {
        const total = messages.length;
        const maxParts = 3;
        const partSize = Math.ceil(total / maxParts);
        const prompts = [];
        const textLimit = 70;
        const perChunkSample = 28;

        for (let part = 0; part < maxParts; part++) {
            const start = part * partSize;
            if (start >= total) break;
            const chunk = messages.slice(start, start + partSize);
            const sampled = this.sampleMessages(chunk, perChunkSample);
            const lines = this.formatMessageLines(sampled, textLimit);
            const parts = Math.min(maxParts, Math.ceil(total / partSize));

            let body = [
                `Group: ${groupName}`,
                `Date: ${dateLabel}`,
                `Part ${part + 1} of ${parts} (sample of ${sampled.length} from ${chunk.length} msgs; day total ${total})`,
                'Below is the actual member conversation for this part of the day (name: message).',
                'Summarize what people actually discussed — themes, who said what, questions, opinions, decisions — not just that chatting happened.',
                'List 2-4 topics from this part only (JSON topics/notable/wrap_up).',
                lines.join('\n'),
            ].join('\n\n');

            if (body.length > 3500) {
                body = `${body.slice(0, 3500)}\n\n[...truncated...]`;
            }
            prompts.push(body);
        }

        return prompts;
    }

    /**
     * Prefer a single compact sample for most days.
     * Chunk only for very busy days where one sample would be too thin.
     */
    shouldUseChunkedSummary(messages) {
        return messages.length >= Math.max(this.chunkThreshold, 220);
    }

    /**
     * Offline topics when the LLM times out — still useful for the group.
     * @returns {{ topics: object[], notable: string[], wrap_up: string }}
     */
    buildHeuristicSummary(messages, stats) {
        const hourBuckets = new Map();
        for (const row of messages) {
            const hour = new Date(row.ts).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                hour: 'numeric',
                hour12: false,
            });
            const h = Number(hour) === 24 ? 0 : Number(hour);
            if (!hourBuckets.has(h)) hourBuckets.set(h, []);
            hourBuckets.get(h).push(row);
        }

        const rankedHours = [...hourBuckets.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 4);

        const topics = rankedHours.map(([hour, rows], idx) => {
            const sample = rows
                .filter((r) => r.text && !/^\[/.test(r.text))
                .slice(0, 3)
                .map((r) => String(r.text).slice(0, 60))
                .filter(Boolean);
            const period = hour >= 12 ? 'PM' : 'AM';
            const hour12 = hour % 12 || 12;
            const title = idx === 0
                ? `Busy chat around ${hour12} ${period}`
                : `Chat around ${hour12} ${period}`;
            const detail = sample.length
                ? `Members talked about: ${sample.join(' · ')}`
                : `${rows.length} messages in this hour.`;
            return { title, detail };
        });

        if (!topics.length) {
            topics.push({
                title: 'Group activity',
                detail: `${stats.totalMessages} messages from ${stats.uniqueMembers} members.`,
            });
        }

        const notable = [];
        if (stats.topSender) {
            notable.push(`${stats.topSender.name} was most active (${stats.topSender.count} msgs)`);
        }
        if (stats.busiestHourLabel) {
            notable.push(`Busiest hour: ${stats.busiestHourLabel}`);
        }

        const wrap_up =
            `Active day with ${stats.totalMessages} messages from ${stats.uniqueMembers} members` +
            `${stats.busiestHourLabel ? `, peaking around ${stats.busiestHourLabel}` : ''}.` +
            (stats.topSender ? ` ${stats.topSender.name} led the chat.` : '');

        return { topics, notable, wrap_up };
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
