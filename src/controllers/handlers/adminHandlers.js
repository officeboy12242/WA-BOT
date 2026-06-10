/**
 * Admin handlers: addadmin, removeadmin, admins
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { resolveTargetPhone } from '../../utils/waMessage.js';

export async function handleAddAdmin(sock, chatId, senderJid, args, waMessage, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

        if (!phoneNumber) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID FORMAT* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Usage:*\n• `/addadmin 919876543210`\n• Reply to a message: `/addadmin`\n• Tag someone: `/addadmin @user`',
            });
            return;
        }

        const result = await groupManager.addAdmin(phoneNumber);
        if (!result.ok) {
            const messages = {
                owner: 'That user is an owner (.env) and cannot be added as a bot admin.',
                moderator: 'That user is a moderator (.env) and cannot be added as a bot admin.',
                invalid: 'Could not read a valid phone number for that user.',
            };
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT ADDED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    (messages[result.reason] || 'Could not add that user as bot admin.'),
            });
            return;
        }

        if (result.reason === 'already') {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY BOT ADMIN* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📱 *Phone:* ${result.phone_number}\n\nThis user is already a bot admin.`,
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *ADMIN ADDED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📱 *Phone:* ${result.phone_number}\n\nThis user can now manage bot admins, groups, and settings.`,
        });
        logger.info(`➕ Admin added: ${result.phone_number} by ${senderPhone}`);
    } catch (error) {
        logger.error(`Error adding admin: ${error.message}`);
    }
}

export async function handleRemoveAdmin(sock, chatId, senderJid, args, waMessage, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

        if (!phoneNumber) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *INVALID FORMAT* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Usage:*\n• `/removeadmin 919876543210`\n• Reply to a message: `/removeadmin`\n• Tag someone: `/removeadmin @user`',
            });
            return;
        }

        const result = await groupManager.removeAdmin(phoneNumber);

        if (result.ok) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *ADMIN REMOVED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📱 *Phone:* ${result.phone_number}\n\nThis user is no longer a bot admin.\nUse \`/addadmin\` to make them admin again.`,
            });
            logger.info(`➖ Admin removed: ${result.phone_number} by ${senderPhone}`);
            return;
        }

        const removeMessages = {
            owner: 'Owners (.env) cannot be removed as bot admins.',
            moderator: 'Moderators (.env) cannot be removed as bot admins.',
            not_found: 'That user is not a bot admin.',
            invalid: 'Could not read a valid phone number for that user.',
        };
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NOT REMOVED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                (removeMessages[result.reason] || 'Could not remove that bot admin.'),
        });
    } catch (error) {
        logger.error(`Error removing admin: ${error.message}`);
    }
}

export async function handleAdmins(sock, chatId, senderJid, { groupManager }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);

        const [admins, waGroupAdmins] = await Promise.all([
            groupManager.getAllAdmins(),
            groupManager.fetchAllWhatsAppGroupAdmins(sock),
        ]);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '👥 *BOT STAFF* 👥\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📊 *Total:* ${admins.length}\n\n`;

        if (!admins.length) {
            r += '📭 No staff configured yet.\n\n';
        } else {
            admins.forEach((admin, index) => {
                const role = admin.role || 'Bot admin';
                const addedDate =
                    admin.added_at === 'Owner' || admin.added_at === 'Moderator (.env)'
                        ? admin.added_at
                        : new Date(admin.added_at).toLocaleDateString();
                r += `${index + 1}. ${admin.phone_number}\n`;
                r += `   🏷️ ${role}\n`;
                r += `   📅 ${addedDate}\n\n`;
            });
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += `📱 *WHATSAPP GROUP ADMINS* (${waGroupAdmins.length})\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        if (!waGroupAdmins.length) {
            r += '📭 No group admins found (or bot not in groups).\n\n';
        } else {
            waGroupAdmins.slice(0, 40).forEach((admin, index) => {
                const groupList = admin.groups.slice(0, 3).join(', ');
                const more = admin.groups.length > 3 ? ` +${admin.groups.length - 3} more` : '';
                r += `${index + 1}. ${admin.phone_number}\n`;
                r += `   🏷️ ${admin.role}\n`;
                r += `   👥 ${groupList}${more}\n\n`;
            });
            if (waGroupAdmins.length > 40) {
                r += `_…and ${waGroupAdmins.length - 40} more._\n\n`;
            }
        }

        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Owners/moderators: `.env` · Bot admins: `/addadmin` `/removeadmin`';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`👥 Staff list sent to ${senderPhone}`);
    } catch (error) {
        logger.error(`Error sending admin list: ${error.message}`);
    }
}
