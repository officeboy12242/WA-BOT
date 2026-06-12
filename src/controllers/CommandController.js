/**
 * Command Controller — thin dispatcher
 * All handler logic lives in ./handlers/*
 */

import { checkCommandAccess } from '../commands/access.js';
import { findCommand } from '../commands/registry.js';
import { logger } from '../utils/logger.js';
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
} from './handlers/instaHandlers.js';

class CommandController {
    constructor(database, botState, groupManager, newsController = null, movieController = null, userManager = null, stickerController = null) {
        this.database = database;
        this.botState = botState;
        this.groupManager = groupManager;
        this.newsController = newsController;
        this.movieController = movieController;
        this.userManager = userManager;
        this.stickerController = stickerController;
        this.pendingClearConfirmations = new Map();
        this.botStartTime = Date.now();

        this._isOwnerFromJid = this._isOwnerFromJid.bind(this);
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
            movieController: this.movieController,
            userManager: this.userManager,
            stickerController: this.stickerController,
            pendingClearConfirmations: this.pendingClearConfirmations,
            botStartTime: this.botStartTime,
            isOwnerFromJid: this._isOwnerFromJid,
        };
    }

    async handleGroupParticipantsUpdate(sock, update) {
        await _handleGroupParticipantsUpdate(sock, update, this._ctx());
    }

    async handleInsta(sock, chatId, args, quotedMessage, options = {}) {
        await _handleInsta(sock, chatId, args, quotedMessage, options);
    }

    async handleCommand(sock, chatId, command, senderJid, quotedMessage = null, pushName = '') {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (!cmd) return;

        const def = findCommand(cmd);
        if (!def) return;

        logger.info(`📝 Command received: ${def.key} from ${senderJid} in ${chatId}`);

        const access = await checkCommandAccess(sock, chatId, senderJid, def, this.groupManager);
        if (!access.ok) {
            await sock.sendMessage(chatId, { text: access.message });
            return;
        }

        const ctx = this._ctx();

        switch (def.key) {
            /* ── Core ── */
            case 'ping':     await handlePing(sock, chatId, ctx); break;
            case 'posted':   await handlePosted(sock, chatId, ctx); break;
            case 'clear':    await handleClear(sock, chatId, ctx); break;
            case 'confirm':  await handleConfirm(sock, chatId, ctx); break;
            case 'cancel':   await handleCancel(sock, chatId, ctx); break;
            case 'pause':    await handlePause(sock, chatId, ctx); break;
            case 'resume':   await handleResume(sock, chatId, ctx); break;
            case 'status':   await handleStatus(sock, chatId, ctx); break;
            case 'facts':    await handleFacts(sock, chatId, quotedMessage); break;
            case 'help':     await handleHelp(sock, chatId, senderJid, quotedMessage, ctx); break;

            /* ── Group management ── */
            case 'activate':   await handleActivate(sock, chatId, senderJid, ctx); break;
            case 'deactivate': await handleDeactivate(sock, chatId, senderJid, ctx); break;
            case 'instaon':    await handleInstaOn(sock, chatId, senderJid, ctx); break;
            case 'instaoff':   await handleInstaOff(sock, chatId, senderJid, ctx); break;
            case 'groups':     await handleGroups(sock, chatId, senderJid, ctx); break;
            case 'setwc':      await handleSetWelcome(sock, chatId, senderJid, command.trim(), ctx); break;
            case 'movieon':    await handleMovieOn(sock, chatId, senderJid, ctx); break;
            case 'movieoff':   await handleMovieOff(sock, chatId, senderJid, ctx); break;
            case 'trending':   await handleTrending(sock, chatId, senderJid, args, ctx); break;

            /* ── Admin management ── */
            case 'addadmin':    await handleAddAdmin(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'removeadmin': await handleRemoveAdmin(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'admins':      await handleAdmins(sock, chatId, senderJid, ctx); break;
            case 'increaselimit': await handleIncreaseLimit(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'checklimit': await handleCheckLimit(sock, chatId, senderJid, args, quotedMessage, pushName, ctx); break;

            /* ── Owner: premium / mod / channels ── */
            case 'addpremium':    await handleAddPremium(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'removepremium': await handleRemovePremium(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'premium':       await handleListPremium(sock, chatId, senderJid, ctx); break;
            case 'addmod':        await handleAddMod(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'removemod':     await handleRemoveMod(sock, chatId, senderJid, args, quotedMessage, ctx); break;
            case 'addchannel':    await handleAddChannel(sock, chatId, args, senderJid, ctx); break;
            case 'removechannel': await handleRemoveChannel(sock, chatId, args, senderJid, ctx); break;
            case 'channels':      await handleChannels(sock, chatId, senderJid, ctx); break;

            /* ── Instagram / News / Movie ── */
            case 'insta': await _handleInsta(sock, chatId, args, quotedMessage); break;
            case 'news':  await handleNews(sock, chatId, senderJid, ctx); break;
            case 'movie':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie search is not available.' });
                } else {
                    await this.movieController.handleMovieSearch(sock, chatId, senderJid, args, pushName, quotedMessage);
                }
                break;
            case 'upcoming':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie features not available.' });
                } else {
                    await this.movieController.handleUpcoming(sock, chatId, senderJid, quotedMessage);
                }
                break;
            case 'genre':
                if (!this.movieController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Movie features not available.' });
                } else {
                    await this.movieController.handleGenre(sock, chatId, senderJid, args, quotedMessage);
                }
                break;

            /* ── Sticker Commands ── */
            case 'sticker':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' });
                } else {
                    try {
                        await this.stickerController.handleSticker(sock, chatId, quotedMessage, args, command);
                    } catch (err) {
                        logger.error('Sticker command error:', err);
                        await sock.sendMessage(chatId, { text: '⚠️ Failed to process sticker command.' });
                    }
                }
                break;
            case 'steal':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' });
                } else {
                    try {
                        await this.stickerController.handleSteal(sock, chatId, quotedMessage, args, command);
                    } catch (err) {
                        logger.error('Steal command error:', err);
                        await sock.sendMessage(chatId, { text: '⚠️ Failed to process steal command.' });
                    }
                }
                break;
            case 'toimg':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' });
                } else {
                    try {
                        await this.stickerController.handleToImage(sock, chatId, quotedMessage);
                    } catch (err) {
                        logger.error('ToImage command error:', err);
                        await sock.sendMessage(chatId, { text: '⚠️ Failed to convert sticker to image.' });
                    }
                }
                break;
            case 'rgb':
                if (!this.stickerController) {
                    await sock.sendMessage(chatId, { text: '⚠️ Sticker functionality is not available.' });
                } else {
                    try {
                        await this.stickerController.handleRgbSticker(sock, chatId, args, quotedMessage);
                    } catch (err) {
                        logger.error('RGB sticker error:', err);
                        await sock.sendMessage(chatId, { text: '⚠️ Failed to generate RGB sticker.' });
                    }
                }
                break;

            default: break;
        }
    }
}

export default CommandController;
