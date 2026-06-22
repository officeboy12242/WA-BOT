/**
 * Command Controller — thin dispatcher
 * All handler logic lives in ./handlers/*
 */

import { checkCommandAccess } from '../commands/access.js';
import { findCommand, findSimilarCommands } from '../commands/registry.js';
import { logger } from '../utils/logger.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { extractPhoneNumber } from '../utils/permissions.js';

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
    handleNewsOn,
    handleNewsOff,
    handleGithubOn,
    handleGithubOff,
    handleGroups,
    handleSetWelcome,
    handleGroupParticipantsUpdate as _handleGroupParticipantsUpdate,
    handleMovieOn,
    handleMovieOff,
    handleTrending,
} from './handlers/groupHandlers.js';

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
} from './handlers/instaHandlers.js';

import {
    handleScrap,
    handleScrapMembers,
    handleBroadcast,
    handleGroupPost,
    handlePendingScrapSelection,
    createScrapSessionStore,
} from './handlers/memberScrapeHandlers.js';

import { horoscopeService } from '../services/HoroscopeService.js';
import { handleDriveUrl } from './handlers/driveHandlers.js';

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null, userManager = null, stickerController = null, botSettings = null, githubTrendingController = null, memberScrapeController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.movieController = movieController;
        this.userManager = userManager;
        this.stickerController = stickerController;
        this.botSettings = botSettings;
        this.githubTrendingController = githubTrendingController;
        this.memberScrapeController = memberScrapeController;
        this.pendingClearConfirmations = new Map();
        this.pendingScrapSessions = createScrapSessionStore();
        this.pendingGithubPosts = createGithubPostSessionStore();
        this.getSock = null;
        this.botStartTime = Date.now();

        this._isOwnerFromJid = this._isOwnerFromJid.bind(this);
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

    /** Shared context passed to every handler */
    _ctx() {
        return {
            database: this.database,
            botState: this.botState,
            groupManager: this.groupManager,
            newsController: this.newsController,
            githubTrendingController: this.githubTrendingController,
            memberScrapeController: this.memberScrapeController,
            movieController: this.movieController,
            userManager: this.userManager,
            stickerController: this.stickerController,
            botSettings: this.botSettings,
            pendingClearConfirmations: this.pendingClearConfirmations,
            pendingScrapSessions: this.pendingScrapSessions,
            pendingGithubPosts: this.pendingGithubPosts,
            getSock: this.getSock,
            botStartTime: this.botStartTime,
            isOwnerFromJid: this._isOwnerFromJid,
        };
    }

    async tryHandlePendingInput(sock, chatId, messageText, senderJid, originalMsg = null) {
        if (!messageText?.trim() || messageText.trim().startsWith('/')) {
            return false;
        }

        const ctx = { ...this._ctx(), originalMsg };
        const handledGithub = await handlePendingGithubConfirmation(
            sock, chatId, senderJid, messageText.trim(), ctx,
        );
        if (handledGithub) {
            return true;
        }

        return handlePendingScrapSelection(sock, chatId, senderJid, messageText.trim(), ctx);
    }

    async handleGroupParticipantsUpdate(sock, update) {
        await _handleGroupParticipantsUpdate(sock, update, this._ctx());
    }

    async handleInsta(sock, chatId, args, quotedMessage, options = {}) {
        await _handleInsta(sock, chatId, args, quotedMessage, options);
    }

    async handleCommand(sock, chatId, command, senderJid, originalMsg = null, pushName = '') {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (!cmd) return;

        const def = findCommand(cmd);
        if (!def) {
            // Show suggestions for unknown commands
            const suggestions = findSimilarCommands(cmd);
            if (suggestions.length > 0) {
                const suggestionText = suggestions.map(s => `  • \`${s}\``).join('\n');
                await sendAndDelete(sock, chatId, {
                    text: `❓ Unknown command: \`${cmd}\`\n\n💡 *Did you mean:*\n${suggestionText}\n\n_Type \`/help\` for all commands_\n_⏰ Auto-deletes in 5 hours_`
                }, { quoted: originalMsg });
            }
            return;
        }

        logger.info(`📝 Command received: ${def.key} from ${senderJid} in ${chatId}`);

        const access = await checkCommandAccess(sock, chatId, senderJid, def, this.groupManager);
        if (!access.ok) {
            await sock.sendMessage(chatId, { text: access.message }, { quoted: originalMsg });
            return;
        }

        const ctx = { ...this._ctx(), originalMsg };

        switch (def.key) {
            /* ── Core ── */
            case 'ping':     await handlePing(sock, chatId, ctx); break;
            case 'posted':   await handlePosted(sock, chatId, ctx); break;
            case 'clear':    await handleClear(sock, chatId, ctx); break;
            case 'confirm':  await handleConfirm(sock, chatId, ctx); break;
            case 'cancel':  await handleCancel(sock, chatId, senderJid, ctx); break;
            case 'pause':    await handlePause(sock, chatId, ctx); break;
            case 'resume':   await handleResume(sock, chatId, ctx); break;
            case 'status':   await handleStatus(sock, chatId, ctx); break;
            case 'facts':    await handleFacts(sock, chatId, ctx); break;
            case 'help':     await handleHelp(sock, chatId, senderJid, ctx); break;

            /* ── Group management ── */
            case 'activate':   await handleActivate(sock, chatId, senderJid, ctx); break;
            case 'deactivate': await handleDeactivate(sock, chatId, senderJid, ctx); break;
            case 'instaon':    await handleInstaOn(sock, chatId, senderJid, ctx); break;
            case 'instaoff':   await handleInstaOff(sock, chatId, senderJid, ctx); break;
            case 'newson':     await handleNewsOn(sock, chatId, senderJid, ctx); break;
            case 'newsoff':    await handleNewsOff(sock, chatId, senderJid, ctx); break;
            case 'githubon':   await handleGithubOn(sock, chatId, senderJid, ctx); break;
            case 'githuboff':  await handleGithubOff(sock, chatId, senderJid, ctx); break;
            case 'groups':     await handleGroups(sock, chatId, senderJid, ctx); break;
            case 'setwc':      await handleSetWelcome(sock, chatId, senderJid, command.trim(), ctx); break;
            case 'movieon':    await handleMovieOn(sock, chatId, senderJid, ctx); break;
            case 'movieoff':   await handleMovieOff(sock, chatId, senderJid, ctx); break;
            case 'trending':   await handleTrending(sock, chatId, senderJid, args, ctx); break;

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
            case 'broadcast':     void handleBroadcast(sock, chatId, senderJid, args, ctx).catch((err) => {
                logger.error(`Broadcast handler error: ${err?.message || err?.output?.payload?.message || String(err)}`);
            }); break;
            case 'grouppost':     await handleGroupPost(sock, chatId, senderJid, args, ctx); break;
            case 'driveurl':      await handleDriveUrl(sock, chatId, senderJid, args, ctx); break;

            /* ── Instagram / News / Movie ── */
            case 'insta': await _handleInsta(sock, chatId, args, originalMsg); break;
            case 'news':  await handleNews(sock, chatId, senderJid, ctx); break;
            case 'github': await handleGithub(sock, chatId, senderJid, ctx); break;
            case 'horo':
                try {
                    const sign = args[0];
                    if (!sign) {
                        // No sign provided, show list
                        const listMsg = horoscopeService.getSignsList();
                        await sock.sendMessage(chatId, { text: listMsg }, { quoted: originalMsg });
                    } else {
                        // Fetch horoscope for the sign
                        const data = await horoscopeService.fetchHoroscope(sign);
                        const msg = horoscopeService.formatMessage(data);
                        await sock.sendMessage(chatId, { text: msg }, { quoted: originalMsg });
                    }
                } catch (err) {
                    logger.error('Horoscope command error:', err);
                    await sock.sendMessage(chatId, { text: '⚠️ Failed to fetch horoscope. Please try again.' }, { quoted: originalMsg });
                }
                break;
            case 'movie':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie search is not available.' }, { quoted: originalMsg });
                } else {
                    await this.movieController.handleMovieSearch(sock, chatId, senderJid, args, pushName, originalMsg);
                }
                break;
            case 'upcoming':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie features not available.' }, { quoted: originalMsg });
                } else {
                    await this.movieController.handleUpcoming(sock, chatId, senderJid, originalMsg);
                }
                break;
            case 'genre':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie features not available.' }, { quoted: originalMsg });
                } else {
                    await this.movieController.handleGenre(sock, chatId, senderJid, args, originalMsg);
                }
                break;

            /* ── Sticker Commands (non-blocking — FFmpeg runs in background queue) ── */
            case 'sticker':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' }, { quoted: originalMsg });
                } else {
                    void this.stickerController.handleSticker(sock, chatId, originalMsg, args, command).catch((err) => {
                        logger.error('Sticker command error:', err);
                        void sock.sendMessage(chatId, { text: '⚠️ Failed to process sticker command.' }, { quoted: originalMsg });
                    });
                }
                break;
            case 'steal':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' }, { quoted: originalMsg });
                } else {
                    void this.stickerController.handleSteal(sock, chatId, originalMsg, args, command).catch((err) => {
                        logger.error('Steal command error:', err);
                        void sock.sendMessage(chatId, { text: '⚠️ Failed to process steal command.' }, { quoted: originalMsg });
                    });
                }
                break;
            case 'toimg':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' }, { quoted: originalMsg });
                } else {
                    void this.stickerController.handleToImage(sock, chatId, originalMsg).catch((err) => {
                        logger.error('ToImage command error:', err);
                        void sock.sendMessage(chatId, { text: '⚠️ Failed to convert sticker to image.' }, { quoted: originalMsg });
                    });
                }
                break;
            case 'rgb':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' }, { quoted: originalMsg });
                } else {
                    void this.stickerController.handleRgbSticker(sock, chatId, args, originalMsg).catch((err) => {
                        logger.error('RGB sticker error:', err);
                        void sock.sendMessage(chatId, { text: '⚠️ Failed to generate RGB sticker.' }, { quoted: originalMsg });
                    });
                }
                break;

            default: break;
        }
    }
}

export default CommandController;
