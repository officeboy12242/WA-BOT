/**
 * Command Controller
 * Handles all bot commands
 */

import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { snapsave } from 'snapsave-media-downloader';
import { checkCommandAccess } from '../commands/access.js';
import { findCommand, formatHelpText } from '../commands/registry.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { downloadMediaBuffer } from '../utils/downloadMediaBuffer.js';
import { extractInstagramUrl, isSupportedInstagramUrl } from '../utils/instagramUrl.js';
import { resolveTargetPhone } from '../utils/waMessage.js';
import {
    DEFAULT_HEADER_TEMPLATE,
    formatWelcomeStatus,
    normalizeCustomWelcomePart,
    previewWelcomeMessage,
    renderWelcomeMessage,
} from '../utils/welcomeMessage.js';

function formatInstaDownloadStatus(mediaList) {
    const images = mediaList.filter((m) => m.type === 'image').length;
    const videos = mediaList.filter((m) => m.type === 'video').length;
    const total = mediaList.length;

    if (images && videos) {
        return `⏳ Downloading *${images}* image(s) and *${videos}* video(s)…\n_Please wait._`;
    }
    if (videos) {
        return `⏳ Downloading *${videos}* video(s)…\n_Please wait._`;
    }
    if (images) {
        return `⏳ Downloading *${images}* image(s)…\n_Please wait._`;
    }
    return `⏳ Downloading *${total}* item(s)…\n_Please wait._`;
}

function formatInstaSuccessText(sentCount, total, failedCount) {
    if (failedCount > 0) {
        return (
            `✅ Downloaded *${sentCount}/${total}* item(s) successfully.\n` +
            `_${failedCount} item(s) could not be downloaded._`
        );
    }
    const label = sentCount === 1 ? 'item' : 'items';
    return `✅ Downloaded and sent *${sentCount}* ${label} successfully.`;
}

async function safeDeleteChatMessage(sock, chatId, waMessage) {
    const key = waMessage?.key;
    if (!key) {
        return;
    }
    try {
        await sock.sendMessage(chatId, { delete: key });
    } catch (err) {
        logger.warn(`Could not delete status message: ${err.message}`);
    }
}

async function classifyMediaBuffer(buffer) {
    const type = await fileTypeFromBuffer(buffer);
    if (!type) {
        return { kind: 'other', mime: 'application/octet-stream', ext: 'bin' };
    }
    const mime = type.mime;
    const kind = mime.startsWith('image/')
        ? 'image'
        : mime.startsWith('video/')
          ? 'video'
          : 'other';
    return { kind, mime, ext: type.ext };
}

async function sendDownloadedMedia(sock, chatId, buffer, sendOpts, index, total) {
    const detected = await classifyMediaBuffer(buffer);
    if (detected.kind === 'video') {
        await sock.sendMessage(
            chatId,
            { video: buffer, mimetype: detected.mime },
            sendOpts
        );
        return true;
    }
    if (detected.kind === 'image') {
        await sock.sendMessage(
            chatId,
            { image: buffer, mimetype: detected.mime },
            sendOpts
        );
        return true;
    }
    await sock.sendMessage(
        chatId,
        {
            document: buffer,
            mimetype: detected.mime,
            fileName: `instagram_${index + 1}.${detected.ext || 'bin'}`,
        },
        sendOpts
    );
    return true;
}

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.movieController = movieController;
        this.pendingClearConfirmations = new Map();
        this.botStartTime = Date.now();
    }

    /**
     * Check if sender is owner - handles LID (Linked ID) resolution for privacy mode
     */
    async isOwnerFromJid(sock, chatId, senderJid) {
        const directPhone = extractPhoneNumber(senderJid);
        if (this.groupManager.isOwner(directPhone)) {
            return true;
        }
        
        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                const groupMeta = await sock.groupMetadata(chatId);
                for (const p of groupMeta.participants || []) {
                    if (p.lid === senderJid || p.id === senderJid) {
                        const realPhone = extractPhoneNumber(p.id);
                        if (this.groupManager.isOwner(realPhone)) return true;
                    }
                }
            } catch {}
        }
        
        return false;
    }

    /**
     * Format uptime in human-readable format
     */
    formatUptime(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    async handlePing(sock, chatId) {
        try {
            const uptime = Date.now() - this.botStartTime;
            const uptimeFormatted = this.formatUptime(uptime);
            const currentTime = new Date().toLocaleString('en-US', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'full',
                timeStyle: 'long'
            });
            const startTime = new Date(this.botStartTime).toLocaleString('en-US', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'short'
            });
            
            // Get memory usage
            const memUsage = process.memoryUsage();
            const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
            const memTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '🏓 *PONG!* 🏓\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += '✅ *Bot is alive and running!*\n\n';
            response += `⏰ *Current Time:*\n   ${currentTime}\n\n`;
            response += `🚀 *Started At:*\n   ${startTime}\n\n`;
            response += `⏱️ *Uptime:* ${uptimeFormatted}\n\n`;
            response += `💾 *Memory Usage:* ${memUsedMB}MB / ${memTotalMB}MB\n\n`;
            response += `📡 *Status:* ${this.botState.isPaused ? '⏸️ Paused' : '▶️ Active'}\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💚 All systems operational!';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`🏓 Ping response sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error handling ping command: ${error.message}`);
        }
    }

    async handlePosted(sock, chatId) {
        try {
            // Get stats for this specific group
            const stats = await this.database.getPostedStats(chatId);
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '📊 *COURSE STATISTICS* 📊\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📚 *Total Courses Posted:* ${stats.total}\n\n`;
            response += `📅 *Today:* ${stats.today} courses\n`;
            response += `📆 *This Week:* ${stats.thisWeek} courses\n`;
            response += `📈 *This Month:* ${stats.thisMonth} courses\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✨ Keep learning and growing! ✨\n\n';
            response += '💡 Stats shown for this group only';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`📊 Stats sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error sending stats: ${error.message}`);
        }
    }

    async handleClear(sock, chatId) {
        try {
            // Get total courses for THIS GROUP only
            const totalCourses = await this.database.getTotalPosted(chatId);
            
            if (totalCourses === 0) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '📭 *DATABASE EMPTY* 📭\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'There are no courses in the database for this group.';
                
                await sock.sendMessage(chatId, { text: response });
                logger.info(`📭 Empty database notification sent to ${chatId}`);
                return;
            }
            
            // Set pending confirmation with timestamp
            this.pendingClearConfirmations.set(chatId, Date.now());
            
            // Auto-expire after 30 seconds
            setTimeout(() => {
                if (this.pendingClearConfirmations.has(chatId)) {
                    this.pendingClearConfirmations.delete(chatId);
                    logger.info(`⏱️ Clear confirmation expired for ${chatId}`);
                }
            }, 30000);
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '⚠️ *CONFIRMATION REQUIRED* ⚠️\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `You are about to delete *${totalCourses}* course(s) from THIS GROUP.\n\n`;
            response += '⚠️ *This action cannot be undone!*\n\n';
            response += 'To confirm, reply with:\n';
            response += '• `/confirm` - Delete courses for this group\n';
            response += '• `/cancel` - Cancel operation\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '⏱️ This confirmation expires in 30 seconds\n';
            response += '💡 Only this group\'s data will be cleared';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`⚠️ Clear confirmation requested for ${chatId} (${totalCourses} courses)`);
        } catch (error) {
            logger.error(`Error handling clear command: ${error.message}`);
        }
    }

    async handleConfirm(sock, chatId) {
        try {
            if (!this.pendingClearConfirmations.has(chatId)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *NO PENDING CONFIRMATION* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'There is no pending clear operation.\n\n';
                response += 'Use `/clear` first to initiate deletion.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }
            
            // Remove confirmation
            this.pendingClearConfirmations.delete(chatId);
            
            // Clear the database for THIS GROUP only
            const deletedCount = await this.database.clearAllPosted(chatId);
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *DATABASE CLEARED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `🗑️ Successfully deleted *${deletedCount}* course(s) from this group\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 These courses will be posted again on next check!\n';
            response += '💡 Other groups are not affected';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`🗑️ Database cleared for group ${chatId}: ${deletedCount} courses deleted`);
        } catch (error) {
            logger.error(`Error confirming clear: ${error.message}`);
        }
    }

    async handleCancel(sock, chatId) {
        try {
            if (!this.pendingClearConfirmations.has(chatId)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *NO PENDING OPERATION* ℹ️\n';
                response += '━━━━━━━━━━━━━��━━━━━━━━━━━━━\n\n';
                response += 'There is nothing to cancel.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }
            
            // Remove confirmation
            this.pendingClearConfirmations.delete(chatId);
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *OPERATION CANCELLED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += 'Clear operation has been cancelled.\n';
            response += 'No courses were deleted.';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`❌ Clear operation cancelled by ${chatId}`);
        } catch (error) {
            logger.error(`Error cancelling clear: ${error.message}`);
        }
    }

    async handlePause(sock, chatId) {
        try {
            if (this.botState.isPaused) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *ALREADY PAUSED* ℹ️\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Bot is already paused.\n';
                response += 'Use `/resume` to continue posting.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            this.botState.isPaused = true;
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '⏸️ *BOT PAUSED* ⏸️\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += '🛑 Automatic course and tech news posting has been paused.\n\n';
            response += 'The bot will continue running but will not post new content.\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/resume` to continue posting';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`⏸️ Bot paused by ${chatId}`);
        } catch (error) {
            logger.error(`Error pausing bot: ${error.message}`);
        }
    }

    async handleResume(sock, chatId) {
        try {
            if (!this.botState.isPaused) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *ALREADY RUNNING* ℹ️\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Bot is already running.\n';
                response += 'Use `/pause` to stop posting.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            this.botState.isPaused = false;
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '▶️ *BOT RESUMED* ▶️\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += '✅ Automatic course and tech news posting has been resumed.\n\n';
            response += 'The bot will now check for and post new content.\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/pause` to stop posting';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`▶️ Bot resumed by ${chatId}`);
        } catch (error) {
            logger.error(`Error resuming bot: ${error.message}`);
        }
    }

    async handleStatus(sock, chatId) {
        try {
            const stats = await this.database.getPostedStats();
            const status = this.botState.isPaused ? '⏸️ PAUSED' : '▶️ RUNNING';
            const lastCheck = this.botState.lastCheckTime 
                ? new Date(this.botState.lastCheckTime).toLocaleString() 
                : 'Never';
            
            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '🤖 *BOT STATUS* 🤖\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📡 *Status:* ${status}\n`;
            response += `⏰ *Last Check:* ${lastCheck}\n`;
            response += `📊 *Total Posted:* ${stats.total} courses\n`;
            response += `📅 *Today:* ${stats.today} courses\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += this.botState.isPaused 
                ? '💡 Use `/resume` to start posting' 
                : '�� Use `/pause` to stop posting';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`📊 Status sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error sending status: ${error.message}`);
        }
    }

    async handleActivate(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            // Get group metadata
            let groupName = 'Unknown Group';
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                groupName = groupMetadata.subject;
            } catch (err) {
                logger.error(`Error fetching group metadata: ${err.message}`);
            }

            // Activate the group
            await this.groupManager.activateGroup(chatId, groupName, senderPhone);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *GROUP ACTIVATED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📢 *Group:* ${groupName}\n\n`;
            response += '🎓 This group will now receive free course updates!\n';
            response += '📰 Tech news digests at *10:00 AM* & *10:00 PM* (IST)!\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/instaon` for auto Instagram downloads\n';
            response += '💡 Use `/deactivate` to stop receiving updates';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`✅ Group activated: ${groupName} (${chatId}) by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error activating group: ${error.message}`);
        }
    }

    async handleInstaOn(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            let groupName = 'Unknown Group';
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                groupName = groupMetadata.subject;
            } catch (err) {
                logger.error(`Error fetching group metadata: ${err.message}`);
            }

            await this.groupManager.setInstaAuto(chatId, groupName, true, senderPhone);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *INSTA AUTO ON* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📢 *Group:* ${groupName}\n\n`;
            response += '📸 Instagram links pasted here will download automatically.\n';
            response += '_No `/i` command needed — just send the link._\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/instaoff` to turn this off';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`📸 Insta auto enabled: ${groupName} (${chatId}) by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error enabling insta auto: ${error.message}`);
        }
    }

    async handleInstaOff(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            const wasEnabled = await this.groupManager.isInstaAutoEnabled(chatId);
            if (!wasEnabled) {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        'ℹ️ *INSTA AUTO OFF* ℹ️\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Auto Instagram download is not enabled in this group.\n\n' +
                        'Use `/instaon` to enable it.',
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

            await this.groupManager.setInstaAuto(chatId, groupName, false, senderPhone);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '🛑 *INSTA AUTO OFF* 🛑\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📢 *Group:* ${groupName}\n\n`;
            response += 'Links will no longer auto-download.\n';
            response += 'Members can still use `/i <url>` manually.\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/instaon` to enable again';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`📸 Insta auto disabled: ${chatId} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error disabling insta auto: ${error.message}`);
        }
    }

    async handleDeactivate(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            // Deactivate the group
            const success = await this.groupManager.deactivateGroup(chatId);

            if (success) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🛑 *GROUP DEACTIVATED* 🛑\n';
                response += '━━━━━━━━━━━━━━━━━━━━��━━━━━━\n\n';
                response += '📢 This group will no longer receive course or tech news updates.\n\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '💡 Use `/activate` to start receiving updates again';

                await sock.sendMessage(chatId, { text: response });
                logger.info(`🛑 Group deactivated: ${chatId} by ${senderPhone}`);
            } else {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *NOT ACTIVATED* ℹ️\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'This group is not activated.';
                
                await sock.sendMessage(chatId, { text: response });
            }
        } catch (error) {
            logger.error(`Error deactivating group: ${error.message}`);
        }
    }

    async handleSetWelcome(sock, chatId, senderJid, fullCommand) {
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

            const current = await this.groupManager.getWelcomeConfig(chatId);
            const isOn = Boolean(current);

            if (!body || body.toLowerCase() === 'help' || body.toLowerCase() === 'status') {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '👋 *WELCOME MESSAGE* 👋\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += `📢 *Group:* ${groupName}\n`;
                response += `🔘 *Status:* ${formatWelcomeStatus(isOn)}\n\n`;
                response += '*Default (always added):*\n';
                response += `${DEFAULT_HEADER_TEMPLATE.split('{group}').join(groupName)}\n\n`;
                response += '*Set your extra line:*\n';
                response += '`/setwc this group is for stickers`\n\n';
                response += '*Sends as:*\n';
                response += `${previewWelcomeMessage('this group is for stickers', groupName)}\n\n`;
                response += '*Commands:*\n';
                response += '• `/setwc <your text>` — turn ON + set extra line\n';
                response += '• `/setwc on` — turn ON (default header only)\n';
                response += '• `/setwc off` — turn OFF\n';
                response += '• `/setwc` — this status\n\n';

                if (isOn) {
                    const custom = current.welcome_message || '(default header only)';
                    response += '*Your extra line:*\n';
                    response += `${custom}\n\n`;
                    response += '*Full preview now:*\n';
                    response += `${previewWelcomeMessage(current.welcome_message || '', groupName)}\n\n`;
                    if (current.welcome_set_at) {
                        response += `_Updated ${new Date(current.welcome_set_at).toLocaleDateString()}_`;
                    }
                } else {
                    response += '_Welcome is OFF in this group._';
                }

                await sock.sendMessage(chatId, { text: response });
                return;
            }

            if (body.toLowerCase() === 'off') {
                if (!isOn) {
                    await sock.sendMessage(chatId, {
                        text:
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                            'ℹ️ *WELCOME ALREADY OFF* ℹ️\n' +
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                            `📢 *Group:* ${groupName}\n` +
                            `🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                            'Use `/setwc your message` to enable welcome.',
                    });
                    return;
                }

                await this.groupManager.clearWelcomeMessage(chatId);
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        '✅ *WELCOME OFF* ✅\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        `📢 *Group:* ${groupName}\n` +
                        `🔘 *Status:* ${formatWelcomeStatus(false)}\n\n` +
                        'New members will not get a welcome message here.',
                });
                logger.info(`👋 Welcome disabled: ${chatId} by ${senderPhone}`);
                return;
            }

            const customPart =
                body.toLowerCase() === 'on' ? '' : normalizeCustomWelcomePart(body);

            await this.groupManager.setWelcomeMessage(chatId, groupName, customPart, senderPhone);

            const preview = previewWelcomeMessage(customPart, groupName);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *WELCOME ON* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📢 *Group:* ${groupName}\n`;
            response += `🔘 *Status:* ${formatWelcomeStatus(true)}\n\n`;
            if (customPart) {
                response += `*Your extra line:*\n${customPart}\n\n`;
            }
            response += '*New members will see:*\n';
            response += `${preview}\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 `/setwc off` to disable · `/setwc` for status';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`👋 Welcome set for ${groupName} (${chatId}) by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error setting welcome message: ${error.message}`);
            await sock.sendMessage(chatId, {
                text: 'Could not save the welcome message. Try again.',
            });
        }
    }

    async handleGroupParticipantsUpdate(sock, update) {
        try {
            const { id: groupId, participants, action } = update;
            if (action !== 'add' || !groupId?.endsWith('@g.us') || !participants?.length) {
                return;
            }

            const config = await this.groupManager.getWelcomeConfig(groupId);
            if (!config) {
                return;
            }

            let groupName = config.group_name || 'this group';
            try {
                const meta = await this.groupManager.getGroupMetadataCached(sock, groupId);
                groupName = meta.subject || groupName;
            } catch (err) {
                logger.warn(`Welcome: could not fetch group name for ${groupId}: ${err.message}`);
            }

            const botJid = sock.user?.id;
            for (const memberJid of participants) {
                if (!memberJid || memberJid === botJid) {
                    continue;
                }

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

    async handleGroups(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const [activeGroups, instaAutoGroups, welcomeGroups, groupCount, memberCounts] =
                await Promise.all([
                    this.groupManager.getActiveGroups(),
                    this.groupManager.getInstaAutoGroups(),
                    this.groupManager.getWelcomeEnabledGroups(),
                    this.groupManager.getGroupCount(),
                    this.groupManager.getParticipatingGroupMemberCounts(sock),
                ]);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '📋 *GROUPS OVERVIEW* 📋\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📊 *Courses:* ${groupCount.active} active / ${groupCount.total} tracked\n`;
            response += `📸 *Insta auto:* ${instaAutoGroups.length} group(s)\n`;
            response += `👋 *Welcome:* ${welcomeGroups.length} ON\n\n`;

            response += '🎓 *Auto courses — active groups*\n';
            response += '_(courses + tech news via `/activate`)_\n\n';

            if (activeGroups.length === 0) {
                response += '📭 None yet. Use `/activate` in a group.\n\n';
            } else {
                activeGroups.forEach((group, index) => {
                    const activatedDate = new Date(group.activated_at).toLocaleDateString();
                    const members = this.groupManager.formatMemberCount(
                        memberCounts,
                        group.group_id
                    );
                    response += `${index + 1}. *${group.group_name}*\n`;
                    response += `   👥 Members: ${members}\n`;
                    response += `   📅 Activated: ${activatedDate}\n\n`;
                });
            }

            response += '📸 *Insta auto ON — groups*\n';
            response += '_(auto-download Instagram links via `/instaon`)_\n\n';

            if (instaAutoGroups.length === 0) {
                response += '📭 None yet. Use `/instaon` in a group.\n\n';
            } else {
                instaAutoGroups.forEach((group, index) => {
                    const members = this.groupManager.formatMemberCount(
                        memberCounts,
                        group.group_id
                    );
                    response += `${index + 1}. *${group.group_name}*\n`;
                    response += `   👥 Members: ${members}\n`;
                    if (group.insta_auto_at) {
                        response += `   📸 Since: ${new Date(group.insta_auto_at).toLocaleDateString()}\n`;
                    }
                    response += '\n';
                });
            }

            response += '👋 *Welcome ON — groups*\n';
            response += '_(new member greeting via `/setwc`)_\n\n';

            if (welcomeGroups.length === 0) {
                response += '📭 None yet. Use `/setwc` in a group.\n\n';
            } else {
                welcomeGroups.forEach((group, index) => {
                    const members = this.groupManager.formatMemberCount(
                        memberCounts,
                        group.group_id
                    );
                    const extra = group.welcome_message
                        ? group.welcome_message.slice(0, 60) +
                          (group.welcome_message.length > 60 ? '…' : '')
                        : 'default header only';
                    response += `${index + 1}. *${group.group_name}*\n`;
                    response += `   🔘 Status: ${formatWelcomeStatus(true)}\n`;
                    response += `   👥 Members: ${members}\n`;
                    response += `   💬 Extra: ${extra}\n`;
                    if (group.welcome_set_at) {
                        response += `   📅 Since: ${new Date(group.welcome_set_at).toLocaleDateString()}\n`;
                    }
                    response += '\n';
                });
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 `/activate` `/deactivate` · `/instaon` `/instaoff` · `/setwc`';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`📋 Group list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending group list: ${error.message}`);
        }
    }

    async handleAddAdmin(sock, chatId, senderJid, args, waMessage = null) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

            if (!phoneNumber) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *INVALID FORMAT* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += '*Usage:*\n';
                response += '• `/addadmin 919876543210`\n';
                response += '• Reply to a message: `/addadmin`\n';
                response += '• Tag someone: `/addadmin @user`';

                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const result = await this.groupManager.addAdmin(phoneNumber);
            if (!result.ok) {
                const messages = {
                    owner: 'That user is an owner (.env) and cannot be added as a bot admin.',
                    moderator: 'That user is a moderator (.env) and cannot be added as a bot admin.',
                    invalid: 'Could not read a valid phone number for that user.',
                };
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        'ℹ️ *NOT ADDED* ℹ️\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        (messages[result.reason] || 'Could not add that user as bot admin.'),
                });
                return;
            }

            if (result.reason === 'already') {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        'ℹ️ *ALREADY BOT ADMIN* ℹ️\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        `📱 *Phone:* ${result.phone_number}\n\n` +
                        'This user is already a bot admin.',
                });
                return;
            }

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *ADMIN ADDED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📱 *Phone:* ${result.phone_number}\n\n`;
            response += 'This user can now manage bot admins, groups, and settings.';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`➕ Admin added: ${result.phone_number} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error adding admin: ${error.message}`);
        }
    }

    async handleRemoveAdmin(sock, chatId, senderJid, args, waMessage = null) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const phoneNumber = await resolveTargetPhone(sock, chatId, args, waMessage, senderJid);

            if (!phoneNumber) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *INVALID FORMAT* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += '*Usage:*\n';
                response += '• `/removeadmin 919876543210`\n';
                response += '• Reply to a message: `/removeadmin`\n';
                response += '• Tag someone: `/removeadmin @user`';

                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const result = await this.groupManager.removeAdmin(phoneNumber);

            if (result.ok) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '✅ *ADMIN REMOVED* ✅\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += `📱 *Phone:* ${result.phone_number}\n\n`;
                response += 'This user is no longer a bot admin.\n';
                response += 'Use `/addadmin` to make them admin again.';

                await sock.sendMessage(chatId, { text: response });
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
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    'ℹ️ *NOT REMOVED* ℹ️\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    (removeMessages[result.reason] || 'Could not remove that bot admin.'),
            });
        } catch (error) {
            logger.error(`Error removing admin: ${error.message}`);
        }
    }

    async handleAdmins(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const [admins, waGroupAdmins] = await Promise.all([
                this.groupManager.getAllAdmins(),
                this.groupManager.fetchAllWhatsAppGroupAdmins(sock),
            ]);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '👥 *BOT STAFF* 👥\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📊 *Total:* ${admins.length}\n\n`;

            if (admins.length === 0) {
                response += '📭 No staff configured yet.\n\n';
            } else {
                admins.forEach((admin, index) => {
                    const role = admin.role || 'Bot admin';
                    const addedDate =
                        admin.added_at === 'Owner' || admin.added_at === 'Moderator (.env)'
                            ? admin.added_at
                            : new Date(admin.added_at).toLocaleDateString();
                    response += `${index + 1}. ${admin.phone_number}\n`;
                    response += `   🏷️ ${role}\n`;
                    response += `   📅 ${addedDate}\n\n`;
                });
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += `📱 *WHATSAPP GROUP ADMINS* (${waGroupAdmins.length})\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

            if (!waGroupAdmins.length) {
                response += '📭 No group admins found (or bot not in groups).\n\n';
            } else {
                waGroupAdmins.slice(0, 40).forEach((admin, index) => {
                    const groupList = admin.groups.slice(0, 3).join(', ');
                    const more =
                        admin.groups.length > 3 ? ` +${admin.groups.length - 3} more` : '';
                    response += `${index + 1}. ${admin.phone_number}\n`;
                    response += `   🏷️ ${admin.role}\n`;
                    response += `   👥 ${groupList}${more}\n\n`;
                });
                if (waGroupAdmins.length > 40) {
                    response += `_…and ${waGroupAdmins.length - 40} more._\n\n`;
                }
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Owners/moderators: `.env` · Bot admins: `/addadmin` `/removeadmin`';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`👥 Staff list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending admin list: ${error.message}`);
        }
    }

    async handleAddChannel(sock, chatId, args, senderJid) {
        const senderPhone = extractPhoneNumber(senderJid);
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can add sticker channels.' });
            return;
        }

        if (!args.length) {
            await sock.sendMessage(chatId, {
                text: '📡 *Add Sticker Channel*\n\n' +
                    'Usage: `/addchannel <channel-url-or-jid>`\n\n' +
                    'Examples:\n' +
                    '• `/addchannel https://whatsapp.com/channel/0029Va...`\n' +
                    '• `/addchannel 120363399411386277@newsletter`',
            });
            return;
        }

        const input = args[0];
        let channelJid = input;
        let channelName = input;

        if (input.includes('whatsapp.com/channel/') || !input.includes('@newsletter')) {
            const code = input.replace(/^https?:\/\/(www\.)?whatsapp\.com\/channel\//i, '').split('/')[0];
            try {
                const meta = await sock.newsletterMetadata('invite', code);
                channelJid = meta?.id || '';
                channelName = meta?.name?.text || meta?.name || code;
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Could not resolve channel: ${err.message}` });
                return;
            }
        }

        if (!channelJid?.includes('@newsletter')) {
            await sock.sendMessage(chatId, { text: '❌ Invalid channel. Provide a valid channel URL or JID.' });
            return;
        }

        const result = await this.groupManager.addStickerChannel(channelJid, channelName, senderPhone);
        if (result.ok) {
            try {
                await sock.subscribeNewsletterUpdates(channelJid);
            } catch {}
            await sock.sendMessage(chatId, {
                text: `✅ *Channel Added*\n\n📡 ${channelName}\n🆔 ${channelJid}\n\n_Stickers from this channel will be forwarded._`,
            });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Failed: ${result.reason}` });
        }
    }

    async handleRemoveChannel(sock, chatId, args, senderJid) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can remove sticker channels.' });
            return;
        }

        if (!args.length) {
            const channels = await this.groupManager.getStickerChannels();
            if (!channels.length) {
                await sock.sendMessage(chatId, { text: '📭 No sticker channels configured.' });
                return;
            }
            
            let text = '📡 *Remove Sticker Channel*\n\nUsage: `/removechannel <number>`\n\n*Current channels:*\n\n';
            channels.forEach((ch, i) => {
                text += `${i + 1}. ${ch.channel_name || ch.channel_jid}\n`;
            });
            await sock.sendMessage(chatId, { text });
            return;
        }

        const channels = await this.groupManager.getStickerChannels();
        const input = args[0];
        let targetJid = input;

        const num = parseInt(input, 10);
        if (!isNaN(num) && num >= 1 && num <= channels.length) {
            targetJid = channels[num - 1].channel_jid;
        } else if (!input.includes('@newsletter')) {
            await sock.sendMessage(chatId, { text: '❌ Invalid. Use channel number from `/removechannel` list.' });
            return;
        }

        const result = await this.groupManager.removeStickerChannel(targetJid);
        if (result.ok) {
            await sock.sendMessage(chatId, { text: `✅ Channel removed: ${targetJid}` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ ${result.reason}` });
        }
    }

    async handleChannels(sock, chatId, senderJid) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can view sticker channels.' });
            return;
        }

        const dbChannels = await this.groupManager.getStickerChannels();
        const envChannelJids = config.STICKER_SOURCE_CHANNELS || [];
        
        let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += '📡 *STICKER SOURCE CHANNELS*\n';
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

        let idx = 0;
        
        if (envChannelJids.length) {
            text += '🔧 *From .env:*\n';
            for (const jid of envChannelJids) {
                idx++;
                let name = jid;
                try {
                    if (sock.newsletterMetadata) {
                        const meta = await sock.newsletterMetadata('jid', jid);
                        const rawName = meta?.name || meta?.thread_metadata?.name;
                        name = typeof rawName === 'string' ? rawName : (rawName?.text || jid);
                    }
                } catch {}
                text += `${idx}. ${name}\n`;
                text += `   🆔 \`${jid}\`\n\n`;
            }
        }
        
        if (dbChannels.length) {
            text += '💾 *From commands:*\n';
            for (const ch of dbChannels) {
                idx++;
                const date = ch.added_at ? new Date(ch.added_at).toLocaleDateString() : '';
                text += `${idx}. ${ch.channel_name || 'Unnamed'}\n`;
                text += `   🆔 \`${ch.channel_jid}\`\n`;
                if (date) text += `   📅 ${date}\n`;
                text += '\n';
            }
        }

        if (!envChannelJids.length && !dbChannels.length) {
            text += '📭 No channels configured.\n\n';
            text += '_Use `/addchannel` to add one._\n';
        } else {
            text += `📊 *Total:* ${idx} channel(s)\n`;
        }

        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += '💡 `/addchannel` `/removechannel`';
        
        await sock.sendMessage(chatId, { text });
    }

    async handleFacts(sock, chatId, quotedMessage) {
        try {
            const { data } = await axios.get(
                'https://uselessfacts.jsph.pl/random.json?language=en',
                { timeout: 15000 }
            );
            const fact = data?.text?.trim() || 'No fact returned.';
            const sendOpts = quotedMessage ? { quoted: quotedMessage } : {};

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '🎭 *✨ Random fact ✨* 🎭\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📌 ${fact}\n\n`;
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '_Did you know? Drop another `/facts` for more!_ 🧠✨';

            await sock.sendMessage(chatId, { text: response }, sendOpts);
            logger.info(`🎭 Fact sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error fetching fact: ${error.message}`);
            const sendOpts = quotedMessage ? { quoted: quotedMessage } : {};
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        '😅 *Oops!* Could not fetch a fact right now.\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Try again in a moment.',
                },
                sendOpts
            );
        }
    }

    /**
     * Instagram download via snapsave-media-downloader.
     * Shows a temporary status message, sends media, deletes the status, then replies to the /i command.
     */
    async handleInsta(sock, chatId, args, quotedMessage, options = {}) {
        const { requireCommandArgs = true } = options;
        const replyToCommand = quotedMessage ? { quoted: quotedMessage } : {};

        if (requireCommandArgs && !args.length) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        'Usage: `/insta <instagram-url>` (alias `/i`)\n' +
                        'Example: `/insta https://www.instagram.com/p/xxxxx/`\n\n' +
                        'In a private chat you can also paste an Instagram link without a command.',
                },
                replyToCommand
            );
            return;
        }

        let url = extractInstagramUrl(args.join(' ').trim()) || (args[0] || '').trim();
        if (!isSupportedInstagramUrl(url)) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        'Only Instagram post/reel/TV/share links from instagram.com are supported.',
                },
                replyToCommand
            );
            return;
        }

        let statusMsg = null;
        try {
            statusMsg = await sock.sendMessage(chatId, {
                text: '⏳ Fetching Instagram media…\n_This may take a few seconds._',
            });

            const result = await snapsave(url, { retry: 2, retryDelay: 800 });

            if (!result.success) {
                await safeDeleteChatMessage(sock, chatId, statusMsg);
                statusMsg = null;
                await sock.sendMessage(
                    chatId,
                    {
                        text: `Could not fetch media. ${result.message || 'Unknown error.'}`,
                    },
                    replyToCommand
                );
                return;
            }

            const data = result.data || {};
            const rawMedia = data.media || [];
            const seen = new Set();
            const mediaList = [];
            for (const m of rawMedia) {
                if (!m?.url || seen.has(m.url)) continue;
                seen.add(m.url);
                mediaList.push(m);
            }

            if (!mediaList.length) {
                await safeDeleteChatMessage(sock, chatId, statusMsg);
                statusMsg = null;
                await sock.sendMessage(chatId, { text: 'No media URLs in the response.' }, replyToCommand);
                return;
            }

            await safeDeleteChatMessage(sock, chatId, statusMsg);
            statusMsg = await sock.sendMessage(chatId, {
                text: formatInstaDownloadStatus(mediaList),
            });

            const total = mediaList.length;
            let sentCount = 0;
            let failedCount = 0;
            for (let i = 0; i < total; i++) {
                const item = mediaList[i];
                try {
                    const buffer = await downloadMediaBuffer(item.url);
                    await sendDownloadedMedia(sock, chatId, buffer, {}, i, total);
                    sentCount++;
                } catch (err) {
                    failedCount++;
                    logger.warn(`Insta item ${i + 1}/${total} failed: ${err.message}`);
                }
                await new Promise((r) => setTimeout(r, 1000));
            }

            await safeDeleteChatMessage(sock, chatId, statusMsg);
            statusMsg = null;

            if (!sentCount) {
                await sock.sendMessage(
                    chatId,
                    { text: 'Found media links but could not download any item. Try again later.' },
                    replyToCommand
                );
                return;
            }

            await sock.sendMessage(
                chatId,
                { text: formatInstaSuccessText(sentCount, total, failedCount) },
                replyToCommand
            );
            logger.info(`Insta: sent ${sentCount}/${total} item(s) for ${chatId}`);
        } catch (err) {
            logger.error(`Insta command error: ${err.message}`);
            await sock.sendMessage(
                chatId,
                {
                    text:
                        'Something went wrong (private post, bad link, or upstream error). Try another URL.',
                },
                replyToCommand
            );
        } finally {
            if (statusMsg?.key) {
                await safeDeleteChatMessage(sock, chatId, statusMsg);
            }
        }
    }

    async handleNews(sock, chatId, senderJid) {
        try {
            if (!this.newsController) {
                await sock.sendMessage(chatId, {
                    text: 'Tech news is not configured on this bot.',
                });
                return;
            }

            const articles = await this.newsController.fetchFreshArticles();
            if (!articles.length) {
                await sock.sendMessage(chatId, {
                    text: '📭 No fresh tech news right now. Try again later.',
                });
                return;
            }

            const sent = await this.newsController.previewNews(sock, chatId, articles);
            logger.info(`News preview (${sent} msg) sent to ${chatId}`);

            const canPost = await this.groupManager.canManualPostNews(senderJid);
            if (!canPost) {
                return;
            }

            const { posted, groups } = await this.newsController.postNews(sock, articles);
            if (groups === 0) {
                await sock.sendMessage(chatId, {
                    text: 'ℹ️ Preview only — no activated groups. Use `/activate` in a group first.',
                });
                return;
            }

            await sock.sendMessage(chatId, {
                text:
                    posted > 0
                        ? `✅ Posted *${sent}* tech news message(s) to *${posted}* activated group(s).`
                        : 'ℹ️ News was already posted to all activated groups.',
            });
        } catch (error) {
            logger.error(`Error handling news command: ${error.message}`);
            await sock.sendMessage(chatId, {
                text: 'Could not fetch tech news right now. Try again later.',
            });
        }
    }

    async handleAddPremium(sock, chatId, senderJid, args, quotedMessage) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can manage premium users.' });
            return;
        }
        const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
        if (!targetPhone) {
            await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/addpremium 919876543210`_' });
            return;
        }
        const result = await this.groupManager.addPremiumUser(targetPhone, extractPhoneNumber(senderJid));
        if (result.ok) {
            const targetJid = `${result.phone_number}@s.whatsapp.net`;
            const groupAnnounce = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n`
                + `┃   ⭐ *PREMIUM UPGRADE!* ⭐    ┃\n`
                + `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`
                + `🎉 @${result.phone_number} has been upgraded to *Premium*!\n\n`
                + `🎬 Unlimited movie searches unlocked\n`
                + `🚀 No daily limits anymore\n`
                + `─────────────────────────────\n`
                + `_Upgraded by owner_ 👑`;
            await sock.sendMessage(chatId, {
                text: groupAnnounce,
                mentions: [targetJid],
            });

            const dmText = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n`
                + `┃  ⭐ *CONGRATULATIONS!* ⭐   ┃\n`
                + `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`
                + `🎉 You've been upgraded to *Premium Member*!\n\n`
                + `✅ *What you get:*\n`
                + `• 🎬 *Unlimited* movie searches (no daily limit)\n`
                + `• ⚡ Priority access to all features\n`
                + `• 🌟 Premium badge on your profile\n\n`
                + `─────────────────────────────\n`
                + `Try it now → \`/movie Avengers\`\n`
                + `─────────────────────────────\n`
                + `_Thank you for being awesome!_ 🤖⭐`;
            try {
                await sock.sendMessage(targetJid, { text: dmText });
            } catch {}
        } else if (result.reason === 'already') {
            await sock.sendMessage(chatId, { text: `ℹ️ ${result.phone_number} is already a premium user.` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Invalid phone number.` });
        }
    }

    async handleRemovePremium(sock, chatId, senderJid, args, quotedMessage) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can manage premium users.' });
            return;
        }
        const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
        if (!targetPhone) {
            await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/removepremium 919876543210`_' });
            return;
        }
        const result = await this.groupManager.removePremiumUser(targetPhone);
        if (result.ok) {
            const targetJid = `${result.phone_number}@s.whatsapp.net`;
            const groupMsg = `⭐ *Premium revoked* for @${result.phone_number}\n\n🎬 Back to 5 daily movie searches.`;
            await sock.sendMessage(chatId, {
                text: groupMsg,
                mentions: [targetJid],
            });

            const dmText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
                + `⭐ *Premium Status Update*\n`
                + `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
                + `Your premium membership has been removed.\n\n`
                + `🎬 You now have *5 free searches/day*.\n`
                + `💡 Contact the owner to renew!\n`
                + `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
            try {
                await sock.sendMessage(targetJid, { text: dmText });
            } catch {}
        } else if (result.reason === 'not_found') {
            await sock.sendMessage(chatId, { text: `ℹ️ That user is not a premium member.` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Invalid phone number.` });
        }
    }

    async handleListPremium(sock, chatId, senderJid) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can view premium users.' });
            return;
        }
        const users = await this.groupManager.getAllPremiumUsers();
        let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += '⭐ *PREMIUM USERS*\n';
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        if (!users.length) {
            text += '📭 No premium users yet.\n\n_Use `/addpremium` to add one._';
        } else {
            text += `📊 *Total:* ${users.length}\n\n`;
            users.forEach((u, i) => {
                const date = u.added_at ? new Date(u.added_at).toLocaleDateString() : '';
                text += `${i + 1}. 📱 ${u.phone_number}\n`;
                if (date) text += `   📅 ${date}\n`;
                text += '\n';
            });
        }
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += '💡 `/addpremium` `/removepremium`';
        await sock.sendMessage(chatId, { text });
    }

    async handleAddMod(sock, chatId, senderJid, args, quotedMessage) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can manage moderators.' });
            return;
        }
        const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
        if (!targetPhone) {
            await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/addmod 919876543210`_' });
            return;
        }
        const result = await this.groupManager.addDynamicModerator(targetPhone, extractPhoneNumber(senderJid));
        if (result.ok) {
            const targetJid = `${result.phone_number}@s.whatsapp.net`;
            const groupMsg = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n`
                + `┃  🛡️ *NEW MODERATOR!* 🛡️     ┃\n`
                + `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`
                + `🎉 @${result.phone_number} is now a *Moderator*!\n\n`
                + `✅ Staff commands unlocked\n`
                + `🎬 Unlimited movie searches\n`
                + `─────────────────────────────\n`
                + `_Promoted by owner_ 👑`;
            await sock.sendMessage(chatId, {
                text: groupMsg,
                mentions: [targetJid],
            });

            const dmText = `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n`
                + `┃  🛡️ *YOU'RE A MODERATOR!* 🛡️ ┃\n`
                + `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n`
                + `🎉 You've been promoted to *Moderator*!\n\n`
                + `✅ *Your new powers:*\n`
                + `• 📋 Activate/deactivate groups\n`
                + `• 📰 Post tech news to groups\n`
                + `• 👥 Manage bot admins\n`
                + `• 🎬 Unlimited movie searches\n`
                + `• 📸 Toggle Instagram auto-download\n\n`
                + `─────────────────────────────\n`
                + `_Use /help to see all commands_ 🤖`;
            try {
                await sock.sendMessage(targetJid, { text: dmText });
            } catch {}
        } else if (result.reason === 'already') {
            await sock.sendMessage(chatId, { text: `ℹ️ ${result.phone_number} is already a moderator.` });
        } else if (result.reason === 'owner') {
            await sock.sendMessage(chatId, { text: `ℹ️ That user is already an owner.` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Invalid phone number.` });
        }
    }

    async handleRemoveMod(sock, chatId, senderJid, args, quotedMessage) {
        const isOwner = await this.isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only owners can manage moderators.' });
            return;
        }
        const targetPhone = await resolveTargetPhone(sock, chatId, args, quotedMessage, senderJid);
        if (!targetPhone) {
            await sock.sendMessage(chatId, { text: '❌ Specify a phone number, @tag someone, or reply to their message.\n\n_Example: `/removemod 919876543210`_' });
            return;
        }
        const result = await this.groupManager.removeDynamicModerator(targetPhone);
        if (result.ok) {
            const targetJid = `${result.phone_number}@s.whatsapp.net`;
            const groupMsg = `🛡️ @${result.phone_number} has been removed as *Moderator*.`;
            await sock.sendMessage(chatId, {
                text: groupMsg,
                mentions: [targetJid],
            });

            const dmText = `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
                + `🛡️ *Moderator Status Update*\n`
                + `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
                + `Your moderator role has been removed.\n`
                + `Staff commands are no longer available.\n\n`
                + `💡 Contact the owner if this was a mistake.\n`
                + `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
            try {
                await sock.sendMessage(targetJid, { text: dmText });
            } catch {}
        } else if (result.reason === 'not_found') {
            await sock.sendMessage(chatId, { text: `ℹ️ That user is not a dynamic moderator.\n\n_Note: .env moderators cannot be removed via command._` });
        } else {
            await sock.sendMessage(chatId, { text: `❌ Invalid phone number.` });
        }
    }

    async handleMovie(sock, chatId, senderJid, args) {
        if (!this.movieController) {
            await sock.sendMessage(chatId, { text: '⚠️ Movie search is not available.' });
            return;
        }
        await this.movieController.handleMovieSearch(sock, chatId, senderJid, args);
    }

    async handleHelp(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            const [isStaff, isPrivileged, canManageAdmins] = await Promise.all([
                this.groupManager.isStaffAsync(sock, chatId, senderJid),
                this.groupManager.isPrivilegedAsync(sock, chatId, senderJid),
                this.groupManager.canManageBotAdminsAsync(senderJid),
            ]);
            const canSetWelcome = isPrivileged || canManageAdmins;
            const isOwner = this.groupManager.isOwner(senderPhone);
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

    async handleCommand(sock, chatId, command, senderJid, quotedMessage = null) {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        if (!cmd) {
            return;
        }

        const def = findCommand(cmd);
        if (!def) {
            return;
        }

        const access = await checkCommandAccess(sock, chatId, senderJid, def, this.groupManager);
        if (!access.ok) {
            await sock.sendMessage(chatId, { text: access.message });
            return;
        }

        switch (def.key) {
            case 'ping':
                await this.handlePing(sock, chatId);
                break;
            case 'posted':
                await this.handlePosted(sock, chatId);
                break;
            case 'clear':
                await this.handleClear(sock, chatId);
                break;
            case 'confirm':
                await this.handleConfirm(sock, chatId);
                break;
            case 'cancel':
                await this.handleCancel(sock, chatId);
                break;
            case 'pause':
                await this.handlePause(sock, chatId);
                break;
            case 'resume':
                await this.handleResume(sock, chatId);
                break;
            case 'status':
                await this.handleStatus(sock, chatId);
                break;
            case 'activate':
                await this.handleActivate(sock, chatId, senderJid);
                break;
            case 'deactivate':
                await this.handleDeactivate(sock, chatId, senderJid);
                break;
            case 'instaon':
                await this.handleInstaOn(sock, chatId, senderJid);
                break;
            case 'instaoff':
                await this.handleInstaOff(sock, chatId, senderJid);
                break;
            case 'setwc':
                await this.handleSetWelcome(sock, chatId, senderJid, command.trim());
                break;
            case 'groups':
                await this.handleGroups(sock, chatId, senderJid);
                break;
            case 'addadmin':
                await this.handleAddAdmin(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'removeadmin':
                await this.handleRemoveAdmin(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'admins':
                await this.handleAdmins(sock, chatId, senderJid);
                break;
            case 'addpremium':
                await this.handleAddPremium(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'removepremium':
                await this.handleRemovePremium(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'premium':
                await this.handleListPremium(sock, chatId, senderJid);
                break;
            case 'addmod':
                await this.handleAddMod(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'removemod':
                await this.handleRemoveMod(sock, chatId, senderJid, args, quotedMessage);
                break;
            case 'addchannel':
                await this.handleAddChannel(sock, chatId, args, senderJid);
                break;
            case 'removechannel':
                await this.handleRemoveChannel(sock, chatId, args, senderJid);
                break;
            case 'channels':
                await this.handleChannels(sock, chatId, senderJid);
                break;
            case 'help':
                await this.handleHelp(sock, chatId, senderJid);
                break;
            case 'facts':
                await this.handleFacts(sock, chatId, quotedMessage);
                break;
            case 'insta':
                await this.handleInsta(sock, chatId, args, quotedMessage);
                break;
            case 'movie':
                await this.handleMovie(sock, chatId, senderJid, args);
                break;
            case 'news':
                await this.handleNews(sock, chatId, senderJid);
                break;
            default:
                break;
        }
    }
}

export default CommandController;
