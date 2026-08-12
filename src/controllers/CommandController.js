/**
 * Command Controller — thin dispatcher
 * All handler logic lives in ./handlers/*
 */

import { checkCommandAccess } from '../commands/access.js';
import { findCommand, findSimilarCommands } from '../commands/registry.js';
import { logger } from '../utils/logger.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { extractPhoneNumber } from '../utils/permissions.js';
import { classifyOptMessage } from '../models/BroadcastOptOutStore.js';
import { getSafeSendOptions, safeSendMessage, plainSendMessage } from '../utils/waMessage.js';
import { botTelemetry } from '../utils/botTelemetry.js';

import {
    handlePing,
    handlePosted,
    handleClear,
    handleConfirm,
    handleCancel,
    handlePause,
    handleResume,
    handleStatus,
    handleFacts,
    handleHelp,
} from './handlers/coreHandlers.js';

import {
    handleActivate,
    handleDeactivate,
    handleInstaOn,
    handleInstaOff,
    handleStickerOn,
    handleStickerOff,
    handleNewsOn,
    handleNewsOff,
    handleCoursesOn,
    handleCoursesOff,
    handleGithubOn,
    handleGithubOff,
    handleAwesomeOn,
    handleAwesomeOff,
    handleGroups,
    handleSetWelcome,
    handleGroupParticipantsUpdate as _handleGroupParticipantsUpdate,
    handleJoinStubMessage as _handleJoinStubMessage,
    handleMovieOn,
    handleMovieOff,
    handleSummaryOn,
    handleSummaryOff,
    handleSummaryNow,
    handleTrending,
} from './handlers/groupHandlers.js';

import { handleTradelert, handleTradenow, handleSwing, handleExpiry, handleIndex } from './handlers/tradeHandlers.js';
import { handleHeal, handleFix } from './handlers/healHandlers.js';
import { handleAssist } from './handlers/assistHandlers.js';

import {
    handleAddAdmin,
    handleRemoveAdmin,
    handleAdmins,
    handleIncreaseLimit,
    handleCheckLimit,
} from './handlers/adminHandlers.js';

import {
    handleAddPremium,
    handleRemovePremium,
    handleListPremium,
    handleAddMod,
    handleRemoveMod,
    handleAddChannel,
    handleRemoveChannel,
    handleChannels,
} from './handlers/ownerHandlers.js';

import {
    handleInsta as _handleInsta,
    handleNews,
    handleGithub,
    handlePendingGithubConfirmation,
    createGithubPostSessionStore,
    handleAwesome,
    handlePendingAwesomeConfirmation,
    createAwesomePostSessionStore,
} from './handlers/instaHandlers.js';

import {
    handleScrap,
    handleScrapMembers,
    handleScrapClear,
    handleBroadcast,
    handleGroupPost,
    handlePendingScrapSelection,
    createScrapSessionStore,
} from './handlers/memberScrapeHandlers.js';

import { horoscopeService } from '../services/HoroscopeService.js';
import { adviceService } from '../services/AdviceService.js';
import { handleDriveUrl } from './handlers/driveHandlers.js';
import { handleViewOnce } from './handlers/viewOnceHandler.js';
import { handleDeploy } from './handlers/deployHandler.js';
import {
    handleWarn,
    handleMyWarns,
    handleWarns,
    handleClearWarns,
} from './handlers/warnHandlers.js';

import { handleDelLast } from './handlers/deleteHandlers.js';
import {
    handleCv,
    handleTailor,
    handleCover,
    handlePendingResumeInput,
    createResumeSessionStore,
} from './handlers/resumeHandlers.js';
import {
    handleInterviewQ,
    handleInterviewQOn,
    handleInterviewQOff,
} from '../interviewQuestion/interviewQuestion.commands.js';

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null, userManager = null, stickerController = null, botSettings = null, githubTrendingController = null, memberScrapeController = null, warnDatabase = null, authDatabase = null, courseAPI = null, awesomeListsController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.movieController = movieController;
        this.userManager = userManager;
        this.stickerController = stickerController;
        this.botSettings = botSettings;
        this.githubTrendingController = githubTrendingController;
        this.awesomeListsController = awesomeListsController;
        this.memberScrapeController = memberScrapeController;
        this.warnDatabase = warnDatabase;
        this.authDatabase = authDatabase;
        this.courseAPI = courseAPI;
        this.assistService = null;
        this.resumeStore = null;
        this.resumeTailorService = null;
        this.interviewQuestionService = null;
        this.pendingClearConfirmations = new Map();
        this.pendingScrapSessions = createScrapSessionStore();
        this.pendingGithubPosts = createGithubPostSessionStore();
        this.pendingAwesomePosts = createAwesomePostSessionStore();
        this.pendingResumeSessions = createResumeSessionStore();
        this.getSock = null;
        this.whatsappService = null;
        this.groupChatLogService = null;
        this.groupSummaryController = null;
        this.tradeAlertController = null;
        this.botStartTime = Date.now();
        this.stickerForwarder = null;

        this._isOwnerFromJid = this._isOwnerFromJid.bind(this);
    }

    setResumeTailor(resumeStore, resumeTailorService) {
        this.resumeStore = resumeStore;
        this.resumeTailorService = resumeTailorService;
    }

    setStickerForwarder(stickerForwarder) {
        this.stickerForwarder = stickerForwarder;
    }

    setWhatsAppService(whatsappService) {
        this.whatsappService = whatsappService;
    }

    setGroupChatLogService(groupChatLogService) {
        this.groupChatLogService = groupChatLogService;
    }

    setGroupSummaryController(groupSummaryController) {
        this.groupSummaryController = groupSummaryController;
    }

    setAssistService(assistService) {
        this.assistService = assistService;
    }

    setInterviewQuestionService(interviewQuestionService) {
        this.interviewQuestionService = interviewQuestionService;
    }

    setTradeAlertController(tradeAlertController) {
        this.tradeAlertController = tradeAlertController;
    }

    setBroadcastServices(broadcastService, broadcastOptOutStore) {
        this.broadcastService = broadcastService;
        this.broadcastOptOutStore = broadcastOptOutStore;
    }

    setGetSock(getSock) {
        this.getSock = getSock;
    }

    /**
     * Check if sender is owner — handles LID (Linked ID) resolution for privacy mode
     */
    async _isOwnerFromJid(sock, chatId, senderJid) {
        const directPhone = extractPhoneNumber(senderJid);
        if (this.groupManager.isOwner(directPhone)) return true;

        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                // O(1) via the cached phoneByKey index — this used to scan every
                // participant, which is 900+ iterations per command in big groups.
                const phone = await this.groupManager.resolveParticipantPhoneCached(
                    sock,
                    chatId,
                    senderJid
                );
                if (phone && this.groupManager.isOwner(phone)) return true;
            } catch {}
        }

        return false;
    }

    /** Shared context passed to every handler */
    _ctx() {
        return {
            database: this.database,
            botState: this.botState,
            groupManager: this.groupManager,
            newsController: this.newsController,
            githubTrendingController: this.githubTrendingController,
            awesomeListsController: this.awesomeListsController,
            memberScrapeController: this.memberScrapeController,
            broadcastService: this.broadcastService,
            broadcastOptOutStore: this.broadcastOptOutStore,
            warnDatabase: this.warnDatabase,
            movieController: this.movieController,
            userManager: this.userManager,
            stickerController: this.stickerController,
            stickerForwarder: this.stickerForwarder,
            botSettings: this.botSettings,
            authDatabase: this.authDatabase,
            pendingClearConfirmations: this.pendingClearConfirmations,
            pendingScrapSessions: this.pendingScrapSessions,
            pendingGithubPosts: this.pendingGithubPosts,
            pendingAwesomePosts: this.pendingAwesomePosts,
            pendingResumeSessions: this.pendingResumeSessions,
            resumeStore: this.resumeStore,
            resumeTailorService: this.resumeTailorService,
            getSock: this.getSock,
            whatsappService: this.whatsappService,
            groupChatLogService: this.groupChatLogService,
            groupSummaryController: this.groupSummaryController,
            tradeAlertController: this.tradeAlertController,
            assistService: this.assistService,
            interviewQuestionService: this.interviewQuestionService,
            botStartTime: this.botStartTime,
            courseAPI: this.courseAPI,
            isOwnerFromJid: this._isOwnerFromJid,
        };
    }

    /**
     * "STOP" in a DM removes someone from every future broadcast.
     *
     * Checked before anything else: a person asking not to be messaged must
     * not have that request swallowed by an unrelated pending session.
     */
    async _tryHandleBroadcastOptOut(sock, chatId, messageText, senderJid) {
        const store = this.broadcastOptOutStore;
        if (!store || !chatId?.endsWith('@s.whatsapp.net')) return false;

        const intent = classifyOptMessage(messageText);
        if (!intent) return false;

        const target = senderJid || chatId;
        if (intent === 'out') {
            await store.optOut(target, { reason: 'replied STOP', source: chatId });
            await sock.sendMessage(chatId, {
                text: '🚫 Done — you will not receive broadcast messages again.\n\n_Reply START if you change your mind._',
            }).catch(() => {});
            return true;
        }

        const restored = await store.optIn(target);
        if (restored) {
            await sock.sendMessage(chatId, { text: '✅ You will receive broadcasts again.' }).catch(() => {});
        }
        return restored;
    }

    async tryHandlePendingInput(sock, chatId, messageText, senderJid, originalMsg = null) {
        if (messageText?.trim()?.startsWith('/')) {
            return false;
        }

        if (await this._tryHandleBroadcastOptOut(sock, chatId, messageText, senderJid)) {
            return true;
        }

        const ctx = { ...this._ctx(), originalMsg };
        const handledResume = await handlePendingResumeInput(
            sock, chatId, senderJid, messageText || '', ctx,
        );
        if (handledResume) {
            return true;
        }

        if (!messageText?.trim()) {
            return false;
        }

        const handledGithub = await handlePendingGithubConfirmation(
            sock, chatId, senderJid, messageText.trim(), ctx,
        );
        if (handledGithub) {
            return true;
        }

        const handledAwesome = await handlePendingAwesomeConfirmation(
            sock, chatId, senderJid, messageText.trim(), ctx,
        );
        if (handledAwesome) {
            return true;
        }

        return handlePendingScrapSelection(sock, chatId, senderJid, messageText.trim(), ctx);
    }

    async handleGroupParticipantsUpdate(sock, update) {
        await _handleGroupParticipantsUpdate(sock, update, this._ctx());
    }

    async handleJoinStubMessage(sock, msg) {
        await _handleJoinStubMessage(sock, msg, this._ctx());
    }

    async handleInsta(sock, chatId, args, quotedMessage, options = {}) {
        await _handleInsta(sock, chatId, args, quotedMessage, options);
    }

    async handleCommand(sock, chatId, command, senderJid, originalMsg = null, pushName = '') {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (!cmd) return;

        try {
        const def = findCommand(cmd);
        if (!def) {
            // Show suggestions for unknown commands
            const suggestions = findSimilarCommands(cmd);
            if (suggestions.length > 0) {
                const suggestionText = suggestions.map(s => `  • \`${s}\``).join('\n');
                await sendAndDelete(sock, chatId, {
                    text: `❓ Unknown command: \`${cmd}\`\n\n💡 *Did you mean:*\n${suggestionText}\n\n_Type \`/help\` for all commands_\n_⏰ Auto-deletes in 5 hours_`
                }, originalMsg);
            }
                return;
        }

        logger.info(`📝 Command received: ${def.key} from ${senderJid} in ${chatId}`);

        const access = await checkCommandAccess(sock, chatId, senderJid, def, this.groupManager);
        if (!access.ok) {
            await safeSendMessage(sock, chatId, { text: access.message }, originalMsg);
                return;
            }

        const ctx = { ...this._ctx(), originalMsg, replyOpts: getSafeSendOptions(originalMsg), fullCommand: command.trim() };
        const t0 = Date.now();

        try {
        switch (def.key) {
            /* ── Core ── */
            case 'ping':     await handlePing(sock, chatId, ctx); break;
            case 'posted':   await handlePosted(sock, chatId, ctx); break;
            case 'clear':    await handleClear(sock, chatId, ctx); break;
            case 'confirm':  await handleConfirm(sock, chatId, ctx); break;
            case 'cancel':  await handleCancel(sock, chatId, senderJid, ctx); break;
            case 'pause':    await handlePause(sock, chatId, ctx); break;
            case 'resumecourses': await handleResume(sock, chatId, ctx); break;
            case 'status':   await handleStatus(sock, chatId, ctx); break;
            case 'facts':    await handleFacts(sock, chatId, ctx); break;
            case 'help':     await handleHelp(sock, chatId, senderJid, ctx); break;

            /* ── Group management ── */
            case 'activate':   await handleActivate(sock, chatId, senderJid, ctx); break;
            case 'deactivate': await handleDeactivate(sock, chatId, senderJid, ctx); break;
            case 'instaon':    await handleInstaOn(sock, chatId, senderJid, ctx); break;
            case 'instaoff':   await handleInstaOff(sock, chatId, senderJid, ctx); break;
            case 'stickeron':  await handleStickerOn(sock, chatId, senderJid, ctx); break;
            case 'stickeroff': await handleStickerOff(sock, chatId, senderJid, ctx); break;
            case 'newson':     await handleNewsOn(sock, chatId, senderJid, ctx); break;
            case 'newsoff':    await handleNewsOff(sock, chatId, senderJid, ctx); break;
            case 'courson':
            case 'courseson':  await handleCoursesOn(sock, chatId, senderJid, ctx); break;
            case 'coursesoff':
            case 'courseoff':  await handleCoursesOff(sock, chatId, senderJid, ctx); break;
            case 'githubon':   await handleGithubOn(sock, chatId, senderJid, ctx); break;
            case 'githuboff':  await handleGithubOff(sock, chatId, senderJid, ctx); break;
            case 'awesomeon':  await handleAwesomeOn(sock, chatId, senderJid, ctx); break;
            case 'awesomeoff': await handleAwesomeOff(sock, chatId, senderJid, ctx); break;
            case 'interviewqon':  await handleInterviewQOn(sock, chatId, senderJid, ctx); break;
            case 'interviewqoff': await handleInterviewQOff(sock, chatId, senderJid, ctx); break;
            case 'interviewq': await handleInterviewQ(sock, chatId, senderJid, args, ctx); break;
            case 'groups':     await handleGroups(sock, chatId, senderJid, ctx); break;
            case 'setwc':      await handleSetWelcome(sock, chatId, senderJid, command.trim(), ctx); break;
            case 'warn':       await handleWarn(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'mywarns':    await handleMyWarns(sock, chatId, senderJid, ctx); break;
            case 'warns':      await handleWarns(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'clearwarns': await handleClearWarns(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'dellast':
            case 'delall':
                await handleDelLast(sock, chatId, args, originalMsg, ctx);
                break;
            case 'movieon':    await handleMovieOn(sock, chatId, senderJid, ctx); break;
            case 'movieoff':   await handleMovieOff(sock, chatId, senderJid, ctx); break;
            case 'summaryon':  await handleSummaryOn(sock, chatId, senderJid, ctx); break;
            case 'summaryoff': await handleSummaryOff(sock, chatId, senderJid, ctx); break;
            case 'summarynow': await handleSummaryNow(sock, chatId, senderJid, ctx); break;
            case 'fix':        await handleFix(sock, chatId, senderJid, args, ctx); break;
            case 'heal':       await handleHeal(sock, chatId, senderJid, args, ctx); break;
            case 'assist':     await handleAssist(sock, chatId, senderJid, args, ctx); break;
            case 'resume':     await handleCv(sock, chatId, senderJid, args, ctx); break;
            case 'tailor':     await handleTailor(sock, chatId, senderJid, args, ctx); break;
            case 'cover':      await handleCover(sock, chatId, senderJid, args, ctx); break;
            case 'trending':   await handleTrending(sock, chatId, senderJid, args, ctx); break;
            case 'tradelert':  await handleTradelert(sock, chatId, senderJid, args, ctx); break;
            case 'tradenow':   await handleTradenow(sock, chatId, senderJid, args, ctx); break;
            case 'index':      await handleIndex(sock, chatId, senderJid, args, ctx); break;
            case 'swing':      await handleSwing(sock, chatId, senderJid, args, ctx); break;
            case 'expiry':     await handleExpiry(sock, chatId, senderJid, args, ctx); break;

            /* ── Admin management ── */
            case 'addadmin':    await handleAddAdmin(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'removeadmin': await handleRemoveAdmin(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'admins':      await handleAdmins(sock, chatId, senderJid, ctx); break;
            case 'increaselimit': await handleIncreaseLimit(sock, chatId, senderJid, args, originalMsg, ctx); break;
            case 'checklimit': await handleCheckLimit(sock, chatId, senderJid, args, originalMsg, pushName, ctx); break;

            /* ── Owner: premium / mod / channels ── */
            case 'addpremium':    await handleAddPremium(sock, chatId, senderJid, args, ctx); break;
            case 'removepremium': await handleRemovePremium(sock, chatId, senderJid, args, ctx); break;
            case 'premium':       await handleListPremium(sock, chatId, senderJid, ctx); break;
            case 'addmod':        await handleAddMod(sock, chatId, senderJid, args, ctx); break;
            case 'removemod':     await handleRemoveMod(sock, chatId, senderJid, args, ctx); break;
            case 'addchannel':    await handleAddChannel(sock, chatId, args, senderJid, ctx); break;
            case 'removechannel': await handleRemoveChannel(sock, chatId, args, senderJid, ctx); break;
            case 'channels':      await handleChannels(sock, chatId, senderJid, ctx); break;
            case 'scrap':         await handleScrap(sock, chatId, senderJid, args, ctx); break;
            case 'scrapmembers':  await handleScrapMembers(sock, chatId, senderJid, ctx); break;
            case 'scrapclear':    await handleScrapClear(sock, chatId, senderJid, args, ctx); break;
            case 'broadcast':     void handleBroadcast(sock, chatId, senderJid, args, ctx).catch((err) => {
                logger.error(`Broadcast handler error: ${err?.message || err?.output?.payload?.message || String(err)}`);
            }); break;
            case 'grouppost':     await handleGroupPost(sock, chatId, senderJid, args, ctx); break;
            case 'driveurl':      await handleDriveUrl(sock, chatId, senderJid, args, ctx); break;
            case 'viewonce':      await handleViewOnce(sock, chatId, senderJid, originalMsg); break;
            case 'deploy':        await handleDeploy(sock, chatId, senderJid, originalMsg); break;

            /* ── Instagram / News / Movie ── */
            case 'insta': await _handleInsta(sock, chatId, args, originalMsg); break;
            case 'news':  await handleNews(sock, chatId, senderJid, ctx); break;
            case 'github': await handleGithub(sock, chatId, senderJid, ctx); break;
            case 'awesome': await handleAwesome(sock, chatId, senderJid, ctx); break;
            case 'horo':
                try {
                    const sign = args[0];
                    if (!sign) {
                        const listMsg = horoscopeService.getSignsList();
                        await safeSendMessage(sock, chatId, { text: listMsg }, originalMsg);
                    } else {
                        const data = await horoscopeService.fetchHoroscope(sign);
                        if (data.error === 'api_error') {
                            ctx.groupSummaryController?.selfHeal?.triggerFromHoroscopeFailure({
                                sign,
                                errorMessage: 'All horoscope API sources failed',
                                chatId,
                                diagnostics: data.diagnostics,
                            });
                        }
                        const msg = horoscopeService.formatMessage(data);
                        await safeSendMessage(sock, chatId, { text: msg }, originalMsg);
                    }
                } catch (err) {
                    logger.error('Horoscope command error:', err);
                    ctx.groupSummaryController?.selfHeal?.triggerFromHoroscopeFailure({
                        sign: args[0],
                        errorMessage: err.message,
                        chatId,
                    });
                    await safeSendMessage(sock, chatId, { text: '⚠️ Failed to fetch horoscope. Please try again.' }, originalMsg);
                }
                break;
            case 'advice':
                try {
                    const slip = await adviceService.fetchAdvice();
                    await safeSendMessage(sock, chatId, { text: adviceService.formatMessage(slip) }, originalMsg);
                } catch (err) {
                    logger.error('Advice command error:', err);
                    await safeSendMessage(sock, chatId, { text: adviceService.formatError() }, originalMsg);
                }
                break;
            case 'movie':
                if (!this.movieController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Movie search is not available.' }, originalMsg);
                } else {
                    void this.movieController.handleMovieSearch(sock, chatId, senderJid, args, pushName, originalMsg)
                        .catch((err) => {
                            logger.error(`Movie search handler error: ${err?.message || err}`);
                        });
                }
                break;
            case 'upcoming':
                if (!this.movieController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
                } else {
                    void this.movieController.handleUpcoming(sock, chatId, senderJid, originalMsg)
                        .catch((err) => logger.error(`Upcoming handler error: ${err?.message || err}`));
                }
                break;
            case 'genre':
                if (!this.movieController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
                } else {
                    void this.movieController.handleGenre(sock, chatId, senderJid, args, originalMsg)
                        .catch((err) => logger.error(`Genre handler error: ${err?.message || err}`));
                }
                break;

            /* ── Sticker Commands (non-blocking — FFmpeg runs in background queue) ── */
            case 'sticker':
                if (!this.stickerController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
                } else {
                    void this.stickerController.handleSticker(sock, chatId, originalMsg, args, command).catch((err) => {
                        logger.error('Sticker command error:', err);
                        void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process sticker command.' }, originalMsg);
                    });
                }
                break;
            case 'steal':
                if (!this.stickerController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
                } else {
                    void this.stickerController.handleSteal(sock, chatId, originalMsg, args, command).catch((err) => {
                        logger.error('Steal command error:', err);
                        void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process steal command.' }, originalMsg);
                    });
                }
                break;
            case 'toimg':
                if (!this.stickerController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
                } else {
                    void this.stickerController.handleToImage(sock, chatId, originalMsg).catch((err) => {
                        logger.error('ToImage command error:', err);
                        void safeSendMessage(sock, chatId, { text: '⚠️ Failed to convert sticker to image.' }, originalMsg);
                    });
                }
                break;
            case 'rgb':
                if (!this.stickerController) {
                    await safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
                } else {
                    void this.stickerController.handleRgbSticker(sock, chatId, args, originalMsg).catch((err) => {
                        logger.error('RGB sticker error:', err);
                        void safeSendMessage(sock, chatId, { text: '⚠️ Failed to generate RGB sticker.' }, originalMsg);
                    });
                }
                break;

            default: break;
        }
            botTelemetry.track('command', {
                cmd: def.key,
                chatId,
                status: 'ok',
                ms: Date.now() - t0,
            });
        } catch (err) {
            botTelemetry.track('command', {
                cmd: def.key,
                chatId,
                status: 'err',
                ms: Date.now() - t0,
                message: String(err?.message || err).slice(0, 160),
            });
            logger.error(`Command handler error (${cmd}): ${err?.message || err}`);
            logger.error(err?.stack);
            await plainSendMessage(sock, chatId, {
                text: '⚠️ Something went wrong running that command. Please try again.',
            }, originalMsg?.key);
        }
        } catch (err) {
            logger.error(`Command dispatch error (${cmd}): ${err?.message || err}`);
        }
    }
}

export default CommandController;
