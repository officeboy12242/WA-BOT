/**
 * Admin group message deletion: /dellast, /del, /delall
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../../utils/logger.js';
import {
    buildQuotedTargetMessage,
    safeDeleteMessage,
    getSafeSendOptions,
} from '../../utils/waMessage.js';
import { groupMessageTracker } from '../../utils/groupMessageTracker.js';

const DELETE_DELAY_MS = 350;
const MAX_BATCH = 100;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBotGroupAdmin(sock, chatId) {
    try {
        const meta = await sock.groupMetadata(chatId);
        const botId = jidNormalizedUser(sock.user?.id || '');
        if (!botId) {
            return false;
        }
        for (const p of meta.participants || []) {
            const pid = jidNormalizedUser(p.id || '');
            const lid = p.lid ? jidNormalizedUser(p.lid) : '';
            if (pid === botId || lid === botId) {
                return p.admin === 'admin' || p.admin === 'superadmin';
            }
        }
    } catch (err) {
        logger.warn(`Bot admin check failed: ${err.message}`);
    }
    return false;
}

function usageText() {
    return (
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🗑️ *DELETE MESSAGES* 🗑️\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '*Commands (group admins):*\n' +
        '• `/dellast 20` — delete last 20 tracked messages\n' +
        '• `/dellast all` or `/delall` — delete all tracked (up to 500)\n' +
        '• Reply to a message + `/del` — delete that message\n\n' +
        '_Bot must be a WhatsApp group admin._\n' +
        '_Tracks messages since bot was online (max 500 per group)._'
    );
}

async function tryDelete(sock, chatId, key) {
    if (!sock?.sendMessage || !key?.id) {
        return false;
    }
    try {
        await sock.sendMessage(chatId, { delete: key });
        return true;
    } catch (err) {
        logger.debug(`Delete failed for ${key.id}: ${err.message}`);
        return false;
    }
}

async function deleteKeys(sock, chatId, entries) {
    let deleted = 0;
    let failed = 0;
    const removedIds = [];

    for (const entry of entries) {
        const ok = await tryDelete(sock, chatId, entry.key);
        if (ok) {
            deleted++;
            removedIds.push(entry.key.id);
        } else {
            failed++;
        }
        await delay(DELETE_DELAY_MS);
    }

    if (removedIds.length) {
        groupMessageTracker.removeByIds(chatId, removedIds);
    }

    return { deleted, failed };
}

export async function handleDelLast(sock, chatId, args, originalMsg, { fullCommand } = {}) {
    const sendOpts = getSafeSendOptions(originalMsg);

    if (!chatId?.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: '❌ This command works only in groups.' }, sendOpts);
        return;
    }

    const botAdmin = await isBotGroupAdmin(sock, chatId);
    if (!botAdmin) {
        await sock.sendMessage(chatId, {
            text: '❌ The bot must be a *group admin* to delete other members\' messages.\n\n_Promote the bot to admin in group settings._',
        }, sendOpts);
        return;
    }

    const quoted = buildQuotedTargetMessage(originalMsg);
    if (quoted?.key?.id) {
        const ok = await tryDelete(sock, chatId, quoted.key);
        if (ok) {
            groupMessageTracker.removeByIds(chatId, [quoted.key.id]);
            await sock.sendMessage(chatId, { text: '🗑️ Message deleted.' }, sendOpts);
        } else {
            await sock.sendMessage(chatId, {
                text: '❌ Could not delete that message.\n\n_Is the bot a group admin?_',
            }, sendOpts);
        }
        return;
    }

    const cmdName = String(fullCommand || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/^\//, '');
    let rawArg = args[0]?.toLowerCase();
    if (!rawArg && cmdName === 'delall') {
        rawArg = 'all';
    }
    if (!rawArg) {
        await sock.sendMessage(chatId, { text: usageText() }, sendOpts);
        return;
    }

    const isAll = rawArg === 'all';
    const tracked = groupMessageTracker.count(chatId);

    if (!tracked) {
        await sock.sendMessage(chatId, {
            text: '📭 No tracked messages in this group yet.\n\n_Messages are tracked while the bot is online._',
        }, sendOpts);
        return;
    }

    let take = 0;
    if (isAll) {
        take = tracked;
    } else {
        take = parseInt(rawArg, 10);
        if (!Number.isFinite(take) || take < 1) {
            await sock.sendMessage(chatId, { text: usageText() }, sendOpts);
            return;
        }
        take = Math.min(take, MAX_BATCH);
    }

    const entries = groupMessageTracker.getLast(chatId, take);
    if (!entries.length) {
        await sock.sendMessage(chatId, { text: '📭 Nothing to delete.' }, sendOpts);
        return;
    }

    const status = await sock.sendMessage(chatId, {
        text: `⏳ Deleting *${entries.length}* message(s)...`,
    }, sendOpts);

    const { deleted, failed } = await deleteKeys(sock, chatId, [...entries].reverse());

    let result =
        `🗑️ *Delete done*\n\n` +
        `✅ Deleted: *${deleted}*\n`;
    if (failed) {
        result += `❌ Failed: *${failed}*\n`;
    }
    if (isAll && tracked > entries.length) {
        result += `\n_Note: only messages tracked since bot was online are removed._`;
    }

    try {
        if (status?.key) {
            await safeDeleteMessage(sock, chatId, status.key);
        }
    } catch { /* ignore */ }

    await sock.sendMessage(chatId, { text: result }, sendOpts);
    logger.info(`DelLast in ${chatId}: requested=${take}, deleted=${deleted}, failed=${failed}`);
}
