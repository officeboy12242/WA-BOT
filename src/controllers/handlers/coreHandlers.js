/**
 * Core handlers: ping, status, posted, clear, confirm, cancel, pause, resume, facts, help
 */

import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { formatHelpText } from '../../commands/registry.js';

function formatUptime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

export async function handlePing(sock, chatId, { botState, botStartTime }) {
    try {
        const uptime = Date.now() - botStartTime;
        const uptimeFormatted = formatUptime(uptime);
        const currentTime = new Date().toLocaleString('en-US', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'full',
            timeStyle: 'long',
        });
        const startTime = new Date(botStartTime).toLocaleString('en-US', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        const memUsage = process.memoryUsage();
        const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
        const memTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🏓 *PONG!* 🏓\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += '✅ *Bot is alive and running!*\n\n';
        r += `⏰ *Current Time:*\n   ${currentTime}\n\n`;
        r += `🚀 *Started At:*\n   ${startTime}\n\n`;
        r += `⏱️ *Uptime:* ${uptimeFormatted}\n\n`;
        r += `💾 *Memory Usage:* ${memUsedMB}MB / ${memTotalMB}MB\n\n`;
        r += `📡 *Status:* ${botState.isPaused ? '⏸️ Paused' : '▶️ Active'}\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💚 All systems operational!';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`🏓 Ping response sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error handling ping command: ${error.message}`);
    }
}

export async function handlePosted(sock, chatId, { database }) {
    try {
        const stats = await database.getPostedStats(chatId);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '📊 *COURSE STATISTICS* 📊\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📚 *Total Courses Posted:* ${stats.total}\n\n`;
        r += `📅 *Today:* ${stats.today} courses\n`;
        r += `📆 *This Week:* ${stats.thisWeek} courses\n`;
        r += `📈 *This Month:* ${stats.thisMonth} courses\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✨ Keep learning and growing! ✨\n\n';
        r += '💡 Stats shown for this group only';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📊 Stats sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending stats: ${error.message}`);
    }
}

export async function handleClear(sock, chatId, { database, pendingClearConfirmations }) {
    try {
        const totalCourses = await database.getTotalPosted(chatId);

        if (totalCourses === 0) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📭 *DATABASE EMPTY* 📭\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There are no courses in the database for this group.',
            });
            return;
        }

        pendingClearConfirmations.set(chatId, Date.now());
        setTimeout(() => {
            if (pendingClearConfirmations.has(chatId)) {
                pendingClearConfirmations.delete(chatId);
            }
        }, 30000);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '⚠️ *CONFIRMATION REQUIRED* ⚠️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `You are about to delete *${totalCourses}* course(s) from THIS GROUP.\n\n`;
        r += '⚠️ *This action cannot be undone!*\n\n';
        r += 'To confirm, reply with:\n';
        r += '• `/confirm` - Delete courses for this group\n';
        r += '• `/cancel` - Cancel operation\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += "⏱️ This confirmation expires in 30 seconds\n";
        r += "💡 Only this group's data will be cleared";

        await sock.sendMessage(chatId, { text: r });
        logger.info(`⚠️ Clear confirmation requested for ${chatId} (${totalCourses} courses)`);
    } catch (error) {
        logger.error(`Error handling clear command: ${error.message}`);
    }
}

export async function handleConfirm(sock, chatId, { database, pendingClearConfirmations }) {
    try {
        if (!pendingClearConfirmations.has(chatId)) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n❌ *NO PENDING CONFIRMATION* ❌\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There is no pending clear operation.\n\nUse `/clear` first to initiate deletion.',
            });
            return;
        }

        pendingClearConfirmations.delete(chatId);
        const deletedCount = await database.clearAllPosted(chatId);

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '✅ *DATABASE CLEARED* ✅\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `🗑️ Successfully deleted *${deletedCount}* course(s) from this group\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 These courses will be posted again on next check!\n';
        r += '💡 Other groups are not affected';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`🗑️ Database cleared for group ${chatId}: ${deletedCount} courses deleted`);
    } catch (error) {
        logger.error(`Error confirming clear: ${error.message}`);
    }
}

export async function handleCancel(sock, chatId, { pendingClearConfirmations }) {
    try {
        if (!pendingClearConfirmations.has(chatId)) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *NO PENDING OPERATION* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'There is nothing to cancel.',
            });
            return;
        }

        pendingClearConfirmations.delete(chatId);

        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ *OPERATION CANCELLED* ✅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Clear operation has been cancelled.\nNo courses were deleted.',
        });
        logger.info(`❌ Clear operation cancelled by ${chatId}`);
    } catch (error) {
        logger.error(`Error cancelling clear: ${error.message}`);
    }
}

export async function handlePause(sock, chatId, { botState }) {
    try {
        if (botState.isPaused) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY PAUSED* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Bot is already paused.\nUse `/resume` to continue posting.',
            });
            return;
        }

        botState.isPaused = true;

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '⏸️ *BOT PAUSED* ⏸️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += '🛑 Automatic course and tech news posting has been paused.\n\n';
        r += 'The bot will continue running but will not post new content.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/resume` to continue posting';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`⏸️ Bot paused by ${chatId}`);
    } catch (error) {
        logger.error(`Error pausing bot: ${error.message}`);
    }
}

export async function handleResume(sock, chatId, { botState }) {
    try {
        if (!botState.isPaused) {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *ALREADY RUNNING* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Bot is already running.\nUse `/pause` to stop posting.',
            });
            return;
        }

        botState.isPaused = false;

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '▶️ *BOT RESUMED* ▶️\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += '✅ Automatic course and tech news posting has been resumed.\n\n';
        r += 'The bot will now check for and post new content.\n\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '💡 Use `/pause` to stop posting';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`▶️ Bot resumed by ${chatId}`);
    } catch (error) {
        logger.error(`Error resuming bot: ${error.message}`);
    }
}

export async function handleStatus(sock, chatId, { database, botState }) {
    try {
        const stats = await database.getPostedStats();
        const status = botState.isPaused ? '⏸️ PAUSED' : '▶️ RUNNING';
        const lastCheck = botState.lastCheckTime
            ? new Date(botState.lastCheckTime).toLocaleString()
            : 'Never';

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🤖 *BOT STATUS* 🤖\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📡 *Status:* ${status}\n`;
        r += `⏰ *Last Check:* ${lastCheck}\n`;
        r += `📊 *Total Posted:* ${stats.total} courses\n`;
        r += `📅 *Today:* ${stats.today} courses\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += botState.isPaused
            ? '💡 Use `/resume` to start posting'
            : '💡 Use `/pause` to stop posting';

        await sock.sendMessage(chatId, { text: r });
        logger.info(`📊 Status sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending status: ${error.message}`);
    }
}

export async function handleFacts(sock, chatId, quotedMessage) {
    try {
        const { data } = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en', {
            timeout: 15000,
        });
        const fact = data?.text?.trim() || 'No fact returned.';
        const sendOpts = quotedMessage ? { quoted: quotedMessage } : {};

        let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '🎭 *✨ Random fact ✨* 🎭\n';
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        r += `📌 ${fact}\n\n`;
        r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        r += '_Did you know? Drop another `/facts` for more!_ 🧠✨';

        await sock.sendMessage(chatId, { text: r }, sendOpts);
        logger.info(`🎭 Fact sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error fetching fact: ${error.message}`);
        const sendOpts = quotedMessage ? { quoted: quotedMessage } : {};
        await sock.sendMessage(
            chatId,
            {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n😅 *Oops!* Could not fetch a fact right now.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nTry again in a moment.',
            },
            sendOpts
        );
    }
}

export async function handleHelp(sock, chatId, senderJid, { groupManager, isOwnerFromJid }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const [isStaff, isPrivileged, canManageAdmins] = await Promise.all([
            groupManager.isStaffAsync(sock, chatId, senderJid),
            groupManager.isPrivilegedAsync(sock, chatId, senderJid),
            groupManager.canManageBotAdminsAsync(senderJid),
        ]);
        const canSetWelcome = isPrivileged || canManageAdmins;
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
        const response = formatHelpText({
            isStaff,
            isPrivileged,
            canManageAdmins,
            canSetWelcome,
            isOwner,
        });
        await sock.sendMessage(chatId, { text: response });
        logger.info(`📖 Help sent to ${chatId}`);
    } catch (error) {
        logger.error(`Error sending help: ${error.message}`);
    }
}
