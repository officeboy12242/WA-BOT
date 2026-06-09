/**
 * Command Controller
 * Handles all bot commands
 */

import axios from 'axios';
import { fileTypeFromBuffer } from 'file-type';
import { snapsave } from 'snapsave-media-downloader';
import { checkCommandAccess } from '../commands/access.js';
import { findCommand, formatHelpText } from '../commands/registry.js';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { downloadMediaBuffer } from '../utils/downloadMediaBuffer.js';
import { extractInstagramUrl, isSupportedInstagramUrl } from '../utils/instagramUrl.js';

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
    constructor(database, botState, groupManager, newsController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.pendingClearConfirmations = new Map();
        this.botStartTime = Date.now(); // Track bot start time
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

    async handleGroups(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const [activeGroups, instaAutoGroups, groupCount] = await Promise.all([
                this.groupManager.getActiveGroups(),
                this.groupManager.getInstaAutoGroups(),
                this.groupManager.getGroupCount(),
            ]);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '📋 *ACTIVE GROUPS* 📋\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📊 *Total:* ${groupCount.active} active / ${groupCount.total} total\n\n`;

            if (activeGroups.length === 0) {
                response += '📭 No active groups yet.\n\n';
                response += 'Use `/activate` in a group to start posting there.';
            } else {
                response += '*Active Groups:*\n\n';
                activeGroups.forEach((group, index) => {
                    const activatedDate = new Date(group.activated_at).toLocaleDateString();
                    response += `${index + 1}. *${group.group_name}*\n`;
                    response += `   📅 Activated: ${activatedDate}\n\n`;
                });
            }

            if (instaAutoGroups.length > 0) {
                response += '*Insta auto-download groups:*\n\n';
                instaAutoGroups.forEach((group, index) => {
                    response += `${index + 1}. *${group.group_name}*\n`;
                    if (group.insta_auto_at) {
                        response += `   📸 Since: ${new Date(group.insta_auto_at).toLocaleDateString()}\n`;
                    }
                    response += '\n';
                });
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 `/activate` `/deactivate` · `/instaon` `/instaoff`';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`📋 Group list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending group list: ${error.message}`);
        }
    }

    async handleAddAdmin(sock, chatId, senderJid, args) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            // Extract phone number from command
            const phoneNumber = args.join('').replace(/[^0-9]/g, '');
            
            if (!phoneNumber) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *INVALID FORMAT* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += '*Usage:* `/addadmin <phone_number>`\n\n';
                response += '*Example:* `/addadmin 919876543210`';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const added = await this.groupManager.addAdmin(phoneNumber);
            if (!added) {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                        'ℹ️ *ALREADY STAFF* ℹ️\n' +
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'That number is already an owner or moderator (.env), or could not be added.',
                });
                return;
            }

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *ADMIN ADDED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📱 *Phone:* ${phoneNumber}\n\n`;
            response += 'This user can now manage groups and settings.';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`➕ Admin added: ${phoneNumber} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error adding admin: ${error.message}`);
        }
    }

    async handleRemoveAdmin(sock, chatId, senderJid, args) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const phoneNumber = args.join('').replace(/[^0-9]/g, '');
            
            if (!phoneNumber) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *INVALID FORMAT* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += '*Usage:* `/removeadmin <phone_number>`\n\n';
                response += '*Example:* `/removeadmin 919876543210`';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const success = await this.groupManager.removeAdmin(phoneNumber);

            if (success) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '✅ *ADMIN REMOVED* ✅\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += `📱 *Phone:* ${phoneNumber}\n\n`;
                response += 'This user is no longer a bot admin.';

                await sock.sendMessage(chatId, { text: response });
                logger.info(`➖ Admin removed: ${phoneNumber} by ${senderPhone}`);
            } else {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *NOT REMOVED* ℹ️\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Not a bot admin, or number is an owner/moderator (.env).';
                
                await sock.sendMessage(chatId, { text: response });
            }
        } catch (error) {
            logger.error(`Error removing admin: ${error.message}`);
        }
    }

    async handleAdmins(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);

            const admins = await this.groupManager.getAllAdmins();

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '👥 *BOT STAFF* 👥\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📊 *Total:* ${admins.length}\n\n`;

            if (admins.length === 0) {
                response += '📭 No staff configured yet.';
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
            response += '💡 Owners/moderators: `.env` · Bot admins: `/addadmin` `/removeadmin`';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`👥 Staff list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending admin list: ${error.message}`);
        }
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

    async handleNews(sock, chatId) {
        try {
            if (!this.newsController) {
                await sock.sendMessage(chatId, {
                    text: 'Tech news is not configured on this bot.',
                });
                return;
            }
            await this.newsController.previewNews(sock, chatId);
            logger.info(`News preview sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error handling news command: ${error.message}`);
            await sock.sendMessage(chatId, {
                text: 'Could not fetch tech news right now. Try again later.',
            });
        }
    }

    async handleHelp(sock, chatId, senderJid) {
        try {
            const [isStaff, isPrivileged] = await Promise.all([
                this.groupManager.isStaffAsync(sock, chatId, senderJid),
                this.groupManager.isPrivilegedAsync(sock, chatId, senderJid),
            ]);
            const response = formatHelpText({ isStaff, isPrivileged });
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
            case 'groups':
                await this.handleGroups(sock, chatId, senderJid);
                break;
            case 'addadmin':
                await this.handleAddAdmin(sock, chatId, senderJid, args);
                break;
            case 'removeadmin':
                await this.handleRemoveAdmin(sock, chatId, senderJid, args);
                break;
            case 'admins':
                await this.handleAdmins(sock, chatId, senderJid);
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
            case 'news':
                await this.handleNews(sock, chatId);
                break;
            default:
                break;
        }
    }
}

export default CommandController;
