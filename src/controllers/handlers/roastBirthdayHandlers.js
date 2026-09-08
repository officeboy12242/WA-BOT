/**
 * Handlers for /roast and /birthday commands.
 */

import { logger } from '../../utils/logger.js';
import { safeSendMessage } from '../../utils/waMessage.js';
import { isGroupMessage, extractPhoneNumber } from '../../utils/permissions.js';
import { hasWaDocument } from '../../utils/waDocument.js';

const ROAST_USAGE =
    '🔥 *AI Resume Roast*\n\n' +
    'Send your resume PDF here *with* `/roast` as the caption (or quote a resume and type `/roast`).\n\n' +
    'You get: roast score /100, what works, what gets roasted, and a fix list.\n\n' +
    '_PDF / DOCX / TXT up to 8 MB._';

/**
 * /roast — attach a resume PDF with /roast as caption, or quote a resume.
 */
export async function handleRoast({ sock, chatId, senderJid, originalMsg, pushName, ctx }) {
    const service = ctx?.roastService;
    if (!service) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Roast service is not ready yet — try again in a minute.' }, originalMsg);
        return;
    }

    const hasDoc = hasWaDocument(originalMsg);
    if (!hasDoc) {
        await safeSendMessage(sock, chatId, { text: ROAST_USAGE }, originalMsg);
        return;
    }

    const progressMsg = await safeSendMessage(
        sock,
        chatId,
        { text: '🔥 *Downloading resume…* preparing the roast 🔥' },
        originalMsg
    );

    try {
        const displayName = String(pushName || '').trim();
        // Owner roasts unlimited (testing / demos); everyone else has a daily limit.
        const bypassLimit = ctx?.isOwnerFromJid
            ? await ctx.isOwnerFromJid(sock, chatId, senderJid)
            : false;
        const result = await service.roastDocument({
            sock,
            waMessage: originalMsg,
            senderJid,
            displayName,
            bypassLimit,
        });

        const footer =
            `\n\n_Grilled by ${result.provider}/${result.model}_` +
            `\n_Another one? Send a fresh PDF with /roast._`;
        await safeSendMessage(
            sock,
            chatId,
            { text: `${result.text}${footer}` },
            originalMsg
        );
        logger.info(`🔥 Roast delivered to ${chatId} via ${result.provider} (score ${result.score ?? '?'})`);
    } catch (err) {
        const friendly = err?.userFriendly ? err.message : null;
        logger.warn(`Roast failed for ${chatId}: ${err.message}`);
        const reason = friendly
            ? ''
            : String(err?.message || '').slice(0, 120);
        await safeSendMessage(
            sock,
            chatId,
            {
                text:
                    friendly ||
                    `💀 The grill broke mid-roast (LLM hiccup: ${reason || 'all providers failed'}). ` +
                        'Try again in a minute — the fallback providers usually catch it.',
            },
            originalMsg
        );
    } finally {
        try {
            if (progressMsg?.key) await sock.sendMessage(chatId, { delete: progressMsg.key });
        } catch {}
    }
}

/**
 * /birthday — add/remove/list birthdays in a group.
 *   /birthday add 14-11 [optional: quote or reply does nothing special]
 *   /birthday list
 *   /birthday remove
 */
export async function handleBirthday({ sock, chatId, senderJid, args, originalMsg, ctx }) {
    const service = ctx?.birthdayService;
    if (!service) {
        await safeSendMessage(sock, chatId, { text: '⚠️ Birthday service is not ready yet — try again in a minute.' }, originalMsg);
        return;
    }
    if (!isGroupMessage(chatId)) {
        await safeSendMessage(sock, chatId, { text: '❌ Birthdays work in groups only — add yours in your class/community group.' }, originalMsg);
        return;
    }

    const sub = String(args?.[0] || '').toLowerCase();
    const phone = extractPhoneNumber(senderJid);

    if (sub === 'add' || sub === 'set') {
        const res = await service.addBirthday({
            groupId: chatId,
            senderJid,
            rawDate: args?.slice(1).join(' ') || '',
        });
        await safeSendMessage(sock, chatId, { text: res.message }, originalMsg);
        return;
    }

    if (sub === 'remove' || sub === 'delete' || sub === 'off') {
        if (!phone) {
            await safeSendMessage(sock, chatId, { text: 'Could not read your number from this chat.' }, originalMsg);
            return;
        }
        const res = await service.removeBirthday(chatId, phone);
        await safeSendMessage(sock, chatId, { text: res.message }, originalMsg);
        return;
    }

    if (sub === 'list') {
        const rows = await service.listBirthdays(chatId);
        if (!rows.length) {
            await safeSendMessage(sock, chatId, { text: '📅 No birthdays saved here yet. `/birthday add DD-MM` to add yours!' }, originalMsg);
            return;
        }
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit' }).format(new Date());
        const [tD, tM] = today.split('-').map(Number);
        const lines = rows.map((r) => {
            const isToday = r.dd === tD && r.mm === tM;
            return `${isToday ? '🎉' : '•'} ${String(r.dd).padStart(2, '0')}-${String(r.mm).padStart(2, '0')} → +${r.phone}${isToday ? ' (today!)' : ''}`;
        });
        await safeSendMessage(
            sock,
            chatId,
            { text: `🎂 *Birthdays in this group*\n\n${lines.join('\n')}\n\n_Add yours: /birthday add DD-MM_` },
            originalMsg
        );
        return;
    }

    // No/unknown subcommand → own birthday + help
    const own = await service.col?.findOne?.({ group_id: chatId, phone: String(phone) }) ?? null;
    const ownLine = own ? `Your birthday here: *${String(own.dd).padStart(2, '0')}-${String(own.mm).padStart(2, '0')}*\n\n` : '';
    await safeSendMessage(
        sock,
        chatId,
        {
            text:
                `🎂 *Birthday wishes*\n\n` +
                `${ownLine}` +
                `• \`/birthday add DD-MM\` — save your birthday (year optional)\n` +
                `• \`/birthday list\` — see the group's birthdays\n` +
                `• \`/birthday remove\` — stop wishes for you\n\n` +
                `_On your day the bot posts an AI-written wish and tags you 🎉_`,
        },
        originalMsg
    );
}
