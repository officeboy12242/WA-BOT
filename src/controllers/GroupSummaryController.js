/**
 * Daily end-of-day group chat recap for /summaryon groups.
 */

import { logger } from '../utils/logger.js';
import { formatDateLabelIST, getRecapDateStrIST } from '../utils/dateIST.js';
import NvidiaDeepSeekService from '../services/NvidiaDeepSeekService.js';

function parseSummaryTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '00:00').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

function currentIstHour() {
    const parts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: 'numeric',
        hour12: false,
    }).formatToParts(new Date());
    let hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    if (hour === 24) {
        hour = 0;
    }
    return hour;
}

function formatRecapMessage({ groupName, dateLabel, stats, summary, timeLabel }) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  🗓️ *GROUP DAY RECAP* 🗓️  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${dateLabel}*\n`;
    text += `📢 *${groupName}*\n`;
    text += '─────────────────────────────\n\n';

    text += '📊 *Day at a glance*\n';
    text += `• 💬 ${stats.totalMessages} message(s) from ${stats.uniqueMembers} member(s)\n`;
    if (stats.busiestHourLabel) {
        text += `• 🔥 Busiest hour: ${stats.busiestHourLabel}\n`;
    }
    text += '\n─────────────────────────────\n\n';

    const topics = Array.isArray(summary?.topics) ? summary.topics : [];
    if (topics.length) {
        text += '🧵 *Topics discussed*\n\n';
        topics.slice(0, 6).forEach((topic, i) => {
            const emoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'][i] || `${i + 1}.`;
            const title = topic?.title || 'Discussion';
            const detail = topic?.detail || '';
            text += `${emoji} *${title}*\n`;
            if (detail) {
                text += `   ${detail}\n`;
            }
            text += '\n';
        });
        text += '─────────────────────────────\n\n';
    }

    const notable = Array.isArray(summary?.notable) ? summary.notable.filter(Boolean) : [];
    if (notable.length) {
        text += '⭐ *Notable moments*\n';
        for (const line of notable.slice(0, 4)) {
            text += `• ${line}\n`;
        }
        text += '\n─────────────────────────────\n\n';
    }

    if (stats.topSender) {
        text += `🏆 *Most active:* ${stats.topSender.name} (${stats.topSender.count} msgs)\n\n`;
        text += '─────────────────────────────\n\n';
    }

    const wrapUp = summary?.wrap_up?.trim();
    if (wrapUp) {
        text += '📝 *In short*\n';
        text += `${wrapUp}\n\n`;
        text += '─────────────────────────────\n';
    }

    text += `🕐 _Sent at ${timeLabel} IST_`;
    return text;
}

function formatQuietDay(groupName, dateLabel, count, timeLabel) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  🗓️ *GROUP DAY RECAP* 🗓️  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${dateLabel}*\n`;
    text += `📢 *${groupName}*\n`;
    text += '─────────────────────────────\n\n';
    if (count === 0) {
        text += '🌙 _Quiet day — no member messages logged._\n';
    } else {
        text += `🌙 _Only ${count} message(s) that day — not enough for a full recap._\n`;
    }
    text += `\n🕐 _Sent at ${timeLabel} IST_`;
    return text;
}

class GroupSummaryController {
    /**
     * @param {import('../services/GroupChatLogService.js').default} chatLog
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     * @param {import('mongodb').Db} [mongoDb]
     */
    constructor(chatLog, groupManager, config = {}, mongoDb = null) {
        this.chatLog = chatLog;
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.minMessages = Math.max(1, Number(config.GROUP_SUMMARY_MIN_MESSAGES) || 3);
        this.enabled = config.GROUP_SUMMARY_ENABLED !== false;
        this.timezone = config.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata';
        const { hour, minute } = parseSummaryTime(config.GROUP_SUMMARY_TIME);
        this.summaryHour = hour;
        this.summaryMinute = minute;
        this._sock = null;
        this._sentCollection = null;
    }

    async init() {
        if (!this.mongoDb) {
            return;
        }
        this._sentCollection = this.mongoDb.collection('group_summary_sent');
        await this._sentCollection.createIndex(
            { group_id: 1, recap_date: 1 },
            { unique: true, name: 'group_summary_sent_unique' }
        );
    }

    setSock(sock) {
        this._sock = sock;
    }

    async wasRecapSent(groupId, dateStr) {
        if (!this._sentCollection) {
            return false;
        }
        const row = await this._sentCollection.findOne({ group_id: groupId, recap_date: dateStr });
        return Boolean(row);
    }

    async markRecapSent(groupId, dateStr) {
        if (!this._sentCollection) {
            return;
        }
        await this._sentCollection.updateOne(
            { group_id: groupId, recap_date: dateStr },
            { $set: { sent_at: new Date() } },
            { upsert: true }
        );
    }

    /** Morning catch-up if bot missed the midnight run (restart/deploy). */
    async runCatchUpIfNeeded(sock = this._sock) {
        if (!this.enabled || !sock || !this.nvidia.isConfigured()) {
            return;
        }

        const istHour = currentIstHour();
        if (istHour >= 12) {
            return;
        }

        const dateStr = getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const groups = await this.groupManager.getSummaryEnabledGroups();
        if (!groups.length) {
            return;
        }

        let pending = 0;
        for (const group of groups) {
            if (!(await this.wasRecapSent(group.group_id, dateStr))) {
                pending++;
            }
        }
        if (!pending) {
            return;
        }

        logger.info(`🗓️ Catch-up recap for ${pending} group(s) (missed midnight) — date ${dateStr}`);
        await this.postDailySummaries(sock, { dateStr, skipSentCheck: false });
    }

    async postRecapForGroup(sock, groupId, { dateStr = null, force = false } = {}) {
        if (!this.enabled || !sock) {
            throw new Error('Recap service not ready');
        }
        if (!this.nvidia.isConfigured()) {
            throw new Error('NVIDIA_API_KEY is not set on the server');
        }

        const groups = await this.groupManager.getSummaryEnabledGroups();
        const group = groups.find((g) => g.group_id === groupId);
        if (!group) {
            throw new Error('Group recap is not enabled here');
        }

        const recapDate = dateStr || getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const dateLabel = formatDateLabelIST(recapDate);
        const timeLabel = `${String(this.summaryHour).padStart(2, '0')}:${String(this.summaryMinute).padStart(2, '0')}`;

        const ok = await this.postSummaryForGroup(
            sock,
            group,
            recapDate,
            dateLabel,
            timeLabel,
            { force }
        );
        if (ok) {
            await this.markRecapSent(group.group_id, recapDate);
        }
        return ok;
    }

    async postDailySummaries(sock = this._sock, { dateStr = null, skipSentCheck = false, force = false } = {}) {
        if (!this.enabled) {
            logger.warn('Group summary: disabled (GROUP_SUMMARY_ENABLED=false)');
            return;
        }
        if (!sock) {
            logger.warn('Group summary: no socket, skipping');
            return;
        }
        if (!this.nvidia.isConfigured()) {
            logger.warn('Group summary: NVIDIA_API_KEY missing, skipping');
            return;
        }

        const groups = await this.groupManager.getSummaryEnabledGroups();
        if (!groups.length) {
            logger.info('Group summary: no /summaryon groups');
            return;
        }

        const recapDate = dateStr || getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const dateLabel = formatDateLabelIST(recapDate);
        const timeLabel = `${String(this.summaryHour).padStart(2, '0')}:${String(this.summaryMinute).padStart(2, '0')}`;

        logger.info(`🗓️ Posting group day recap for ${groups.length} group(s) — date ${recapDate}...`);

        let sent = 0;
        let skipped = 0;
        for (const group of groups) {
            try {
                if (!skipSentCheck && !force && (await this.wasRecapSent(group.group_id, recapDate))) {
                    skipped++;
                    continue;
                }

                const ok = await this.postSummaryForGroup(
                    sock,
                    group,
                    recapDate,
                    dateLabel,
                    timeLabel,
                    { force }
                );
                if (ok) {
                    sent++;
                    await this.markRecapSent(group.group_id, recapDate);
                } else {
                    skipped++;
                }
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Group summary failed for ${group.group_id}: ${err.message}`);
            }
        }
        logger.info(`🗓️ Group day recap done: ${sent} sent, ${skipped} skipped, ${groups.length} total`);
    }

    async postSummaryForGroup(sock, group, dateStr, dateLabel, timeLabel, { force = false } = {}) {
        const groupId = group.group_id;
        const groupName = group.group_name || groupId;
        const messages = await this.chatLog.getMessagesForDay(groupId, dateStr);

        if (messages.length === 0) {
            logger.warn(
                `Group summary: 0 logged messages for ${groupName} on ${dateStr} ` +
                    '(need /summaryon before chat + member messages that day)'
            );
            if (force) {
                await sock.sendMessage(groupId, {
                    text: formatQuietDay(groupName, dateLabel, 0, timeLabel),
                });
                return true;
            }
            return false;
        }

        if (messages.length < this.minMessages) {
            logger.info(`Group summary: ${groupName} only ${messages.length} msg(s) on ${dateStr} (min ${this.minMessages})`);
            await sock.sendMessage(groupId, {
                text: formatQuietDay(groupName, dateLabel, messages.length, timeLabel),
            });
            await this.chatLog.purgeDay(groupId, dateStr);
            return true;
        }

        const stats = this.chatLog.computeStats(messages);
        const prompt = this.chatLog.buildPrompt(messages, groupName, dateLabel);
        const summary = await this.nvidia.summarizeGroupChat(prompt);
        const text = formatRecapMessage({
            groupName,
            dateLabel,
            stats,
            summary,
            timeLabel,
        });

        await sock.sendMessage(groupId, { text });
        await this.chatLog.purgeDay(groupId, dateStr);
        logger.info(`✅ Group recap sent to ${groupName} (${messages.length} msgs)`);
        return true;
    }
}

export default GroupSummaryController;
