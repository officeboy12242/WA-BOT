/**
 * Admin group message deletion: /dellast, /del, /delall
 */

import { logger } from '../../utils/logger.js';
import {
    buildQuotedTargetMessage,
    getSafeSendOptions,
    resolveOutboundJid,
    safeDeleteMessage,
} from '../../utils/waMessage.js';
import { groupMessageTracker } from '../../utils/groupMessageTracker.js';

const DELETE_DELAY_MS = 350;
/** Max messages deleted per `/dellast N` (matches tracker capacity). */
const MAX_BATCH = 500;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildDeleteKey(chatId, key) {
    const deleteKey = {
        remoteJid: key.remoteJid || chatId,
        id: key.id,
        fromMe: Boolean(key.fromMe),
    };

    const participant = key.participant || key.participantLid;
    if (participant && !deleteKey.fromMe) {
        deleteKey.participant = participant;
    }

    return deleteKey;
}

function usageText() {
    return (
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🗑️ *DELETE MESSAGES* 🗑️\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        '*Commands (group admins):*\n' +
        '• `/dellast <number>` — delete oldest N tracked messages (e.g. `/dellast 50`, `/dellast 200`)\n' +
        '• `/dellast all` or `/delall` — delete all tracked backlog (up to 500)\n' +
        '• Reply to a message + `/del` — delete that message\n\n' +
        '_Bot must be a WhatsApp group admin._\n' +
        '_Tracks messages since bot was online (max 500 per group)._'
    );
}

async function tryDelete(sock, chatId, key) {
    if (!sock?.sendMessage || !key?.id) {
        return false;
    }

    const deleteKey = buildDeleteKey(chatId, key);
    const targetJid = resolveOutboundJid(deleteKey, chatId);

    try {
        await sock.sendMessage(targetJid, { delete: deleteKey });
        return true;
    } catch (err) {
        logger.debug(`Delete failed for ${deleteKey.id}: ${err.message}`);
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

export async function handleDelLast(sock, chatId, args, originalMsg, { fullCommand, groupManager } = {}) {
    const sendOpts = getSafeSendOptions(originalMsg);

    if (!chatId?.endsWith('@g.us')) {
        await sock.sendMessage(chatId, { text: '❌ This command works only in groups.' }, sendOpts);
        return;
    }

    const botAdmin = groupManager
        ? await groupManager.isBotGroupAdminAsync(sock, chatId)
        : false;

    if (!botAdmin) {
        logger.warn(`Bot admin check negative for ${chatId} — attempting delete anyway`);
    }

    const quoted = buildQuotedTargetMessage(originalMsg);
    if (quoted?.key?.id) {
        const ok = await tryDelete(sock, chatId, quoted.key);
        if (ok) {
            groupMessageTracker.removeByIds(chatId, [quoted.key.id]);
            await sock.sendMessage(chatId, { text: '🗑️ Message deleted.' }, sendOpts);
        } else {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Could not delete that message.\n\n' +
                    '_Ensure the bot is promoted to group admin and has permission to delete messages._',
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
    const commandMsgId = originalMsg?.key?.id;
    const tracked = groupMessageTracker.countBefore(chatId, commandMsgId);

    if (!tracked) {
        await sock.sendMessage(chatId, {
            text: '📭 No older tracked messages to delete.\n\n_Messages are tracked while the bot is online._',
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

    const entries = groupMessageTracker.getOldestBefore(chatId, take, commandMsgId);
    if (!entries.length) {
        await sock.sendMessage(chatId, { text: '📭 Nothing to delete.' }, sendOpts);
        return;
    }

    const status = await sock.sendMessage(chatId, {
        text: `⏳ Deleting *${entries.length}* older message(s)...`,
    }, sendOpts);

    const { deleted, failed } = await deleteKeys(sock, chatId, entries);

    let result =
        `🗑️ *Delete done*\n\n` +
        `✅ Deleted: *${deleted}*\n`;
    if (failed) {
        result += `❌ Failed: *${failed}*\n`;
        if (!botAdmin) {
            result += '\n_If nothing deleted, promote the bot to group admin._';
        }
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
    logger.info(`DelLast in ${chatId}: requested=${take}, deleted=${deleted}, failed=${failed}, botAdmin=${botAdmin}`);
}
