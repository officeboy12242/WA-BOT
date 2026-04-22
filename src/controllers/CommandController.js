/**
 * Command Controller
 * Handles all bot commands
 */

import { logger } from '../utils/logger.js';
import { extractPhoneNumber, isGroupMessage } from '../utils/permissions.js';

class CommandController {
    constructor(database, botState, groupManager) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.pendingClearConfirmations = new Map();
    }

    async handlePosted(sock, chatId) {
        try {
            // Get stats for this specific group
            const stats = this.database.getPostedStats(chatId);
            
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
            const totalCourses = this.database.getTotalPosted(chatId);
            
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
            const deletedCount = this.database.clearAllPosted(chatId);
            
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
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
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
            
            let response = '━━��━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '⏸️ *BOT PAUSED* ⏸️\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += '🛑 Automatic course posting has been paused.\n\n';
            response += 'The bot will continue running but will not post new courses.\n\n';
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
            response += '✅ Automatic course posting has been resumed.\n\n';
            response += 'The bot will now check for and post new courses.\n\n';
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
            const stats = this.database.getPostedStats();
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
                : '💡 Use `/pause` to stop posting';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`📊 Status sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error sending status: ${error.message}`);
        }
    }

    async handleActivate(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can activate groups.\n\n';
                response += 'Contact the bot owner to become an admin.';
                
                await sock.sendMessage(chatId, { text: response });
                logger.warn(`⚠️ Unauthorized activate attempt by ${senderPhone}`);
                return;
            }

            // Check if this is a group
            if (!isGroupMessage(chatId)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *NOT A GROUP* ❌\n';
                response += '━━━━━━��━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'This command can only be used in groups.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            // Get group metadata
            let groupName = 'Unknown Group';
            try {
                const groupMetadata = await sock.groupMetadata(chatId);
                groupName = groupMetadata.subject;
            } catch (err) {
                logger.error(`Error fetching group metadata: ${err.message}`);
            }

            // Activate the group
            this.groupManager.activateGroup(chatId, groupName, senderPhone);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '✅ *GROUP ACTIVATED* ✅\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📢 *Group:* ${groupName}\n\n`;
            response += '🎓 This group will now receive free course updates!\n\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/deactivate` to stop receiving updates';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`✅ Group activated: ${groupName} (${chatId}) by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error activating group: ${error.message}`);
        }
    }

    async handleDeactivate(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can deactivate groups.';
                
                await sock.sendMessage(chatId, { text: response });
                logger.warn(`⚠️ Unauthorized deactivate attempt by ${senderPhone}`);
                return;
            }

            // Check if this is a group
            if (!isGroupMessage(chatId)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '❌ *NOT A GROUP* ❌\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'This command can only be used in groups.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            // Deactivate the group
            const success = this.groupManager.deactivateGroup(chatId);

            if (success) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🛑 *GROUP DEACTIVATED* 🛑\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += '📢 This group will no longer receive course updates.\n\n';
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
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can view group list.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const activeGroups = this.groupManager.getActiveGroups();
            const groupCount = this.groupManager.getGroupCount();

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
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

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/activate` or `/deactivate` in groups';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`📋 Group list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending group list: ${error.message}`);
        }
    }

    async handleAddAdmin(sock, chatId, senderJid, args) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can add other admins.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

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

            this.groupManager.addAdmin(phoneNumber);

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
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can remove other admins.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

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

            const success = this.groupManager.removeAdmin(phoneNumber);

            if (success) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '✅ *ADMIN REMOVED* ✅\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += `📱 *Phone:* ${phoneNumber}\n\n`;
                response += 'This user is no longer an admin.';

                await sock.sendMessage(chatId, { text: response });
                logger.info(`➖ Admin removed: ${phoneNumber} by ${senderPhone}`);
            } else {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += 'ℹ️ *NOT AN ADMIN* ℹ️\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'This user is not an admin.';
                
                await sock.sendMessage(chatId, { text: response });
            }
        } catch (error) {
            logger.error(`Error removing admin: ${error.message}`);
        }
    }

    async handleAdmins(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            
            // Check if sender is admin
            if (!this.groupManager.isAdmin(senderPhone)) {
                let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                response += '🔒 *PERMISSION DENIED* 🔒\n';
                response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                response += 'Only admins can view admin list.';
                
                await sock.sendMessage(chatId, { text: response });
                return;
            }

            const admins = this.groupManager.getAllAdmins();

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '👥 *BOT ADMINS* 👥\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += `📊 *Total Admins:* ${admins.length}\n\n`;

            if (admins.length === 0) {
                response += '📭 No admins yet.';
            } else {
                admins.forEach((admin, index) => {
                    const addedDate = new Date(admin.added_at).toLocaleDateString();
                    response += `${index + 1}. ${admin.phone_number}\n`;
                    response += `   📅 Added: ${addedDate}\n\n`;
                });
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Use `/addadmin` or `/removeadmin`';

            await sock.sendMessage(chatId, { text: response });
            logger.info(`👥 Admin list sent to ${senderPhone}`);
        } catch (error) {
            logger.error(`Error sending admin list: ${error.message}`);
        }
    }

    async handleHelp(sock, chatId, senderJid) {
        try {
            const senderPhone = extractPhoneNumber(senderJid);
            const isAdmin = await this.groupManager.isAdmin(sock, chatId, senderPhone);

            let response = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '🤖 *BOT COMMANDS* 🤖\n';
            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            response += '📌 *General Commands:*\n\n';
            response += '• `/posted` - View course statistics\n';
            response += '• `/status` - Check bot status\n';
            response += '• `/help` - Show this help message\n\n';

            if (isAdmin) {
                response += '🔧 *Admin Commands:*\n\n';
                response += '• `/activate` - Activate group for posting\n';
                response += '• `/deactivate` - Deactivate group\n';
                response += '• `/groups` - List all active groups\n';
                response += '• `/pause` - Pause automatic posting\n';
                response += '• `/resume` - Resume automatic posting\n';
                response += '• `/clear` - Delete all posted courses\n';
                response += '• `/addadmin <phone>` - Add new admin\n';
                response += '• `/removeadmin <phone>` - Remove admin\n';
                response += '• `/admins` - List all admins\n\n';
            }

            response += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            response += '💡 Free courses are posted automatically!';
            
            await sock.sendMessage(chatId, { text: response });
            logger.info(`📖 Help sent to ${chatId}`);
        } catch (error) {
            logger.error(`Error sending help: ${error.message}`);
        }
    }

    async handleCommand(sock, chatId, command, senderJid) {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        switch (cmd) {
            case '/posted':
                await this.handlePosted(sock, chatId);
                break;
            case '/clear':
                await this.handleClear(sock, chatId);
                break;
            case '/confirm':
                await this.handleConfirm(sock, chatId);
                break;
            case '/cancel':
                await this.handleCancel(sock, chatId);
                break;
            case '/pause':
                await this.handlePause(sock, chatId);
                break;
            case '/resume':
                await this.handleResume(sock, chatId);
                break;
            case '/status':
                await this.handleStatus(sock, chatId);
                break;
            case '/activate':
                await this.handleActivate(sock, chatId, senderJid);
                break;
            case '/deactivate':
                await this.handleDeactivate(sock, chatId, senderJid);
                break;
            case '/groups':
                await this.handleGroups(sock, chatId, senderJid);
                break;
            case '/addadmin':
                await this.handleAddAdmin(sock, chatId, senderJid, args);
                break;
            case '/removeadmin':
                await this.handleRemoveAdmin(sock, chatId, senderJid, args);
                break;
            case '/admins':
                await this.handleAdmins(sock, chatId, senderJid);
                break;
            case '/help':
                await this.handleHelp(sock, chatId, senderJid);
                break;
            default:
                // Unknown command - do nothing
                break;
        }
    }
}

export default CommandController;
