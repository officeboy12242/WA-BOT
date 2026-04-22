/**
 * WhatsApp Course Bot — MVC Edition
 * Main entry point for the bot
 */

import { config } from './src/config/config.js';
import { logger } from './src/utils/logger.js';
import { startHealthCheckServer } from './src/utils/healthCheck.js';
import DatabaseModel from './src/models/Database.js';
import CourseAPI from './src/models/CourseAPI.js';
import GroupManager from './src/models/GroupManager.js';
import CommandController from './src/controllers/CommandController.js';
import CourseController from './src/controllers/CourseController.js';
import WhatsAppService from './src/services/WhatsAppService.js';
import LogManager from './src/services/LogManager.js';
import StickerForwarder from './src/services/StickerForwarder.js';

// Bot state
const botState = {
    isPaused: false,
    lastCheckTime: null
};

// ─── Main Application ─────────────────────────────────────────────────────────
class WhatsAppCourseBot {
    constructor() {
        this.database = new DatabaseModel(config.DB_FILE);
        this.groupManager = new GroupManager();
        this.courseAPI = new CourseAPI();
        this.commandController = new CommandController(this.database, botState, this.groupManager);
        this.courseController = new CourseController(this.database, this.courseAPI, config, this.groupManager);
        
        // Initialize sticker forwarder if target groups are configured
        this.stickerForwarder = null;
        if (config.STICKER_TARGET_GROUPS.length > 0) {
            this.stickerForwarder = new StickerForwarder(
                config.STICKER_TARGET_GROUPS,
                config.STICKER_PACK_NAME,
                config.STICKER_PACK_AUTHOR
            );
            logger.info(`🎨 Sticker forwarding enabled for ${config.STICKER_TARGET_GROUPS.length} group(s)`);
        }
        
        this.whatsappService = new WhatsAppService(this.commandController, this.stickerForwarder);
        this.logManager = new LogManager('bot.log', '917887499710', 600000, 14400000); // Check every 10 min, delete after 4 hours
        this.checkInterval = null;
    }

    async start() {
        try {
            logger.info('🚀 Starting WhatsApp Course Bot...');
            
            // Initialize databases
            this.database.init();
            this.groupManager.init();
            
            // Set owner numbers from config
            this.groupManager.setOwnerNumbers(config.OWNER_NUMBERS);
            logger.info(`👑 Loaded ${config.OWNER_NUMBERS.length} owner(s) from .env`);
            logger.info(`🔐 Group admins will be auto-detected`);
            
            // Connect to WhatsApp
            await this.whatsappService.connect();
            
            // Wait for connection to be ready
            await this.whatsappService.waitForReady();
            
            // Start log manager
            this.logManager.setSocket(this.whatsappService.getSock());
            this.logManager.start();
            
            // Start checking for courses
            logger.info(`🤖 Bot is ready! Checking every ${config.CHECK_INTERVAL} seconds.`);
            
            // Initial check
            await this.courseController.checkAndPostCourses(
                this.whatsappService.getSock(), 
                botState
            );
            
            // Set up interval
            this.checkInterval = setInterval(async () => {
                try {
                    await this.courseController.checkAndPostCourses(
                        this.whatsappService.getSock(), 
                        botState
                    );
                } catch (error) {
                    logger.error('Error in course check interval:', error.message);
                }
            }, config.CHECK_INTERVAL * 1000);
        } catch (error) {
            logger.error('Error starting bot:', error.message);
            throw error;
        }
    }

    shutdown() {
        logger.info('👋 Shutting down...');
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
        }
        if (this.logManager) {
            this.logManager.stop();
        }
        if (this.database) {
            this.database.close();
        }
        process.exit(0);
    }
}

// ─── Start Bot ────────────────────────────────────────────────────────────────
const bot = new WhatsAppCourseBot();

// Start health check server (for Render to keep service alive)
const PORT = process.env.PORT || 3000;
startHealthCheckServer(PORT);

// Handle graceful shutdown
process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

// Start the bot
bot.start().catch(err => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
