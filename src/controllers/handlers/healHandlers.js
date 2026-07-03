/**
 * Owner commands for summary self-heal approve / reject.
 */

import { extractPhoneNumber } from '../../utils/permissions.js';
import { logger } from '../../utils/logger.js';

export async function handleHeal(sock, chatId, senderJid, args, { groupManager, groupSummaryController }) {
    const senderPhone = extractPhoneNumber(senderJid);
    if (!groupManager.isOwner(senderPhone)) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can manage summary self-heal.' });
        return;
    }

    const heal = groupSummaryController?.selfHeal;
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
                    '🔧 *Summary self-heal*\nNo pending proposals.\n\n' +
                    `_Ready: ${heal.isReady() ? 'yes' : 'no (need GITHUB_TOKEN + Mongo)'}_\n` +
                    `Model: ${heal.healModel}`,
            });
            return;
        }
        const lines = pending.map(
            (p) =>
                `• *${p.heal_id}* — ${p.summary || 'fix'}\n  _${p.error?.slice(0, 80) || ''}_`
        );
        await sock.sendMessage(chatId, {
            text:
                '🔧 *Pending summary heals*\n\n' +
                lines.join('\n\n') +
                '\n\n`/heal approve ID` · `/heal reject ID`',
        });
        return;
    }

    if (action === 'approve' || action === 'yes' || action === 'push') {
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
            '`/heal status`\n' +
            '`/heal approve <id>`\n' +
            '`/heal reject <id>`',
    });
}
