/**
 * Command Controller — thin dispatcher
 * All handler logic lives in ./handlers/*
 */

import { checkCommandAccess } from '../commands/access.js';
import { findCommand, findSimilarCommands } from '../commands/registry.js';
import { logger } from '../utils/logger.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { extractPhoneNumber } from '../utils/permissions.js';
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
    handleGroupLink,
    handleRevokeLink,
} from './handlers/groupHandlers.js';

import { handleTradelert, handleTradenow, handleSwing, handleExpiry, handleIndex, handleSvmkr, handleChainAi } from './handlers/tradeHandlers.js';
import { handleHeal, handleFix } from './handlers/healHandlers.js';
import { handleAssist } from './handlers/assistHandlers.js';
import IpoController from './IpoController.js';
import BacktestController from './BacktestController.js';
import { telegramStickerService, abortImport, isImportActive, activeImports } from '../services/TelegramStickerService.js';

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
    handleTwitter,
    handleNews,
    handleGithub,
    handlePendingGithubConfirmation,
    createGithubPostSessionStore,
    handleAwesome,
    handlePendingAwesomeConfirmation,
    createAwesomePostSessionStore,
} from './handlers/instaHandlers.js';

import { handleGroupPost } from './handlers/groupPostHandlers.js';

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

/**
 * Import a Telegram sticker pack and send as WhatsApp stickers.
 * Supports abort via /tgstop. Handles static, animated (TGS→animated WebP), and video (MP4) stickers.
 */
async function handleTgStickers(sock, chatId, args, quotedMessage) {
    if (!telegramStickerService.isConfigured) {
        await safeSendMessage(sock, chatId, {
            text: '❌ Telegram Bot token not configured.\nSet `TELEGRAM_BOT_TOKEN` in .env (create a bot via @BotFather on Telegram).',
        }, quotedMessage);
        return;
    }

    if (!args.length) {
        await safeSendMessage(sock, chatId, {
            text:
                '🎭 *Import Telegram Stickers*\n\n' +
                'Usage: `/tgstickers <pack-name-or-url>`\n\n' +
                '*Examples:*\n' +
                '• `/tgstickers PupperStickers`\n' +
                '• `/tgstickers https://t.me/addstickers/PupperStickers`\n\n' +
                '*Types supported:*\n' +
                '• Static (WebP) — resized + compressed\n' +
                '• Animated (TGS) — rendered as animated sticker\n' +
                '• Video (MP4) — sent as WhatsApp video sticker\n\n' +
                '_Send `/tgstop` to cancel import at any time._',
        }, quotedMessage);
        return;
    }

    if (isImportActive(chatId)) {
        await safeSendMessage(sock, chatId, {
            text: '⚠️ An import is already running. Send `/tgstop` to cancel it first.',
        }, quotedMessage);
        return;
    }

    const input = args.join(' ');
    const packName = telegramStickerService.parsePackInput(input);
    if (!packName) {
        await safeSendMessage(sock, chatId, {
            text: '❌ Could not parse pack name. Use `/tgstickers <t.me/addstickers/PackName>` or just `/tgstickers PackName`.',
        }, quotedMessage);
        return;
    }

    let statusMsg = null;
    const abortController = new AbortController();
    const { signal } = abortController;
    const chatKey = String(chatId);
    activeImports.set(chatKey, abortController);

    try {
        const { createProgressBar } = await import('../utils/progressBar.js');
        const { editMessageText } = await import('../utils/waMessage.js');

        const updateProgress = async (text) => {
            if (statusMsg?.key) {
                try { await editMessageText(sock, chatId, statusMsg.key, text); } catch {}
            }
        };

        statusMsg = await safeSendMessage(sock, chatId, {
            text: `🎭 *Importing Telegram Stickers*\n\n📡 Fetching pack: *${packName}*…\n_Send /tgstop to cancel._`,
        }, quotedMessage);

        const pack = await telegramStickerService.getStickerSet(packName);
        const total = pack.stickers?.length || 0;

        const counts = { static: 0, animated: 0, video: 0 };
        for (const s of (pack.stickers || [])) {
            if (s.is_video) counts.video++;
            else if (s.is_animated) counts.animated++;
            else counts.static++;
        }
        const typeBreakdown = [];
        if (counts.static) typeBreakdown.push(`${counts.static} static`);
        if (counts.animated) typeBreakdown.push(`${counts.animated} animated`);
        if (counts.video) typeBreakdown.push(`${counts.video} video`);

        await updateProgress(
            `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}* — ${total} sticker(s)\n` +
            `_Types: ${typeBreakdown.join(', ') || 'unknown'}_\n\n` +
            `${createProgressBar(0)} 0/${total}\n⏳ Preparing downloads…\n\n_Send /tgstop to cancel._`
        );

        if (!total) {
            await updateProgress(`❌ Empty sticker pack: *${packName}*`);
            return;
        }

        const { stickers, errors } = await telegramStickerService.fetchAndConvertPack(
            packName,
            async (converted, failed, phase) => {
                if (signal.aborted) return;
                const pct = Math.round(((converted + failed) / total) * 100);
                const bar = createProgressBar(pct);
                await updateProgress(
                    `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}*\n` +
                    `\n${bar} ${converted + failed}/${total}\n🔄 Processing… ${converted + failed}/${total}\n\n_Send /tgstop to cancel._`
                );
            },
            signal
        );

        if (signal.aborted) {
            await updateProgress(`🛑 *Import cancelled.*\n_Sent 0 sticker(s) before cancellation._`);
            return;
        }

        if (!stickers.length) {
            const reasons = [];
            if (errors?.length) reasons.push(`${errors.length} failed`);
            await updateProgress(`❌ No stickers converted from *${pack.title || packName}*.*\n${reasons.join('\n') || 'Empty pack.'}`);
            return;
        }

        let sent = 0;
        let sendFailed = 0;
        let videoSent = 0;
        for (let i = 0; i < stickers.length; i++) {
            if (signal.aborted) {
                await updateProgress(`🛑 *Import cancelled mid-send.*\n_Sent ${sent}/${stickers.length} stickers._`);
                return;
            }

            const sticker = stickers[i];
            try {
                // All stickers (static, animated WebP, MP4 video) sent as sticker type
                const stickerMsg = { sticker: sticker.buffer };
                if (sticker.isAnimated) {
                    stickerMsg.isAnimated = true;
                }
                await sock.sendMessage(chatId, stickerMsg, { quoted: quotedMessage });
                if (sticker.type === 'video') videoSent++;
                sent++;
            } catch (err) {
                sendFailed++;
                logger.warn(`Failed to send sticker ${sticker.emoji}: ${err.message}`);
            }

            const pct = Math.round(((i + 1) / stickers.length) * 100);
            const bar = createProgressBar(pct);
            await updateProgress(
                `🎭 *Importing Telegram Stickers*\n\n📦 *${pack.title || packName}*\n` +
                `\n${bar} ${i + 1}/${stickers.length}\n` +
                `📤 Sending… ${sent} sent${sendFailed ? `, ${sendFailed} failed` : ''}` +
                (videoSent ? ` · ${videoSent} video` : '') +
                `\n\n_Send /tgstop to cancel._`
            );

            await new Promise((r) => setTimeout(r, sticker.type === 'video' ? 500 : 300));
        }

        const parts = [`✅ *${pack.title || packName}* — sent *${sent}* sticker(s)`];
        if (videoSent) parts.push(`📹 ${videoSent} video stickers`);
        if (sendFailed) parts.push(`❌ ${sendFailed} failed to send`);
        if (errors?.length) parts.push(`⚠️ ${errors.length} conversion errors`);
        parts.push(`\n_Pack: ${sent}/${total} stickers sent_`);

        await updateProgress(parts.join('\n'));
        logger.info(`TG sticker pack imported: ${packName} — ${sent} sent, ${sendFailed} failed, ${videoSent} video`);
    } catch (err) {
        logger.error(`TG stickers error: ${err.message}`);
        await safeSendMessage(sock, chatId, {
            text: `❌ Failed to import stickers: ${err.message}`,
        }, quotedMessage);
    } finally {
        activeImports.delete(chatKey);
    }
}

/**
 * Data-driven dispatch table — command key (from the registry) -> handler.
 *
 * Every handler receives one params object:
 *   { sock, chatId, senderJid, args, originalMsg, pushName, ctx, fullCommand }
 * and returns a promise (or void). A registered key with NO entry here fails
 * loudly at dispatch time instead of silently no-oping — adding a command now
 * means adding one registry entry + one table entry, nothing else.
 */
export const COMMAND_HANDLERS = {
    /* ── Core ── */
    ping: ({ sock, chatId, ctx }) => handlePing(sock, chatId, ctx),
    posted: ({ sock, chatId, ctx }) => handlePosted(sock, chatId, ctx),
    clear: ({ sock, chatId, ctx }) => handleClear(sock, chatId, ctx),
    confirm: ({ sock, chatId, ctx }) => handleConfirm(sock, chatId, ctx),
    cancel: ({ sock, chatId, senderJid, ctx }) => handleCancel(sock, chatId, senderJid, ctx),
    pause: ({ sock, chatId, ctx }) => handlePause(sock, chatId, ctx),
    resumecourses: ({ sock, chatId, ctx }) => handleResume(sock, chatId, ctx),
    status: ({ sock, chatId, ctx }) => handleStatus(sock, chatId, ctx),
    facts: ({ sock, chatId, ctx }) => handleFacts(sock, chatId, ctx),
    help: ({ sock, chatId, senderJid, ctx }) => handleHelp(sock, chatId, senderJid, ctx),

    /* ── Group management ── */
    activate: ({ sock, chatId, senderJid, ctx }) => handleActivate(sock, chatId, senderJid, ctx),
    deactivate: ({ sock, chatId, senderJid, ctx }) => handleDeactivate(sock, chatId, senderJid, ctx),
    instaon: ({ sock, chatId, senderJid, ctx }) => handleInstaOn(sock, chatId, senderJid, ctx),
    instaoff: ({ sock, chatId, senderJid, ctx }) => handleInstaOff(sock, chatId, senderJid, ctx),
    stickeron: ({ sock, chatId, senderJid, ctx }) => handleStickerOn(sock, chatId, senderJid, ctx),
    stickeroff: ({ sock, chatId, senderJid, ctx }) => handleStickerOff(sock, chatId, senderJid, ctx),
    newson: ({ sock, chatId, senderJid, ctx }) => handleNewsOn(sock, chatId, senderJid, ctx),
    newsoff: ({ sock, chatId, senderJid, ctx }) => handleNewsOff(sock, chatId, senderJid, ctx),
    courson: ({ sock, chatId, senderJid, ctx }) => handleCoursesOn(sock, chatId, senderJid, ctx),
    coursesoff: ({ sock, chatId, senderJid, ctx }) => handleCoursesOff(sock, chatId, senderJid, ctx),
    githubon: ({ sock, chatId, senderJid, ctx }) => handleGithubOn(sock, chatId, senderJid, ctx),
    githuboff: ({ sock, chatId, senderJid, ctx }) => handleGithubOff(sock, chatId, senderJid, ctx),
    awesomeon: ({ sock, chatId, senderJid, ctx }) => handleAwesomeOn(sock, chatId, senderJid, ctx),
    awesomeoff: ({ sock, chatId, senderJid, ctx }) => handleAwesomeOff(sock, chatId, senderJid, ctx),
    interviewqon: ({ sock, chatId, senderJid, ctx }) => handleInterviewQOn(sock, chatId, senderJid, ctx),
    interviewqoff: ({ sock, chatId, senderJid, ctx }) => handleInterviewQOff(sock, chatId, senderJid, ctx),
    interviewq: ({ sock, chatId, senderJid, args, ctx }) => handleInterviewQ(sock, chatId, senderJid, args, ctx),
    groups: ({ sock, chatId, senderJid, ctx }) => handleGroups(sock, chatId, senderJid, ctx),
    setwc: ({ sock, chatId, senderJid, fullCommand, ctx }) => handleSetWelcome(sock, chatId, senderJid, fullCommand, ctx),
    link: ({ sock, chatId, senderJid, ctx }) => handleGroupLink(sock, chatId, senderJid, ctx),
    revokelink: ({ sock, chatId, senderJid, ctx }) => handleRevokeLink(sock, chatId, senderJid, ctx),
    warn: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleWarn(sock, chatId, senderJid, args, originalMsg, ctx),
    mywarns: ({ sock, chatId, senderJid, ctx }) => handleMyWarns(sock, chatId, senderJid, ctx),
    warns: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleWarns(sock, chatId, senderJid, args, originalMsg, ctx),
    clearwarns: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleClearWarns(sock, chatId, senderJid, args, originalMsg, ctx),
    dellast: ({ sock, chatId, args, originalMsg, ctx }) => handleDelLast(sock, chatId, args, originalMsg, ctx),
    delall: ({ sock, chatId, args, originalMsg, ctx }) => handleDelLast(sock, chatId, args, originalMsg, ctx),
    movieon: ({ sock, chatId, senderJid, ctx }) => handleMovieOn(sock, chatId, senderJid, ctx),
    movieoff: ({ sock, chatId, senderJid, ctx }) => handleMovieOff(sock, chatId, senderJid, ctx),
    summaryon: ({ sock, chatId, senderJid, ctx }) => handleSummaryOn(sock, chatId, senderJid, ctx),
    summaryoff: ({ sock, chatId, senderJid, ctx }) => handleSummaryOff(sock, chatId, senderJid, ctx),
    summarynow: ({ sock, chatId, senderJid, ctx }) => handleSummaryNow(sock, chatId, senderJid, ctx),
    fix: ({ sock, chatId, senderJid, args, ctx }) => handleFix(sock, chatId, senderJid, args, ctx),
    heal: ({ sock, chatId, senderJid, args, ctx }) => handleHeal(sock, chatId, senderJid, args, ctx),
    assist: ({ sock, chatId, senderJid, args, ctx }) => handleAssist(sock, chatId, senderJid, args, ctx),
    resume: ({ sock, chatId, senderJid, args, ctx }) => handleCv(sock, chatId, senderJid, args, ctx),
    tailor: ({ sock, chatId, senderJid, args, ctx }) => handleTailor(sock, chatId, senderJid, args, ctx),
    cover: ({ sock, chatId, senderJid, args, ctx }) => handleCover(sock, chatId, senderJid, args, ctx),
    trending: ({ sock, chatId, senderJid, args, ctx }) => handleTrending(sock, chatId, senderJid, args, ctx),
    tradelert: ({ sock, chatId, senderJid, args, ctx }) => handleTradelert(sock, chatId, senderJid, args, ctx),
    tradenow: ({ sock, chatId, senderJid, args, ctx }) => handleTradenow(sock, chatId, senderJid, args, ctx),
    index: ({ sock, chatId, senderJid, args, ctx }) => handleIndex(sock, chatId, senderJid, args, ctx),
    chainai: ({ sock, chatId, senderJid, args, ctx }) => handleChainAi(sock, chatId, senderJid, args, ctx),
    ipo: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
        if (!ctx.ipoController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ IPO analysis service is not available.' }, originalMsg);
        }
        return ctx.ipoController.handle(sock, chatId, senderJid, args, originalMsg);
    },
    svmkr: ({ sock, chatId, senderJid, args, ctx }) => handleSvmkr(sock, chatId, senderJid, args, ctx),
    swing: ({ sock, chatId, senderJid, args, ctx }) => handleSwing(sock, chatId, senderJid, args, ctx),
    expiry: ({ sock, chatId, senderJid, args, ctx }) => handleExpiry(sock, chatId, senderJid, args, ctx),
    backtest: async ({ sock, chatId, args, ctx }) => {
        if (!ctx.backtestController) {
            ctx.backtestController = new BacktestController(ctx.config || {});
        }
        return ctx.backtestController.handleCommand(chatId, `/backtest${args?.length ? ' ' + args.join(' ') : ''}`, sock);
    },

    /* ── Admin management ── */
    addadmin: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleAddAdmin(sock, chatId, senderJid, args, originalMsg, ctx),
    removeadmin: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleRemoveAdmin(sock, chatId, senderJid, args, originalMsg, ctx),
    admins: ({ sock, chatId, senderJid, ctx }) => handleAdmins(sock, chatId, senderJid, ctx),
    increaselimit: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => handleIncreaseLimit(sock, chatId, senderJid, args, originalMsg, ctx),
    checklimit: ({ sock, chatId, senderJid, args, originalMsg, pushName, ctx }) => handleCheckLimit(sock, chatId, senderJid, args, originalMsg, pushName, ctx),

    /* ── Owner: premium / mod / channels ── */
    addpremium: ({ sock, chatId, senderJid, args, ctx }) => handleAddPremium(sock, chatId, senderJid, args, ctx),
    removepremium: ({ sock, chatId, senderJid, args, ctx }) => handleRemovePremium(sock, chatId, senderJid, args, ctx),
    premium: ({ sock, chatId, senderJid, ctx }) => handleListPremium(sock, chatId, senderJid, ctx),
    addmod: ({ sock, chatId, senderJid, args, ctx }) => handleAddMod(sock, chatId, senderJid, args, ctx),
    removemod: ({ sock, chatId, senderJid, args, ctx }) => handleRemoveMod(sock, chatId, senderJid, args, ctx),
    addchannel: ({ sock, chatId, args, senderJid, ctx }) => handleAddChannel(sock, chatId, args, senderJid, ctx),
    removechannel: ({ sock, chatId, args, senderJid, ctx }) => handleRemoveChannel(sock, chatId, args, senderJid, ctx),
    channels: ({ sock, chatId, senderJid, ctx }) => handleChannels(sock, chatId, senderJid, ctx),
    grouppost: ({ sock, chatId, senderJid, args, ctx }) => handleGroupPost(sock, chatId, senderJid, args, ctx),
    driveurl: ({ sock, chatId, senderJid, args, ctx }) => handleDriveUrl(sock, chatId, senderJid, args, ctx),
    viewonce: ({ sock, chatId, senderJid, originalMsg }) => handleViewOnce(sock, chatId, senderJid, originalMsg),
    deploy: ({ sock, chatId, senderJid, originalMsg }) => handleDeploy(sock, chatId, senderJid, originalMsg),

    /* ── Instagram / News / Movie ── */
    insta: ({ sock, chatId, args, originalMsg }) => _handleInsta(sock, chatId, args, originalMsg),
    tw: ({ sock, chatId, args, originalMsg }) => handleTwitter(sock, chatId, args, originalMsg),
    news: ({ sock, chatId, senderJid, ctx }) => handleNews(sock, chatId, senderJid, ctx),
    github: ({ sock, chatId, senderJid, ctx }) => handleGithub(sock, chatId, senderJid, ctx),
    awesome: ({ sock, chatId, senderJid, ctx }) => handleAwesome(sock, chatId, senderJid, ctx),
    horo: async ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
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
    },
    advice: async ({ sock, chatId, originalMsg }) => {
        try {
            const slip = await adviceService.fetchAdvice();
            await safeSendMessage(sock, chatId, { text: adviceService.formatMessage(slip) }, originalMsg);
        } catch (err) {
            logger.error('Advice command error:', err);
            await safeSendMessage(sock, chatId, { text: adviceService.formatError() }, originalMsg);
        }
    },
    movie: ({ sock, chatId, senderJid, args, pushName, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie search is not available.' }, originalMsg);
        }
        void ctx.movieController.handleMovieSearch(sock, chatId, senderJid, args, pushName, originalMsg)
            .catch((err) => {
                logger.error(`Movie search handler error: ${err?.message || err}`);
            });
    },
    upcoming: ({ sock, chatId, senderJid, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
        }
        void ctx.movieController.handleUpcoming(sock, chatId, senderJid, originalMsg)
            .catch((err) => logger.error(`Upcoming handler error: ${err?.message || err}`));
    },
    genre: ({ sock, chatId, senderJid, args, originalMsg, ctx }) => {
        if (!ctx.movieController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Movie features not available.' }, originalMsg);
        }
        void ctx.movieController.handleGenre(sock, chatId, senderJid, args, originalMsg)
            .catch((err) => logger.error(`Genre handler error: ${err?.message || err}`));
    },

    /* ── Sticker Commands (non-blocking — FFmpeg runs in background queue) ── */
    sticker: ({ sock, chatId, args, originalMsg, fullCommand, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleSticker(sock, chatId, originalMsg, args, fullCommand).catch((err) => {
            logger.error('Sticker command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process sticker command.' }, originalMsg);
        });
    },
    steal: ({ sock, chatId, args, originalMsg, fullCommand, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleSteal(sock, chatId, originalMsg, args, fullCommand).catch((err) => {
            logger.error('Steal command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to process steal command.' }, originalMsg);
        });
    },
    toimg: ({ sock, chatId, originalMsg, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleToImage(sock, chatId, originalMsg).catch((err) => {
            logger.error('ToImage command error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to convert sticker to image.' }, originalMsg);
        });
    },
    rgb: ({ sock, chatId, args, originalMsg, ctx }) => {
        if (!ctx.stickerController) {
            return safeSendMessage(sock, chatId, { text: '⚠️ Sticker functionality is not available.' }, originalMsg);
        }
        void ctx.stickerController.handleRgbSticker(sock, chatId, args, originalMsg).catch((err) => {
            logger.error('RGB sticker error:', err);
            void safeSendMessage(sock, chatId, { text: '⚠️ Failed to generate RGB sticker.' }, originalMsg);
        });
    },
    tgstickers: ({ sock, chatId, args, originalMsg }) => {
        void handleTgStickers(sock, chatId, args, originalMsg).catch((err) => {
            logger.error('TG stickers command error:', err);
            void safeSendMessage(sock, chatId, { text: `⚠️ ${err.message || 'Failed to import stickers.'}` }, originalMsg);
        });
    },
    tgstop: ({ sock, chatId, originalMsg }) => {
        const stopped = abortImport(chatId);
        void safeSendMessage(sock, chatId, {
            text: stopped ? '🛑 *Import cancelled.*' : 'ℹ️ No active import to cancel.',
        }, originalMsg);
    },
};

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null, userManager = null, stickerController = null, botSettings = null, githubTrendingController = null, warnDatabase = null, authDatabase = null, courseAPI = null, awesomeListsController = null) {
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
        this.warnDatabase = warnDatabase;
        this.authDatabase = authDatabase;
        this.courseAPI = courseAPI;
        this.assistService = null;
        this.resumeStore = null;
        this.resumeTailorService = null;
        this.interviewQuestionService = null;
        this.pendingClearConfirmations = new Map();
        this.pendingGithubPosts = createGithubPostSessionStore();
        this.pendingAwesomePosts = createAwesomePostSessionStore();
        this.pendingResumeSessions = createResumeSessionStore();
        this.getSock = null;
        this.whatsappService = null;
        this.groupChatLogService = null;
        this.groupSummaryController = null;
        this.tradeAlertController = null;
        this.svmkrTracker = null;
        this.svmkrScheduler = null;
        this.botStartTime = Date.now();
        this.stickerForwarder = null;
        this.ipoController = null;

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

    /** Live SVMKR scanner handles — `/svmkr stats` and `/svmkr scan` need these. */
    setSvmkr({ tracker = null, scheduler = null } = {}) {
        if (tracker) this.svmkrTracker = tracker;
        if (scheduler) this.svmkrScheduler = scheduler;
    }

    setGetSock(getSock) {
        this.getSock = getSock;
    }

    setIpoController(ipoController) {
        this.ipoController = ipoController;
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
            warnDatabase: this.warnDatabase,
            movieController: this.movieController,
            userManager: this.userManager,
            stickerController: this.stickerController,
            stickerForwarder: this.stickerForwarder,
            botSettings: this.botSettings,
            authDatabase: this.authDatabase,
            pendingClearConfirmations: this.pendingClearConfirmations,
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
            svmkrTracker: this.svmkrTracker,
            svmkrScheduler: this.svmkrScheduler,
            assistService: this.assistService,
            interviewQuestionService: this.interviewQuestionService,
            botStartTime: this.botStartTime,
            courseAPI: this.courseAPI,
            isOwnerFromJid: this._isOwnerFromJid,
            ipoController: this.ipoController,
        };
    }

    async tryHandlePendingInput(sock, chatId, messageText, senderJid, originalMsg = null) {
        if (messageText?.trim()?.startsWith('/')) {
            return false;
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

        return false;
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

        const handler = COMMAND_HANDLERS[def.key];
        if (!handler) {
            // Registered but not wired — fail loudly instead of silently no-oping.
            logger.error(`No handler registered for command key '${def.key}'`);
            await plainSendMessage(sock, chatId, {
                text: `⚠️ \`${cmd}\` is registered but not wired up yet — please tell the owner.`,
            }, originalMsg?.key);
            return;
        }

        try {
            await handler({ sock, chatId, senderJid, args, originalMsg, pushName, ctx, fullCommand: command.trim() });
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
