/**
 * WhatsApp Course Bot — MVC Edition
 * Main entry point for the bot
 */

import { config } from './src/config/config.js';
import { closeMongo, connectMongo } from './src/db/mongo.js';
import { logger } from './src/utils/logger.js';
import AdminPanel from './src/utils/adminPanel.js';
import { botTelemetry } from './src/utils/botTelemetry.js';
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
import { startAwesomeScheduler } from './src/utils/awesomeScheduler.js';
import { startMorningScheduler } from './src/utils/morningScheduler.js';
import MorningMessageDatabase from './src/models/MorningMessageDatabase.js';
import MorningMessageScraper from './src/services/MorningMessageScraper.js';
import MorningMessageController from './src/controllers/MorningMessageController.js';
import MovieController from './src/controllers/MovieController.js';
import GitHubTrendingController from './src/controllers/GitHubTrendingController.js';
import GitHubTrendingDatabase from './src/models/GitHubTrendingDatabase.js';
import AwesomeListsController from './src/controllers/AwesomeListsController.js';
import AwesomeListsDatabase from './src/models/AwesomeListsDatabase.js';
import InterviewQuestionStore from './src/interviewQuestion/interviewQuestion.storage.js';
import InterviewQuestionService from './src/interviewQuestion/interviewQuestion.service.js';
import { startInterviewQuestionScheduler } from './src/interviewQuestion/interviewQuestion.scheduler.js';
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
import GroupChatLogService from './src/services/GroupChatLogService.js';
import GroupSummaryController from './src/controllers/GroupSummaryController.js';
import AssistService from './src/services/AssistService.js';
import ResumeProfileStore from './src/models/ResumeProfileStore.js';
import ResumeTailorService from './src/services/ResumeTailorService.js';
import { startGroupSummaryScheduler } from './src/utils/groupSummaryScheduler.js';
import TradeAlertController from './src/controllers/TradeAlertController.js';
import { startTradeAlertScheduler } from './src/utils/tradeAlertScheduler.js';
import { startExpiryAlertScheduler } from './src/utils/expiryAlertScheduler.js';
import ExpiryTradeService from './src/services/ExpiryTradeService.js';
import { formatExpiryDigest } from './src/utils/expiryAlertFormatter.js';
import { deployNotificationService } from './src/services/DeployNotificationService.js';
import { createJobQueue, startJobRuntime } from './src/jobs/index.js';

// Bot state
const botState = {
    isPaused: false,
    skipCourseBacklogOnce: false,
    coursePauseSnapshotIds: null,
    lastCheckTime: null,
    lastNewsCheckTime: null,
    lastNewsPostSlot: null,
    lastMorningPostSlot: null,
    lastGithubPostSlot: null,
    lastGithubPostSlots: {},
    lastGithubCheckTime: null,
    githubTrendingCache: null,
    lastAwesomePostSlots: {},
    lastInterviewQSlots: {},
    lastGroupSummarySlot: null,
    lastTradeAlertSlot: null,
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
        this.awesomeScheduler = null;
        this.interviewQScheduler = null;
        this.morningScheduler = null;
        this.groupSummaryScheduler = null;
        this.groupChatLogService = null;
        this.groupSummaryController = null;
        this.tradeAlertController = null;
        this.tradeAlertScheduler = null;
        this.expiryAlertScheduler = null;
        this.expiryTradeService = null;
        this.jobQueue = null;
        this.jobRuntime = null;
        this.morningDatabase = null;
        this.stickerController = null;
        this.adminPanel = null;
        this.instanceLock = null;
        this.botSettings = null;
        this.assistService = null;
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
            this.awesomeListsDatabase = new AwesomeListsDatabase(mongoDb);
            this.interviewQuestionStore = new InterviewQuestionStore(mongoDb);
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
                this.awesomeListsDatabase.init(),
                this.interviewQuestionStore.init(),
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
            await botTelemetry.init(mongoDb);
            this.jobQueue = await createJobQueue(mongoDb);
            if (this.adminPanel) {
                this.adminPanel.setShortLinkService(shortLinkService);
                this.adminPanel.setDashboardContext({
                    mongoDb,
                    groupManager: this.groupManager,
                    botState,
                    jobQueue: this.jobQueue,
                });
            }

            this.botSettings = new BotSettings(mongoDb);
            await this.botSettings.init();
            deployNotificationService.init(mongoDb);
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
            this.awesomeListsController = new AwesomeListsController(
                config,
                this.groupManager,
                this.awesomeListsDatabase
            );
            this.interviewQuestionService = new InterviewQuestionService({
                store: this.interviewQuestionStore,
                groupManager: this.groupManager,
                cfg: config,
            });
            this.memberScrapeController = new MemberScrapeController(
                this.groupMemberDatabase,
                this.userManager
            );
            this.movieController = new MovieController(mongoDb, this.groupManager);
            await this.movieController.init();

            this.groupChatLogService = new GroupChatLogService(mongoDb, this.groupManager, config);
            await this.groupChatLogService.init();
            this.groupSummaryController = new GroupSummaryController(
                this.groupChatLogService,
                this.groupManager,
                config,
                mongoDb
            );
            await this.groupSummaryController.init();

            this.assistService = new AssistService(config, this.botSettings, this.groupManager, mongoDb);
            await this.assistService.init();
            this.resumeStore = new ResumeProfileStore(mongoDb);
            await this.resumeStore.init();
            this.resumeTailorService = new ResumeTailorService(config, this.resumeStore);

            this.tradeAlertController = new TradeAlertController(
                this.groupManager,
                config,
                mongoDb
            );
            await this.tradeAlertController.init();
            
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
                this.warnDatabase,
                this.authDatabase,
                this.courseAPI,
                this.awesomeListsController
            );
            this.commandController.setInterviewQuestionService(this.interviewQuestionService);
            this.courseController = new CourseController(
                this.database,
                this.courseAPI,
                config,
                this.groupManager,
                this.botSettings
            );
            const morningScraper = new MorningMessageScraper(this.morningDatabase);
            this.morningController = new MorningMessageController(
                this.morningDatabase,
                morningScraper,
                config
            );

            // Sticker forwarder (channels/groups → target groups with /stickeron)
            this.stickerForwarder = new StickerForwarder({
                groupManager: this.groupManager,
                envTargetGroups: config.STICKER_TARGET_GROUPS,
                packName: config.STICKER_PACK_NAME,
                packAuthor: config.STICKER_PACK_AUTHOR,
                sourceChannels: config.STICKER_SOURCE_CHANNELS,
                concurrency: config.STICKER_FORWARD_CONCURRENCY,
                interSendDelayMs: config.STICKER_INTER_SEND_DELAY_MS,
            });
            await this.groupManager.ensureStickerTargetsFromEnv(config.STICKER_TARGET_GROUPS);
            this.stickerForwarder.startBackgroundWorkers();
            this.channelStickerPoller = new ChannelStickerPoller(this.stickerForwarder);
            const channelNote = config.STICKER_SOURCE_CHANNELS.length
                ? `${config.STICKER_SOURCE_CHANNELS.length} channel(s)`
                : 'all joined channels';
            const targetNote = config.STICKER_TARGET_GROUPS.length
                ? `${config.STICKER_TARGET_GROUPS.length} env target(s)`
                : 'use /stickeron in groups';
            logger.info(
                `🎨 Sticker forwarding | targets: ${targetNote} | sources: groups + ${channelNote} | ` +
                    `${config.STICKER_FORWARD_CONCURRENCY} parallel workers`
            );
            this.commandController.setStickerForwarder(this.stickerForwarder);
            this.commandController.setGroupChatLogService(this.groupChatLogService);
            this.commandController.setGroupSummaryController(this.groupSummaryController);
            this.commandController.setTradeAlertController(this.tradeAlertController);
            this.commandController.setAssistService(this.assistService);
            this.commandController.setResumeTailor(this.resumeStore, this.resumeTailorService);
            
            this.whatsappService = new WhatsAppService(
                this.commandController,
                this.stickerForwarder,
                this.authDatabase,
                this.groupManager,
                config.STICKER_SOURCE_CHANNELS,
                this.channelStickerPoller,
                this.userManager,
                this.adminPanel,
                this.groupChatLogService,
                this.assistService
            );
            this.commandController.setWhatsAppService(this.whatsappService);
            
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
            const awesomeInfo = config.AWESOME_LISTS_ENABLED
                ? ` Awesome lists (1 random/slot) at ${config.AWESOME_LISTS_TIMES.join(', ')} (${config.AWESOME_LISTS_TIMEZONE}).`
                : '';
            const interviewInfo = config.INTERVIEW_Q_ENABLED
                ? ` Interview Q at ${config.INTERVIEW_Q_TIMES.join(', ')} (${config.INTERVIEW_Q_TIMEZONE}).`
                : '';
            logger.info(
                `🤖 Bot is ready! Courses every ${config.CHECK_INTERVAL}s. Tech news at ${config.NEWS_POST_TIMES.join(', ')} (${config.NEWS_TIMEZONE}).${githubInfo}${awesomeInfo}${interviewInfo}${morningInfo}`
            );

            const sock = this.whatsappService.getSock();
            await deployNotificationService.completePendingOnStartup(sock);
            if (this.movieController) {
                this.movieController.setSock(sock);
            }
            if (this.groupSummaryController) {
                this.groupSummaryController.setSock(sock);
            }
            if (this.tradeAlertController) {
                this.tradeAlertController.setSock(sock);
            }
            if (this.stickerController) this.stickerController.setConnectionProvider(this.whatsappService);
            this.commandController.setGetSock(() => this.whatsappService.getSock());
            this.interviewQuestionService.setGetSock(() => this.whatsappService.getSock());

            this.jobRuntime = startJobRuntime({
                queue: this.jobQueue,
                concurrency: config.JOB_WORKER_CONCURRENCY,
                handlers: {
                    'trade.daily_alerts': async () => {
                        const sock = this.whatsappService?.getSock?.();
                        if (!sock) throw new Error('WhatsApp not ready for trade.daily_alerts');
                        await this.tradeAlertController.postDailyAlerts(sock);
                    },
                    'news.scrape': async () => {
                        await this.newsController.scrapeAndQueueOnly();
                    },
                },
            });

            await this.courseController.checkAndPostCourses(sock, botState);

            this.newsScheduler = startNewsScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                newsController: this.newsController,
                config,
                botSettings: this.botSettings,
                jobQueue: this.jobQueue,
            });

            this.githubScheduler = startGithubScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                githubController: this.githubTrendingController,
                config,
            });

            this.awesomeScheduler = startAwesomeScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                awesomeController: this.awesomeListsController,
                config,
                botSettings: this.botSettings,
            });

            this.interviewQScheduler = startInterviewQuestionScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                service: this.interviewQuestionService,
                config,
            });

            this.morningScheduler = startMorningScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                morningController: this.morningController,
                config,
                botSettings: this.botSettings,
            });

            this.groupSummaryScheduler = startGroupSummaryScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                groupSummaryController: this.groupSummaryController,
                config,
                botSettings: this.botSettings,
            });

            this.tradeAlertScheduler = startTradeAlertScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                tradeAlertController: this.tradeAlertController,
                config,
                botSettings: this.botSettings,
                jobQueue: this.jobQueue,
            });

            // Expiry-day option alerts — two slots, quiet on non-expiry days.
            this.expiryTradeService = new ExpiryTradeService(config);
            this.expiryAlertScheduler = startExpiryAlertScheduler({
                getSock: () => this.whatsappService.getSock(),
                botState,
                config,
                botSettings: this.botSettings,
                postExpiryAlerts: async (sock, slot) => {
                    const groups = await this.groupManager.getTradeAlertGroups();
                    if (!groups.length) {
                        logger.info('Expiry alert: no trade-alert groups enabled');
                        return;
                    }
                    const digest = await this.expiryTradeService.analyzeAllExpiring({ slot });
                    if (!digest.results.length) {
                        logger.warn('Expiry alert: no chain data, nothing posted');
                        return;
                    }
                    const text = formatExpiryDigest(digest, { slot });
                    for (const g of groups) {
                        const chatId = g.group_id || g.groupId || g;
                        try {
                            await sock.sendMessage(chatId, { text });
                        } catch (err) {
                            logger.warn(`Expiry alert post failed for ${chatId}: ${err.message}`);
                        }
                    }
                    logger.info(`📅 Expiry ${slot} alerts posted to ${groups.length} group(s)`);
                },
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
        if (this.awesomeScheduler) {
            this.awesomeScheduler.stop();
        }
        if (this.interviewQScheduler) {
            this.interviewQScheduler.stop();
        }
        if (this.morningScheduler) {
            this.morningScheduler.stop();
        }
        if (this.groupSummaryScheduler) {
            this.groupSummaryScheduler.stop();
        }
        if (this.tradeAlertScheduler) {
            this.tradeAlertScheduler.stop();
        }
        if (this.expiryAlertScheduler) {
            this.expiryAlertScheduler.stop();
        }
        if (this.jobRuntime?.stop) {
            await Promise.resolve(this.jobRuntime.stop()).catch(() => {});
            this.jobRuntime = null;
        }
        if (this.jobQueue?.close) {
            await this.jobQueue.close().catch(() => {});
        }
        if (this.groupChatLogService) {
            this.groupChatLogService.stop();
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

// Bind Render PORT on 0.0.0.0 immediately
const PORT = process.env.PORT || 3000;
bot.adminPanel = new AdminPanel(PORT);
bot.adminPanel.start();

async function boot() {
    process.on('SIGINT', () => {
        void bot.shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        void bot.shutdown('SIGTERM');
    });

    await bot.start();
}

boot().catch((err) => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
