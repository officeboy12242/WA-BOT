/**
 * WhatsApp Course Bot — MVC Edition
 * Main entry point for the bot
 */

import { config } from './src/config/config.js';
import { closeMongo, connectMongo } from './src/db/mongo.js';
import { logger } from './src/utils/logger.js';
import AdminPanel from './src/utils/adminPanel.js';
import DatabaseModel from './src/models/Database.js';
import AuthDatabase from './src/models/AuthDatabase.js';
import CourseAPI from './src/models/CourseAPI.js';
import GroupManager from './src/models/GroupManager.js';
import CommandController from './src/controllers/CommandController.js';
import CourseController from './src/controllers/CourseController.js';
import NewsController from './src/controllers/NewsController.js';
import NewsDatabase from './src/models/NewsDatabase.js';
import InshortsScraper from './src/services/InshortsScraper.js';
import WhatsAppService from './src/services/WhatsAppService.js';
import LogManager from './src/services/LogManager.js';
import StickerForwarder from './src/services/StickerForwarder.js';
import ChannelStickerPoller from './src/services/ChannelStickerPoller.js';
import { startNewsScheduler } from './src/utils/newsScheduler.js';
import { startGithubScheduler } from './src/utils/githubScheduler.js';
import { startMorningScheduler } from './src/utils/morningScheduler.js';
import MorningMessageDatabase from './src/models/MorningMessageDatabase.js';
import MorningMessageScraper from './src/services/MorningMessageScraper.js';
import MorningMessageController from './src/controllers/MorningMessageController.js';
import MovieController from './src/controllers/MovieController.js';
import GitHubTrendingController from './src/controllers/GitHubTrendingController.js';
import GitHubTrendingDatabase from './src/models/GitHubTrendingDatabase.js';
import GroupMemberDatabase from './src/models/GroupMemberDatabase.js';
import WarnDatabase from './src/models/WarnDatabase.js';
import MemberScrapeController from './src/controllers/MemberScrapeController.js';
import UserManager from './src/models/UserManager.js';
import StickerController from './src/controllers/StickerController.js';
import BotSettings from './src/models/BotSettings.js';
import { InstanceLock } from './src/utils/instanceLock.js';
import { shortLinkService } from './src/services/ShortLinkService.js';
import { urlShortener } from './src/utils/urlShortener.js';
import { pronoobDriveService } from './src/services/PronoobDriveService.js';

// Bot state
const botState = {
    isPaused: false,
    lastCheckTime: null,
    lastNewsCheckTime: null,
    lastNewsPostSlot: null,
    lastMorningPostSlot: null,
    lastGithubPostSlot: null,
    lastGithubPostSlots: {},
    lastGithubCheckTime: null,
    githubTrendingCache: null,
};

// ─── Main Application ─────────────────────────────────────────────────────────
class WhatsAppCourseBot {
    constructor() {
        this.database = null;
        this.authDatabase = null;
        this.groupManager = null;
        this.userManager = null;
        this.courseAPI = new CourseAPI();
        this.stickerForwarder = null;
        this.channelStickerPoller = null;
        this.commandController = null;
        this.courseController = null;
        this.newsController = null;
        this.whatsappService = null;
        this.logManager = new LogManager('bot.log', '917887499710', 600000, 14400000); // Check every 10 min, delete after 4 hours
        this.checkInterval = null;
        this.newsScheduler = null;
        this.githubScheduler = null;
        this.morningScheduler = null;
        this.morningDatabase = null;
        this.stickerController = null;
        this.adminPanel = null;
        this.instanceLock = null;
        this.botSettings = null;
        this._isShuttingDown = false;
    }

    async start() {
        try {
            logger.info('🚀 Starting WhatsApp Course Bot...');
            
            const mongoDb = await connectMongo({
                uri: config.MONGODB_URI,
                dbName: config.MONGODB_DB_NAME,
            });

            // Initialize databases
            this.database = new DatabaseModel(mongoDb);
            this.newsDatabase = new NewsDatabase(mongoDb);
            this.githubTrendingDatabase = new GitHubTrendingDatabase(mongoDb);
            this.groupMemberDatabase = new GroupMemberDatabase(mongoDb);
            this.warnDatabase = new WarnDatabase(mongoDb);
            this.morningDatabase = new MorningMessageDatabase(mongoDb);
            this.groupManager = new GroupManager(mongoDb);
            this.userManager = new UserManager(mongoDb);
            this.authDatabase = new AuthDatabase(mongoDb);
            await Promise.all([
                this.database.init(),
                this.newsDatabase.init(),
                this.githubTrendingDatabase.init(),
                this.groupMemberDatabase.init(),
                this.warnDatabase.init(),
                this.morningDatabase.init(),
                this.groupManager.init(),
                this.authDatabase.init(),
            ]);
            await this.groupManager.initChannels();
            await this.groupManager.initPremium();
            await this.groupManager.initDynamicModerators();

            await shortLinkService.init(mongoDb);
            urlShortener.setService(shortLinkService);
            if (this.adminPanel) {
                this.adminPanel.setShortLinkService(shortLinkService);
            }

            this.botSettings = new BotSettings(mongoDb);
            await this.botSettings.init();
            pronoobDriveService.setSettings(this.botSettings);
            await pronoobDriveService.loadUrls();
            botState.isPaused = await this.botSettings.getCoursesPaused();
            if (botState.isPaused) {
                logger.info('⏸️ Course posting is PAUSED (restored from database)');
            }

            this.instanceLock = new InstanceLock(mongoDb, () => {
                void this.shutdown('Another instance took over');
            });
            await this.instanceLock.claim();
            
            // Set owner numbers from config
            this.groupManager.setOwnerNumbers(config.OWNER_NUMBERS);
            this.groupManager.setModeratorNumbers(config.MODERATOR_NUMBERS);
            logger.info(`👑 Loaded ${config.OWNER_NUMBERS.length} owner(s) from .env`);
            logger.info(`🛡️ Loaded ${config.MODERATOR_NUMBERS.length} moderator(s) from .env`);
            logger.info(`🔐 WhatsApp group admins are auto-detected per group for staff & admin commands`);

            const inshortsScraper = new InshortsScraper(this.newsDatabase);
            this.newsController = new NewsController(
                this.newsDatabase,
                inshortsScraper,
                config,
                this.groupManager
            );
            this.githubTrendingController = new GitHubTrendingController(
                config,
                this.groupManager,
                this.githubTrendingDatabase
            );
            this.memberScrapeController = new MemberScrapeController(
                this.groupMemberDatabase,
                this.userManager
            );
            this.movieController = new MovieController(mongoDb, this.groupManager);
            await this.movieController.init();
            
            this.stickerController = new StickerController(config);

            this.commandController = new CommandController(
                this.database,
                botState,
                this.groupManager,
                this.newsController,
                this.movieController,
                this.userManager,
                this.stickerController,
                this.botSettings,
                this.githubTrendingController,
                this.memberScrapeController,
                this.warnDatabase
            );
            this.courseController = new CourseController(this.database, this.courseAPI, config, this.groupManager);
            const morningScraper = new MorningMessageScraper(this.morningDatabase);
            this.morningController = new MorningMessageController(
                this.morningDatabase,
                morningScraper,
                config
            );

            // Initialize sticker forwarder if target groups are configured
            if (config.STICKER_TARGET_GROUPS.length > 0) {
                this.stickerForwarder = new StickerForwarder(
                    config.STICKER_TARGET_GROUPS,
                    config.STICKER_PACK_NAME,
                    config.STICKER_PACK_AUTHOR,
                    config.STICKER_SOURCE_CHANNELS
                );
                this.channelStickerPoller = new ChannelStickerPoller(this.stickerForwarder);
                const channelNote = config.STICKER_SOURCE_CHANNELS.length
                    ? `${config.STICKER_SOURCE_CHANNELS.length} channel(s)`
                    : 'all joined channels';
                logger.info(
                    `🎨 Sticker forwarding → ${config.STICKER_TARGET_GROUPS.length} group(s) | sources: groups + ${channelNote}`
                );
            }
            
            this.whatsappService = new WhatsAppService(
                this.commandController,
                this.stickerForwarder,
                this.authDatabase,
                this.groupManager,
                config.STICKER_SOURCE_CHANNELS,
                this.channelStickerPoller,
                this.userManager,
                this.adminPanel
            );
            
            // Give admin panel access to WhatsApp service for reconnect
            if (this.adminPanel) {
                this.adminPanel.setWhatsAppService(this.whatsappService);
            }
            
            // Connect to WhatsApp
            await this.whatsappService.connect();
            
            // Wait for connection to be ready
            await this.whatsappService.waitForReady();
            
            // Start log manager
            this.logManager.setSocket(this.whatsappService.getSock());
            this.logManager.start();
            
            const morningInfo = config.MORNING_MESSAGES_ENABLED && config.MORNING_MESSAGE_NUMBERS.length
                ? ` Morning msgs ${config.MORNING_MESSAGE_TIME_START}–${config.MORNING_MESSAGE_TIME_END} random (${config.MORNING_TIMEZONE}) to ${config.MORNING_MESSAGE_NUMBERS.length} number(s).`
                : '';
            const githubInfo = config.GITHUB_TRENDING_ENABLED
                ? ` GitHub trending (${config.GITHUB_TRENDING_COUNT} repos) at ${config.GITHUB_TRENDING_TIMES.join(', ')} (${config.GITHUB_TRENDING_TIMEZONE}).`
                : '';
            logger.info(
                `🤖 Bot is ready! Courses every ${config.CHECK_INTERVAL}s. Tech news at ${config.NEWS_POST_TIMES.join(', ')} (${config.NEWS_TIMEZONE}).${githubInfo}${morningInfo}`
            );

            const sock = this.whatsappService.getSock();
            if (this.movieController) {
                this.movieController.setSock(sock);
            }
            if (this.stickerController) this.stickerController.setConnectionProvider(this.whatsappService);
            this.commandController.setGetSock(() => this.whatsappService.getSock());

            await this.courseController.checkAndPostCourses(sock, botState);

            this.newsScheduler = startNewsScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                newsController: this.newsController,
                config,
            });

            this.githubScheduler = startGithubScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                githubController: this.githubTrendingController,
                config,
            });

            this.morningScheduler = startMorningScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                morningController: this.morningController,
                config,
            });

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

    async shutdown(reason = 'Shutdown signal') {
        if (this._isShuttingDown) return;
        this._isShuttingDown = true;

        logger.info(`👋 Shutting down (${reason})...`);

        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.newsScheduler) {
            this.newsScheduler.stop();
        }
        if (this.githubScheduler) {
            this.githubScheduler.stop();
        }
        if (this.morningScheduler) {
            this.morningScheduler.stop();
        }
        if (this.logManager) {
            this.logManager.stop();
        }
        if (this.whatsappService) {
            await this.whatsappService.disconnect();
        }
        if (this.instanceLock) {
            await this.instanceLock.release();
        }
        if (this.database) {
            this.database.close();
        }
        if (this.newsDatabase) {
            this.newsDatabase.close();
        }
        if (this.morningDatabase) {
            this.morningDatabase.close();
        }
        if (this.groupManager) {
            this.groupManager.close();
        }
        if (this.authDatabase) {
            this.authDatabase.close();
        }
        await closeMongo();
        process.exit(0);
    }
}

// ─── Start Bot ────────────────────────────────────────────────────────────────
const bot = new WhatsAppCourseBot();

// Start admin panel server (includes health check for Render)
const PORT = process.env.PORT || 3000;
bot.adminPanel = new AdminPanel(PORT);
bot.adminPanel.start();

// Handle graceful shutdown (Render sends SIGTERM on deploy)
process.on('SIGINT', () => {
    void bot.shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    void bot.shutdown('SIGTERM');
});

// Start the bot
bot.start().catch(err => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
