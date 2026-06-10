/**
 * Group handlers: activate, deactivate, instaon, instaoff, groups, setwc, welcome event
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import {
    DEFAULT_HEADER_TEMPLATE,
    formatWelcomeStatus,
    normalizeCustomWelcomePart,
    previewWelcomeMessage,
    renderWelcomeMessage,
} from '../../utils/welcomeMessage.js';

export async function handleActivate(sock, chatId, senderJid, { groupManager }) {
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
        r += '📰 Tech news digests at *10:00 AM* & *10:00 PM* (IST)!\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/instaon` for auto Instagram downloads\n';
        r += '💡 Use `/deactivate` to stop receiving updates';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`✅ Group activated: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error activating group: ${error.message}`);
    }
}

export async function handleDeactivate(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const success = await groupManager.deactivateGroup(chatId);

        if (success) {
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '🛑 *GROUP DEACTIVATED* 🛑\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += '📢 This group will no longer receive course or tech news updates.\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '💡 Use `/activate` to start receiving updates again';
            await sock.sendMessage(chatId, { text: r });
            logger.info(`🛑 Group deactivated: ${chatId} by ${senderPhone}`);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT ACTIVATED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'This group is not activated.',
            });
        }
    } catch (error) {
        logger.error(`Error deactivating group: ${error.message}`);
    }
}

export async function handleInstaOn(sock, chatId, senderJid, { groupManager }) {
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

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📸 Insta auto enabled: ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error enabling insta auto: ${error.message}`);
    }
}

export async function handleInstaOff(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const wasEnabled = await groupManager.isInstaAutoEnabled(chatId);
        if (!wasEnabled) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *INSTA AUTO OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Auto Instagram download is not enabled in this group.\n\nUse `/instaon` to enable it.',
            });
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

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📸 Insta auto disabled: ${chatId} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error disabling insta auto: ${error.message}`);
    }
}

export async function handleGroups(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);

        const [activeGroups, instaAutoGroups, welcomeGroups, groupCount, memberCounts] =
            await Promise.all([
                groupManager.getActiveGroups(),
                groupManager.getInstaAutoGroups(),
                groupManager.getWelcomeEnabledGroups(),
                groupManager.getGroupCount(),
                groupManager.getParticipatingGroupMemberCounts(sock),
            ]);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '📋 *GROUPS OVERVIEW* 📋\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📊 *Courses:* ${groupCount.active} active / ${groupCount.total} tracked\n`;
        r += `📸 *Insta auto:* ${instaAutoGroups.length} group(s)\n`;
        r += `👋 *Welcome:* ${welcomeGroups.length} ON\n\n`;

        r += '🎓 *Auto courses — active groups*\n';
        r += '_(courses + tech news via `/activate`)_\n\n';

        if (!activeGroups.length) {
            r += '📭 None yet. Use `/activate` in a group.\n\n';
        } else {
            activeGroups.forEach((group, index) => {
                const activatedDate = new Date(group.activated_at).toLocaleDateString();
                const members = groupManager.formatMemberCount(memberCounts, group.group_id);
                r += `${index + 1}. *${group.group_name}*\n`;
                r += `   👥 Members: ${members}\n`;
                r += `   📅 Activated: ${activatedDate}\n\n`;
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

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 `/activate` `/deactivate` · `/instaon` `/instaoff` · `/setwc`';

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
        r += '💡 `/setwc off` to disable · `/setwc` for status';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`👋 Welcome set for ${groupName} (${chatId}) by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error setting welcome message: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not save the welcome message. Try again.' });
    }
}

export async function handleGroupParticipantsUpdate(sock, update, { groupManager }) {
    try {
        const { id: groupId, participants, action } = update;
        if (action !== 'add' || !groupId?.endsWith('@g.us') || !participants?.length) return;

        const config = await groupManager.getWelcomeConfig(groupId);
        if (!config) return;

        let groupName = config.group_name || 'this group';
        try {
            const meta = await groupManager.getGroupMetadataCached(sock, groupId);
            groupName = meta.subject || groupName;
        } catch (err) {
            logger.warn(`Welcome: could not fetch group name for ${groupId}: ${err.message}`);
        }

        const botJid = sock.user?.id;
        for (const memberJid of participants) {
            if (!memberJid || memberJid === botJid) continue;

            const { text, mentions } = renderWelcomeMessage(
                config.welcome_message || '',
                groupName,
                memberJid
            );

            await sock.sendMessage(groupId, {
                text,
                mentions: mentions.length ? mentions : undefined,
            });
            logger.info(`👋 Welcome sent in ${groupName} to ${memberJid}`);
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    } catch (error) {
        logger.error(`Welcome message error: ${error.message}`);
    }
}
