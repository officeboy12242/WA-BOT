/**
 * Owner commands: /fix <instruction>, /heal approve|reject|status
 */

import { extractPhoneNumber } from '../../utils/permissions.js';
import { logger } from '../../utils/logger.js';

function getHeal(groupSummaryController) {
    return groupSummaryController?.selfHeal || null;
}

export async function handleFix(sock, chatId, senderJid, args, { groupManager, groupSummaryController }) {
    const senderPhone = extractPhoneNumber(senderJid);
    if (!groupManager.isOwner(senderPhone)) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can run `/fix`.' });
        return;
    }

    const heal = getHeal(groupSummaryController);
    if (!heal) {
        await sock.sendMessage(chatId, { text: '❌ Self-heal service not available.' });
        return;
    }

    const instruction = args.join(' ').trim();
    if (!instruction) {
        await sock.sendMessage(chatId, {
            text:
                '🔧 *Owner /fix*\n\n' +
                'Tell the AI what to change. It prepares a patch and shows you what changed.\n' +
                'Nothing is pushed until you confirm.\n\n' +
                '*Examples:*\n' +
                '• `/fix remove testing thing`\n' +
                '• `/fix make summary prompts shorter`\n' +
                '• `/fix fix zip links not showing in movies`\n\n' +
                'Then:\n' +
                '✅ `/heal approve <id>`\n' +
                '❌ `/heal reject <id>`',
        });
        return;
    }

    // Allow "/fix approve id" as alias
    const first = args[0]?.toLowerCase();
    if (['approve', 'yes', 'push', 'reject', 'no', 'deny', 'status', 'list'].includes(first)) {
        await handleHeal(sock, chatId, senderJid, args, { groupManager, groupSummaryController });
        return;
    }

    await sock.sendMessage(chatId, {
        text: `🔧 _Working on:_ ${instruction}\n_Nemotron is preparing a patch…_`,
    });

    const result = await heal.proposeFromInstruction(instruction, { byPhone: senderPhone });
    await sock.sendMessage(chatId, { text: result.message });
    logger.info(`/fix by ${senderPhone}: ${result.ok ? result.healId : result.message}`);
}

export async function handleHeal(sock, chatId, senderJid, args, { groupManager, groupSummaryController }) {
    const senderPhone = extractPhoneNumber(senderJid);
    if (!groupManager.isOwner(senderPhone)) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can manage self-heal.' });
        return;
    }

    const heal = getHeal(groupSummaryController);
    if (!heal) {
        await sock.sendMessage(chatId, { text: '❌ Self-heal service not available.' });
        return;
    }

    const action = String(args[0] || '').toLowerCase();
    const healId = String(args[1] || '').trim().toLowerCase();

    if (!action || action === 'status' || action === 'list') {
        const pending = await heal.listPending();
        if (!pending.length) {
            await sock.sendMessage(chatId, {
                text:
                    '🔧 *Self-heal*\nNo pending proposals.\n\n' +
                    `_Ready: ${heal.isReady() ? 'yes' : 'no (need GITHUB_TOKEN + Mongo)'}_\n` +
                    `Model: ${heal.healModel}\n\n` +
                    'Create one with:\n`/fix <what to change>`',
            });
            return;
        }
        const lines = pending.map((p) => {
            const ask = p.instruction ? `\n  🗣️ ${String(p.instruction).slice(0, 80)}` : '';
            return `• *${p.heal_id}* — ${p.summary || 'fix'}${ask}`;
        });
        await sock.sendMessage(chatId, {
            text:
                '🔧 *Pending heals*\n\n' +
                lines.join('\n\n') +
                '\n\n`/heal approve ID` · `/heal reject ID`',
        });
        return;
    }

    if (action === 'approve' || action === 'yes' || action === 'push' || action === 'confirm') {
        if (!healId) {
            await sock.sendMessage(chatId, { text: '❌ Usage: `/heal approve <id>`' });
            return;
        }
        await sock.sendMessage(chatId, { text: `🔧 _Pushing heal ${healId}…_` });
        const result = await heal.approveAndPush(healId, senderPhone);
        await sock.sendMessage(chatId, { text: result.message });
        logger.info(`Heal ${healId} approve by ${senderPhone}: ${result.ok}`);
        return;
    }

    if (action === 'reject' || action === 'no' || action === 'deny') {
        if (!healId) {
            await sock.sendMessage(chatId, { text: '❌ Usage: `/heal reject <id>`' });
            return;
        }
        const result = await heal.reject(healId, senderPhone);
        await sock.sendMessage(chatId, { text: result.message });
        logger.info(`Heal ${healId} reject by ${senderPhone}`);
        return;
    }

    await sock.sendMessage(chatId, {
        text:
            '❌ Usage:\n' +
            '`/fix <what to change>` — prepare patch\n' +
            '`/heal status`\n' +
            '`/heal approve <id>`\n' +
            '`/heal reject <id>`',
    });
}
