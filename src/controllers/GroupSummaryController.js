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
        text += `🌙 _Only ${count} message(s) today — not enough for a full recap._\n`;
    }
    text += `\n🕐 _Sent at ${timeLabel} IST_`;
    return text;
}

class GroupSummaryController {
    /**
     * @param {import('../services/GroupChatLogService.js').default} chatLog
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {object} config
     */
    constructor(chatLog, groupManager, config = {}) {
        this.chatLog = chatLog;
        this.groupManager = groupManager;
        this.config = config;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.minMessages = Math.max(1, Number(config.GROUP_SUMMARY_MIN_MESSAGES) || 3);
        this.enabled = config.GROUP_SUMMARY_ENABLED !== false;
        this.timezone = config.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata';
        const { hour, minute } = parseSummaryTime(config.GROUP_SUMMARY_TIME);
        this.summaryHour = hour;
        this.summaryMinute = minute;
        this._sock = null;
    }

    setSock(sock) {
        this._sock = sock;
    }

    async postDailySummaries(sock = this._sock) {
        if (!this.enabled) {
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

        const dateStr = getRecapDateStrIST(Date.now(), this.summaryHour, this.summaryMinute);
        const dateLabel = formatDateLabelIST(dateStr);
        const timeLabel = `${String(this.summaryHour).padStart(2, '0')}:${String(this.summaryMinute).padStart(2, '0')}`;

        logger.info(`🗓️ Posting group day recap for ${groups.length} group(s)...`);

        let sent = 0;
        for (const group of groups) {
            try {
                const ok = await this.postSummaryForGroup(sock, group, dateStr, dateLabel, timeLabel);
                if (ok) {
                    sent++;
                }
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Group summary failed for ${group.group_id}: ${err.message}`);
            }
        }
        logger.info(`🗓️ Group day recap done: ${sent}/${groups.length} sent`);
    }

    async postSummaryForGroup(sock, group, dateStr, dateLabel, timeLabel) {
        const groupId = group.group_id;
        const groupName = group.group_name || groupId;
        const messages = await this.chatLog.getMessagesForDay(groupId, dateStr);

        if (messages.length < this.minMessages) {
            if (messages.length > 0) {
                await sock.sendMessage(groupId, {
                    text: formatQuietDay(groupName, dateLabel, messages.length, timeLabel),
                });
                await this.chatLog.purgeDay(groupId, dateStr);
                return true;
            }
            return false;
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
