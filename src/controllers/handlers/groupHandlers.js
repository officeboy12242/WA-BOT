/**
 * Group handlers: activate, deactivate, instaon, instaoff, groups, setwc, welcome event
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { scheduleAutoDelete, AUTO_DELETE_2_MIN } from '../../utils/autoDelete.js';
import {
    DEFAULT_HEADER_TEMPLATE,
    formatWelcomeStatus,
    isValidParticipantJid,
    normalizeCustomWelcomePart,
    normalizeParticipantEntry,
    previewWelcomeMessage,
    renderWelcomeMessage,
} from '../../utils/welcomeMessage.js';
import {
    dedupeParticipantRecords,
    groupParticipantSnapshot,
} from '../../utils/groupParticipantSnapshot.js';

/** Dedupe welcome when both stub message + participants.update fire */
const recentWelcomes = new Map();
const WELCOME_DEDUPE_MS = 45_000;
const WELCOME_JOIN_DELAY_MS = 2500;

/** WhatsApp stub types that indicate someone joined */
const JOIN_STUB_TYPES = new Set([
    27, // GROUP_PARTICIPANT_ADD
    31, // GROUP_PARTICIPANT_INVITE
    32, // GROUP_PARTICIPANT_ADD_REQUEST
    172, // GROUP_MEMBERSHIP_JOIN_APPROVAL
]);

const JOIN_ACTIONS = new Set(['add', 'linked', 'invite']);

/** WhatsApp stub types for leave/remove — never welcome these */
const LEAVE_STUB_TYPES = new Set([
    28, // GROUP_PARTICIPANT_REMOVE
    29, // GROUP_PARTICIPANT_LEAVE
]);

const LEAVE_ACTIONS = new Set(['remove', 'leave', 'left']);

/** @type {Map<string, { timer: NodeJS.Timeout, baseline: { keys: Set<string>, memberCount: number } }>} */
const pendingWelcomeJobs = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBotAccountJid(sock, memberJid) {
    const botRaw = sock?.user?.id;
    if (!botRaw || !memberJid) {
        return false;
    }
    const botNorm = jidNormalizedUser(String(botRaw).replace(/:\d+(?=@)/, '')) || '';
    const memberNorm = normalizeParticipantEntry(memberJid);
    if (botNorm && memberNorm === botNorm) {
        return true;
    }
    const botPhone = extractPhoneNumber(botNorm);
    const memberPhone = extractPhoneNumber(memberNorm);
    return Boolean(botPhone && memberPhone && botPhone === memberPhone);
}

function welcomeDedupeKey(groupId, memberJid) {
    const phone = extractPhoneNumber(memberJid);
    if (phone) {
        return `${groupId}:p:${phone}`;
    }
    return `${groupId}:j:${memberJid}`;
}

function shouldSendWelcome(groupId, memberJid) {
    const key = welcomeDedupeKey(groupId, memberJid);
    const now = Date.now();
    const until = recentWelcomes.get(key);
    if (until && until > now) {
        return false;
    }
    recentWelcomes.set(key, now + WELCOME_DEDUPE_MS);
    if (recentWelcomes.size > 500) {
        for (const [k, exp] of recentWelcomes) {
            if (exp <= now) recentWelcomes.delete(k);
        }
    }
    return true;
}

async function resolveWelcomeMentionJid(sock, groupId, memberJid) {
    const normalized = normalizeParticipantEntry(memberJid);
    if (!normalized) {
        return '';
    }

    try {
        const meta = await sock.groupMetadata(groupId);
        const targetPhone = extractPhoneNumber(normalized);
        for (const p of meta.participants || []) {
            const candidates = [
                normalizeParticipantEntry(p.id),
                normalizeParticipantEntry(p.lid),
                normalizeParticipantEntry(p.phoneNumber),
            ].filter(Boolean);

            if (candidates.includes(normalized)) {
                return candidates[0] || normalized;
            }
            if (targetPhone && candidates.some((c) => extractPhoneNumber(c) === targetPhone)) {
                return normalizeParticipantEntry(p.id) || normalizeParticipantEntry(p.lid) || normalized;
            }
        }
    } catch (err) {
        logger.debug(`Welcome mention resolve failed: ${err.message}`);
    }

    return normalized;
}

async function captureWelcomeBaseline(sock, groupId) {
    let keys = groupParticipantSnapshot.cloneGroupKeys(groupId);
    if (!keys.size) {
        await groupParticipantSnapshot.seedGroup(sock, groupId);
        keys = groupParticipantSnapshot.cloneGroupKeys(groupId);
    }

    let memberCount = 0;
    try {
        const meta = await sock.groupMetadata(groupId);
        memberCount = meta.participants?.length || 0;
    } catch (err) {
        logger.warn(`Welcome baseline count failed for ${groupId}: ${err.message}`);
    }

    return { keys, memberCount };
}

async function sendWelcomeForMember(sock, groupManager, groupId, rawParticipant, config) {
    const memberJid = normalizeParticipantEntry(rawParticipant);
    if (!memberJid || !isValidParticipantJid(memberJid) || isBotAccountJid(sock, memberJid)) {
        return;
    }

    const [verified] = await filterCurrentGroupMembers(sock, groupId, [rawParticipant]);
    if (!verified) {
        logger.debug(`Welcome skipped — ${memberJid} is not in ${groupId}`);
        return;
    }

    if (!shouldSendWelcome(groupId, memberJid)) {
        return;
    }

    if (!config) {
        config = await groupManager.getWelcomeConfig(groupId);
        if (!config) {
            return;
        }
    }

    let groupName = config.group_name || 'this group';
    try {
        const meta = await groupManager.getGroupMetadataCached(sock, groupId);
        groupName = meta.subject || groupName;
    } catch (err) {
        logger.warn(`Welcome: could not fetch group name for ${groupId}: ${err.message}`);
    }

    const mentionJid = await resolveWelcomeMentionJid(sock, groupId, memberJid);
    if (!isValidParticipantJid(mentionJid)) {
        logger.debug(`Welcome skipped — invalid mention JID for ${groupId}`);
        return;
    }

    const { text, mentions } = renderWelcomeMessage(
        config.welcome_message || '',
        groupName,
        mentionJid,
    );

    const sent = await sock.sendMessage(groupId, {
        text,
        mentions: mentions.length ? mentions : undefined,
    });

    if (sent?.key) {
        scheduleAutoDelete(sock, sent.key.remoteJid || groupId, sent.key, AUTO_DELETE_2_MIN);
    }

    logger.info(`👋 Welcome sent in ${groupName} to ${mentionJid} (auto-delete in 2m)`);
}

/**
 * Send welcome to one or more new members.
 */
export async function handleParticipantJoin(sock, groupId, participants, { groupManager }) {
    if (!groupId?.endsWith('@g.us') || !participants?.length) {
        return;
    }

    const config = await groupManager.getWelcomeConfig(groupId);
    if (!config) {
        logger.debug(`Welcome skipped for ${groupId} — not enabled (use /setwc on)`);
        return;
    }

    const unique = dedupeParticipantRecords(participants);
    for (const entry of unique) {
        try {
            await sendWelcomeForMember(sock, groupManager, groupId, entry, config);
        } catch (err) {
            logger.error(`Welcome failed for ${groupId}: ${err.message}`);
        }
        await delay(400);
    }
}

export function cancelPendingWelcome(groupId) {
    const prev = pendingWelcomeJobs.get(groupId);
    if (prev?.timer) {
        clearTimeout(prev.timer);
    }
    pendingWelcomeJobs.delete(groupId);
}

async function filterCurrentGroupMembers(sock, groupId, entries) {
    if (!entries?.length) {
        return [];
    }

    let meta;
    try {
        meta = await sock.groupMetadata(groupId);
    } catch (err) {
        logger.warn(`Welcome member filter failed for ${groupId}: ${err.message}`);
        return [];
    }

    const memberKeys = groupParticipantSnapshot.buildMemberKeySet(meta.participants || []);
    const verified = [];

    for (const entry of entries) {
        const jid = normalizeParticipantEntry(entry);
        if (!jid) {
            continue;
        }
        if (groupParticipantSnapshot.isKeyInMemberSet(jid, memberKeys)) {
            verified.push(entry);
        } else {
            logger.debug(`Welcome skipped non-member ${jid} in ${groupId}`);
        }
    }

    return verified;
}

async function runWelcomeAfterJoin(sock, groupManager, groupId, baseline) {
    const config = await groupManager.getWelcomeConfig(groupId);
    if (!config || !baseline?.keys?.size) {
        return;
    }

    let meta;
    try {
        meta = await sock.groupMetadata(groupId);
    } catch (err) {
        logger.warn(`Welcome metadata fetch failed for ${groupId}: ${err.message}`);
        return;
    }

    const currentCount = meta.participants?.length || 0;
    if (currentCount <= baseline.memberCount) {
        logger.debug(
            `Welcome skipped for ${groupId} — member count did not increase (${baseline.memberCount} → ${currentCount})`,
        );
        await groupParticipantSnapshot.refresh(sock, groupId);
        return;
    }

    let newParticipants = [];
    try {
        newParticipants = await groupParticipantSnapshot.detectNewSince(sock, groupId, baseline.keys);
    } catch (err) {
        logger.warn(`Welcome participant diff failed for ${groupId}: ${err.message}`);
        return;
    }

    const toWelcome = dedupeParticipantRecords(newParticipants);
    if (!toWelcome.length) {
        logger.debug(`Welcome: no new members detected for ${groupId}`);
        return;
    }

    logger.info(`👋 Welcoming ${toWelcome.length} member(s) in ${groupId}`);
    await handleParticipantJoin(sock, groupId, toWelcome, { groupManager });
}

async function captureAndScheduleWelcome(sock, groupManager, groupId) {
    const baseline = await captureWelcomeBaseline(sock, groupId);
    if (!baseline.keys.size) {
        logger.debug(`Welcome skipped for ${groupId} — no participant baseline`);
        return;
    }

    const prev = pendingWelcomeJobs.get(groupId);
    if (prev?.timer) {
        clearTimeout(prev.timer);
    }

    const timer = setTimeout(() => {
        pendingWelcomeJobs.delete(groupId);
        void runWelcomeAfterJoin(sock, groupManager, groupId, baseline).catch((err) => {
            logger.error(`Welcome after join failed for ${groupId}: ${err.message}`);
        });
    }, WELCOME_JOIN_DELAY_MS);

    pendingWelcomeJobs.set(groupId, { timer, baseline });
}

export function scheduleWelcomeAfterJoin(sock, groupManager, groupId) {
    if (!groupId?.endsWith('@g.us')) {
        return;
    }

    void captureAndScheduleWelcome(sock, groupManager, groupId).catch((err) => {
        logger.error(`Welcome schedule failed for ${groupId}: ${err.message}`);
    });
}

export async function handleActivate(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.activateGroup(chatId, groupName, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *GROUP ACTIVATED* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎓 This group will now receive free course updates!\n';
        r += '📰 Tech news digests at *10:00 AM* & *10:00 PM* (IST)!\n';
        r += '🐙 GitHub trending repos daily at *9:00, 11:30, 2:00, 4:30 & 7:00 PM* (IST)!\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newsoff` or `/githuboff` to turn off individually\n';
        r += '💡 Use `/instaon` for auto Instagram downloads\n';
        r += '💡 Use `/deactivate` to stop all updates';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`✅ Group activated: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error activating group: ${error.message}`);
    }
}

export async function handleDeactivate(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const success = await groupManager.deactivateGroup(chatId);

        if (success) {
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '🛑 *GROUP DEACTIVATED* 🛑\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += '📢 This group will no longer receive courses or tech news.\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '💡 Use `/activate` to start receiving updates again';
            await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
            logger.info(`🛑 Group deactivated: ${chatId} by ${senderPhone}`);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.',
            }, { quoted: originalMsg });
        }
    } catch (error) {
        logger.error(`Error deactivating group: ${error.message}`);
    }
}

export async function handleInstaOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setInstaAuto(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *INSTA AUTO ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📸 Instagram links pasted here will download automatically.\n';
        r += '_No `/i` command needed — just send the link._\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/instaoff` to turn this off';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📸 Insta auto enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling insta auto: ${error.message}`);
    }
}

export async function handleInstaOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isInstaAutoEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *INSTA AUTO OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Auto Instagram download is not enabled in this group.\n\nUse `/instaon` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            groupName = groupMetadata.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setInstaAuto(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *INSTA AUTO OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += 'Links will no longer auto-download.\n';
        r += 'Members can still use `/i <url>` manually.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/instaon` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📸 Insta auto disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling insta auto: ${error.message}`);
    }
}

export async function handleGroups(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);

        const [activeGroups, newsGroups, githubGroups, instaAutoGroups, welcomeGroups, movieGroups, trendingGroups, groupCount, memberCounts] =
            await Promise.all([
                groupManager.getActiveGroups(),
                groupManager.getNewsEnabledGroups(),
                groupManager.getGithubTrendingGroups(),
                groupManager.getInstaAutoGroups(),
                groupManager.getWelcomeEnabledGroups(),
                groupManager.getMovieEnabledGroups(),
                groupManager.getWeeklyTrendingGroups(),
                groupManager.getGroupCount(),
                groupManager.getParticipatingGroupMemberCounts(sock),
            ]);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '📋 *GROUPS OVERVIEW* 📋\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📊 *Courses:* ${groupCount.active} active / ${groupCount.total} tracked\n`;
        r += `📰 *Tech news:* ${newsGroups.length} ON\n`;
        r += `🐙 *GitHub trending:* ${githubGroups.length} ON\n`;
        r += `📸 *Insta auto:* ${instaAutoGroups.length} group(s)\n`;
        r += `🎬 *Movie:* ${movieGroups.length} ON\n`;
        r += `🔥 *Trending:* ${trendingGroups.length} ON\n`;
        r += `👋 *Welcome:* ${welcomeGroups.length} ON\n\n`;

        r += '🎓 *Auto courses — active groups*\n';
        r += '_(courses via `/activate` · tech news via `/newson`)_\n\n';

        if (!activeGroups.length) {
            r += '📭 None yet. Use `/activate` in a group.\n\n';
        } else {
            activeGroups.forEach((group, index) => {
                const activatedDate = new Date(group.activated_at).toLocaleDateString();
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const newsOn = group.news_enabled !== false;
                const githubOn = group.github_trending !== false;
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                r += `   📰 News: ${newsOn ? '✅ ON' : '❌ OFF'} · 🐙 GitHub: ${githubOn ? '✅ ON' : '❌ OFF'}\n`;
                r += `   📅 Activated: ${activatedDate}\n\n`;
            });
        }

        r += '📰 *Tech news ON — groups*\n';
        r += '_(scheduled digests via `/newson` · off with `/newsoff`)_\n\n';

        if (!newsGroups.length) {
            r += '📭 None yet. Use `/activate` then `/newson` in a group.\n\n';
        } else {
            newsGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.news_set_at) {
                    r += `   📅 Since: ${new Date(group.news_set_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '🐙 *GitHub trending ON — groups*\n';
        r += '_(daily top 5 repos — one post each via `/githubon` · off with `/githuboff`)_\n\n';

        if (!githubGroups.length) {
            r += '📭 None yet. Use `/activate` then `/githubon` in a group.\n\n';
        } else {
            githubGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.github_trending_at) {
                    r += `   📅 Since: ${new Date(group.github_trending_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '📸 *Insta auto ON — groups*\n';
        r += '_(auto-download Instagram links via `/instaon`)_\n\n';

        if (!instaAutoGroups.length) {
            r += '📭 None yet. Use `/instaon` in a group.\n\n';
        } else {
            instaAutoGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                if (group.insta_auto_at) {
                    r += `   📸 Since: ${new Date(group.insta_auto_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '👋 *Welcome ON — groups*\n';
        r += '_(new member greeting via `/setwc`)_\n\n';

        if (!welcomeGroups.length) {
            r += '📭 None yet. Use `/setwc` in a group.\n\n';
        } else {
            welcomeGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const extra = group.welcome_message
                    ? group.welcome_message.slice(0, 60) + (group.welcome_message.length > 60 ? '…' : '')
                    : 'default header only';
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   🔘 Status: ${formatWelcomeStatus(true)}\n`;
                r += `   👥 Members: ${members}\n`;
                r += `   💬 Extra: ${extra}\n`;
                if (group.welcome_set_at) {
                    r += `   📅 Since: ${new Date(group.welcome_set_at).toLocaleDateString()}\n`;
                }
                r += '\n';
            });
        }

        r += '🎬 *Movie ON — groups*\n';
        r += '_(daily recap via `/movieon`)_\n\n';

        if (!movieGroups.length) {
            r += '📭 None yet. Use `/movieon` in a group.\n\n';
        } else {
            movieGroups.forEach((group, index) => {
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                const trending = group.weekly_trending ? ' · 🔥 Trending ON' : '';
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}${trending}\n\n`;
            });
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 `/activate` `/deactivate` · `/newson` `/newsoff`\n';
        r += '💡 `/githubon` `/githuboff` · `/instaon` `/instaoff` · `/movieon` `/movieoff` · `/trending on/off` · `/setwc`';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📋 Group list sent to ${senderPhone}`);
    } catch (error) {
        logger.error(`Error sending group list: ${error.message}`);
    }
}

export async function handleSetWelcome(sock, chatId, senderJid, fullCommand, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const body = fullCommand.replace(/^\/setwc\s*/i, '').trim();

        let groupName = 'this group';
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            groupName = groupMetadata.subject || groupName;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        const current = await groupManager.getWelcomeConfig(chatId);
        const isOn = Boolean(current);

        if (!body || body.toLowerCase() === 'help' || body.toLowerCase() === 'status') {
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '👋 *WELCOME MESSAGE* 👋\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n`;
            r += `🔘 *Status:* ${formatWelcomeStatus(isOn)}\n\n`;
            r += '*Default (always added):*\n';
            r += `${DEFAULT_HEADER_TEMPLATE.split('{group}').join(groupName)}\n\n`;
            r += '*Set your extra line:*\n';
            r += '`/setwc this group is for stickers`\n\n';
            r += '*Sends as:*\n';
            r += `${previewWelcomeMessage('this group is for stickers', groupName)}\n\n`;
            r += '*Commands:*\n';
            r += '• `/setwc <your text>` — turn ON + set extra line\n';
            r += '• `/setwc on` — turn ON (default header only)\n';
            r += '• `/setwc off` — turn OFF\n';
            r += '• `/setwc` — this status\n\n';

            if (isOn) {
                const custom = current.welcome_message || '(default header only)';
                r += '*Your extra line:*\n';
                r += `${custom}\n\n`;
                r += '*Full preview now:*\n';
                r += `${previewWelcomeMessage(current.welcome_message || '', groupName)}\n\n`;
                if (current.welcome_set_at) {
                    r += `_Updated ${new Date(current.welcome_set_at).toLocaleDateString()}_`;
                }
            } else {
                r += '_Welcome is OFF in this group._';
            }

            await sock.sendMessage(chatId, { text: r });
            return;
        }

        if (body.toLowerCase() === 'off') {
            if (!isOn) {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *WELCOME ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        `📢 *Group:* ${groupName}\n🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                        'Use `/setwc your message` to enable welcome.',
                });
                return;
            }

            await groupManager.clearWelcomeMessage(chatId);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *WELCOME OFF* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                    'New members will not get a welcome message here.',
            });
            logger.info(`👋 Welcome disabled: ${chatId} by ${senderPhone}`);
            return;
        }

        const customPart = body.toLowerCase() === 'on' ? '' : normalizeCustomWelcomePart(body);
        await groupManager.setWelcomeMessage(chatId, groupName, customPart, senderPhone);
        await groupParticipantSnapshot.seedGroup(sock, chatId);
        const preview = previewWelcomeMessage(customPart, groupName);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *WELCOME ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n`;
        r += `🔘 *Status:* ${formatWelcomeStatus(true)}\n\n`;
        if (customPart) {
            r += `*Your extra line:*\n${customPart}\n\n`;
        }
        r += '*New members will see:*\n';
        r += `${preview}\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 `/setwc off` to disable · `/setwc` for status\n';
        r += '_Welcome messages auto-delete after 2 minutes._';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`👋 Welcome set for ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error setting welcome message: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not save the welcome message. Try again.' });
    }
}

export async function handleGroupParticipantsUpdate(sock, update, { groupManager }) {
    try {
        const groupId = update?.id || update?.jid || update?.groupId;
        const action = String(update?.action || '').toLowerCase();
        const participants = update?.participants;

        if (!groupId?.endsWith('@g.us')) {
            return;
        }

        logger.info(`👋 group-participants.update ${action} in ${groupId} (${participants?.length ?? 0})`);

        if (LEAVE_ACTIONS.has(action) || action === 'promote' || action === 'demote') {
            cancelPendingWelcome(groupId);
            await groupParticipantSnapshot.refresh(sock, groupId);
            return;
        }

        if (JOIN_ACTIONS.has(action)) {
            scheduleWelcomeAfterJoin(sock, groupManager, groupId);
        }
    } catch (error) {
        logger.error(`Welcome message error: ${error.message}`);
    }
}

/**
 * Fallback when join arrives as a system stub message instead of participants.update.
 */
export async function handleJoinStubMessage(sock, msg, { groupManager }) {
    try {
        const groupId = msg?.key?.remoteJid;
        if (!groupId?.endsWith('@g.us')) {
            return;
        }

        const stubType = Number(msg.messageStubType);

        if (LEAVE_STUB_TYPES.has(stubType) || isLeaveStubMessage(msg)) {
            logger.debug(`Leave stub type ${stubType} in ${groupId} — refreshing snapshot`);
            cancelPendingWelcome(groupId);
            await groupParticipantSnapshot.refresh(sock, groupId);
            return;
        }

        if (!JOIN_STUB_TYPES.has(stubType)) {
            return;
        }

        logger.info(`👋 Join stub type ${stubType} in ${groupId}`);
        scheduleWelcomeAfterJoin(sock, groupManager, groupId);
    } catch (error) {
        logger.error(`Join stub welcome error: ${error.message}`);
    }
}

function isLeaveStubMessage(msg) {
    const stubType = Number(msg.messageStubType);
    if (JOIN_STUB_TYPES.has(stubType)) {
        return false;
    }

    const params = (msg.messageStubParameters || [])
        .filter((p) => typeof p === 'string')
        .join(' ')
        .toLowerCase();

    return (
        params.includes(' left')
        || params.endsWith(' left')
        || params.includes('removed')
        || params.includes('was removed')
        || params.includes('left the group')
    );
}

export async function handleNewsOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Tech news requires an activated group.\n\nUse `/activate` first, then `/newson`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setNewsEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *TECH NEWS ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📰 This group will receive tech news at *10:00 AM* & *10:00 PM* (IST).\n';
        r += '🎓 Courses continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newsoff` to stop tech news only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📰 Tech news enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling tech news: ${error.message}`);
    }
}

export async function handleNewsOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable courses and tech news.',
            }, { quoted: originalMsg });
            return;
        }

        const newsEnabled = await groupManager.isNewsEnabled(chatId);
        if (!newsEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *TECH NEWS ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Tech news is not enabled in this group.\n\nUse `/newson` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setNewsEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *TECH NEWS OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '📰 Scheduled tech news digests are disabled here.\n';
        r += '🎓 Course updates will continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/newson` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`📰 Tech news disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling tech news: ${error.message}`);
    }
}

export async function handleGithubOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'GitHub trending requires an activated group.\n\nUse `/activate` first, then `/githubon`.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setGithubTrendingEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *GITHUB TRENDING ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🐙 Daily GitHub picks — *trending, popular & hidden gems* (5 posts, fresh each time).\n';
        r += '🎓 Courses continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/githuboff` to stop GitHub trending only';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🐙 GitHub trending enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling GitHub trending: ${error.message}`);
    }
}

export async function handleGithubOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.\n\nUse `/activate` to enable updates.',
            }, { quoted: originalMsg });
            return;
        }

        const githubEnabled = await groupManager.isGithubTrendingEnabled(chatId);
        if (!githubEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GITHUB TRENDING ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'GitHub trending is not enabled in this group.\n\nUse `/githubon` to enable it.',
            }, { quoted: originalMsg });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch (err) {
            logger.error(`Error fetching group metadata: ${err.message}`);
        }

        await groupManager.setGithubTrendingEnabled(chatId, groupName, false, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🛑 *GITHUB TRENDING OFF* 🛑\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🐙 Daily GitHub trending posts are disabled here.\n';
        r += '🎓 Course updates will continue as normal.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/githubon` to enable again';

        await sock.sendMessage(chatId, { text: r }, { quoted: originalMsg });
        logger.info(`🐙 GitHub trending disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling GitHub trending: ${error.message}`);
    }
}

export async function handleMovieOn(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch {}

        await groupManager.setMovieEnabled(chatId, groupName, true, senderPhone);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *MOVIE FEATURES ON* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📢 *Group:* ${groupName}\n\n`;
        r += '🎬 Movie search is now enabled here!\n';
        r += '📊 Daily movie recap at *11:55 PM* IST\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/movie <name>` to search\n';
        r += '💡 Use `/movieoff` to disable\n';
        r += '💡 Use `/trending on` for weekly trending';
        await sock.sendMessage(chatId, { text: r });
        logger.info(`🎬 Movie enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling movie: ${error.message}`);
    }
}

export async function handleMovieOff(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isMovieEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *MOVIE ALREADY OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Movie features are not enabled in this group.\nUse `/movieon` to enable.',
            });
            return;
        }

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch {}

        await groupManager.setMovieEnabled(chatId, groupName, false, senderPhone);
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *MOVIE FEATURES OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                'Movie search and daily recaps are disabled.\nUse `/movieon` to enable again.',
        });
        logger.info(`🎬 Movie disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling movie: ${error.message}`);
    }
}

export async function handleTrending(sock, chatId, senderJid, args, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const action = (args[0] || '').toLowerCase();

        let groupName = 'Unknown Group';
        try {
            const meta = await sock.groupMetadata(chatId);
            groupName = meta.subject;
        } catch {}

        const currentlyOn = await groupManager.isWeeklyTrendingEnabled(chatId);

        if (!action || action === 'status') {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🔥 *WEEKLY TRENDING* 🔥\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n` +
                    `🔘 *Status:* ${currentlyOn ? '✅ ON' : '❌ OFF'}\n\n` +
                    'Posts top 10 trending movies every *Sunday 12 PM* IST\n\n' +
                    '*Commands:*\n' +
                    '• `/trending on` — enable\n' +
                    '• `/trending off` — disable\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            });
            return;
        }

        if (action === 'on') {
            if (currentlyOn) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Weekly trending is already *ON* in this group.' });
                return;
            }
            await groupManager.setWeeklyTrendingEnabled(chatId, groupName, true, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *WEEKLY TRENDING ON* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    '🔥 Top 10 trending movies will be posted every *Sunday 12 PM* IST\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 Use `/trending off` to disable',
            });
            logger.info(`🔥 Trending enabled: ${groupName} (${chatId}) by ${senderPhone}`);
        } else if (action === 'off') {
            if (!currentlyOn) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Weekly trending is already *OFF* in this group.' });
                return;
            }
            await groupManager.setWeeklyTrendingEnabled(chatId, groupName, false, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *WEEKLY TRENDING OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    'Weekly trending posts are disabled.\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 Use `/trending on` to enable again',
            });
            logger.info(`🔥 Trending disabled: ${chatId} by ${senderPhone}`);
        } else {
            await sock.sendMessage(chatId, { text: '❌ Usage: `/trending on` or `/trending off`' });
        }
    } catch (error) {
        logger.error(`Error handling trending toggle: ${error.message}`);
    }
}
