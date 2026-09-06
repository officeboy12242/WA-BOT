/**
 * Commands: /interviewq test|post|answer · /interviewqon · /interviewqoff
 *           /tagme · /notag — opt in/out of being tagged in Interview Q posts
 */

import { logger } from '../utils/logger.js';
import { extractPhoneNumber, isGroupMessage } from '../utils/permissions.js';
import { formatSlotKey } from '../utils/newsScheduler.js';
import { config } from '../config/config.js';

function todaySlotKey(hour, minute) {
    return formatSlotKey(new Date(), config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata', hour, minute);
}

/**
 * /interviewq test — generate + poll in this chat (manual slot, no group fanout)
 * /interviewq post — post to all enabled groups (or current chat if DM/group without fanout flag)
 * /interviewq answer — post answer now for latest pending poll in this chat
 */
export async function handleInterviewQ(sock, chatId, senderJid, args, ctx) {
    const { interviewQuestionService, originalMsg } = ctx;
    if (!interviewQuestionService) {
        await sock.sendMessage(chatId, { text: '⚠️ Interview Q is not configured.' }, { quoted: originalMsg });
        return;
    }
    if (!interviewQuestionService.isConfigured()) {
        await sock.sendMessage(
            chatId,
            { text: '⚠️ AI not configured. Set GEMINI / GROQ / NVIDIA / OPENROUTER API key.' },
            { quoted: originalMsg }
        );
        return;
    }

    const action = String(args[0] || 'test').toLowerCase();

    try {
        if (action === 'test') {
            await sock.sendMessage(chatId, { text: '🧠 Generating interview poll…' }, { quoted: originalMsg });
            const slotKey = `test-${chatId}-${Date.now()}`;
            const result = await interviewQuestionService.postQuestionToJid(sock, chatId, {
                slotKey,
                slotIndex: 0,
            });
            if (result.skipped) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Skipped (duplicate slot).' }, { quoted: originalMsg });
                return;
            }
            await sock.sendMessage(
                chatId,
                {
                    text:
                        `✅ Poll posted. Answer auto-posts in ${Math.round((config.INTERVIEW_Q_ANSWER_DELAY_MS || 1_800_000) / 60_000)} min.\n` +
                        `Use \`/interviewq answer\` to reveal early.`,
                },
                { quoted: originalMsg }
            );
            return;
        }

        if (action === 'post') {
            await sock.sendMessage(chatId, { text: '🧠 Posting Interview Q to enabled groups…' }, { quoted: originalMsg });
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }).formatToParts(now);
            const hour = Number(parts.find((p) => p.type === 'hour')?.value) || 13;
            const minute = Number(parts.find((p) => p.type === 'minute')?.value) || 0;
            const slotKey = `manual-${todaySlotKey(hour, minute)}-${Date.now()}`;
            const { posted, groups } = await interviewQuestionService.postSlotToGroups(sock, {
                slotKey,
                slotIndex: 0,
            });
            await sock.sendMessage(
                chatId,
                { text: `✅ Interview Q posted to *${posted}/${groups}* group(s).` },
                { quoted: originalMsg }
            );
            return;
        }

        if (action === 'answer') {
            const pending = await interviewQuestionService.store.findLatestPendingAnswer(chatId);
            if (!pending) {
                await sock.sendMessage(
                    chatId,
                    { text: 'ℹ️ No pending Interview Q answer in this chat.' },
                    { quoted: originalMsg }
                );
                return;
            }
            const result = await interviewQuestionService.postAnswerById(String(pending._id));
            if (result.ok) {
                await sock.sendMessage(chatId, { text: '✅ Answer posted.' }, { quoted: originalMsg });
            } else {
                await sock.sendMessage(
                    chatId,
                    { text: `⚠️ Could not post answer (${result.reason}).` },
                    { quoted: originalMsg }
                );
            }
            return;
        }

        if (action === 'board' || action === 'leaderboard' || action === 'lb') {
            const { text, allRows, jid } = await interviewQuestionService.getLeaderboardForJid(chatId, {
                sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
                limit: 10,
            });
            // Tag the leaderboard players (only in groups; /tagme opt-ins resolve by phone).
            const tagPack = isGroupMessage(chatId)
                ? await interviewQuestionService.buildLeaderboardTagPack(jid || chatId, allRows, { limit: 10, sock })
                : { text: '', mentions: [] };
            const payload = {
                text: `${text}${tagPack.text}\n🤖 _Sassy Bot_`,
                ...(tagPack.mentions.length ? { mentions: tagPack.mentions } : {}),
            };
            await sock.sendMessage(chatId, payload, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(
            chatId,
            {
                text:
                    '🧠 *Interview Q of the Day*\n\n' +
                    '• `/interviewq test` — generate + poll here\n' +
                    '• `/interviewq post` — post to all `/interviewqon` groups\n' +
                    '• `/interviewq answer` — reveal answer now in this chat\n' +
                    '• `/interviewq board` or `/iqboard` — weekly leaderboard\n' +
                    '• `/interviewqon` / `/interviewqoff` — group schedule toggle\n' +
                    '• `/tagme` / `/notag` — opt in/out of tags here\n\n' +
                    `_Auto: ${(config.INTERVIEW_Q_TIMES || []).join(' · ') || '11:00 · 15:00 · 19:00'} IST · answer +${Math.round((config.INTERVIEW_Q_ANSWER_DELAY_MS || 1_800_000) / 60_000)}m_\n` +
                    `_Sat ${config.INTERVIEW_Q_SUMMARY_TIME || '22:00'} — weekly leaderboard + recap_`,
            },
            { quoted: originalMsg }
        );
    } catch (err) {
        logger.error(`Interview Q command failed: ${err.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${err.message}` }, { quoted: originalMsg });
    }
}

export async function handleInterviewQBoard(sock, chatId, senderJid, ctx) {
    return handleInterviewQ(sock, chatId, senderJid, ['board'], ctx);
}

/**
 * /tagme — be tagged in this group's Interview Q posts + leaderboards.
 * /notag — stop. Prefs are per group, stored in Mongo.
 */
export async function handleTagMe(sock, chatId, senderJid, args, ctx, wantsTag = true) {
    try {
        if (!isGroupMessage(chatId)) {
            await sock.sendMessage(
                chatId,
                { text: wantsTag ? 'Use `/tagme` in a group.' : 'Use `/notag` in a group.' },
                { quoted: ctx?.originalMsg }
            );
            return;
        }
        const { interviewQuestionService, originalMsg } = ctx;
        const store = interviewQuestionService?.store;
        if (!store?.setTagged) {
            await sock.sendMessage(chatId, { text: '⚠️ Tag prefs are not available right now.' }, { quoted: originalMsg });
            return;
        }

        const phone = extractPhoneNumber(senderJid);
        if (!phone) {
            await sock.sendMessage(
                chatId,
                { text: '⚠️ Could not resolve your number (privacy JID). Try again from the group.' },
                { quoted: originalMsg }
            );
            return;
        }

        await store.setTagged(chatId, phone, wantsTag, { jid: senderJid, name: ctx?.pushName || '' });

        // Mention works best with the group's own participant JID for this member.
        let mentionJid = senderJid;
        try {
            const p = await ctx.groupManager?.findParticipant?.(sock, chatId, senderJid, phone);
            if (p?.id) mentionJid = p.id;
        } catch { /* senderJid is fine */ }

        const name = (ctx?.pushName || '').trim() || 'You';
        const text = wantsTag
            ? `✅ Done, *${name}*! You'll be tagged in Interview Q posts & leaderboards here.\n💡 \`/notag\` anytime to stop.`
            : `👌 Okay *${name}*, no more tags from Interview Q here.\n💡 \`/tagme\` anytime to opt back in.`;
        await sock.sendMessage(
            chatId,
            wantsTag
                ? { text, mentions: [mentionJid] }
                : { text },
            { quoted: originalMsg }
        );
    } catch (err) {
        logger.error(`tagme/notag failed: ${err.message}`);
    }
}

export async function handleTagMeOn(sock, chatId, senderJid, args, ctx) {
    return handleTagMe(sock, chatId, senderJid, args, ctx, true);
}

export async function handleTagMeOff(sock, chatId, senderJid, args, ctx) {
    return handleTagMe(sock, chatId, senderJid, args, ctx, false);
}

export async function handleInterviewQOn(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        if (!isGroupMessage(chatId)) {
            await sock.sendMessage(chatId, { text: 'Use `/interviewqon` in a group.' }, { quoted: originalMsg });
            return;
        }
        const senderPhone = extractPhoneNumber(senderJid);
        const isActive = await groupManager.isGroupActive(chatId);
        if (!isActive) {
            await sock.sendMessage(
                chatId,
                {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *GROUP NOT ACTIVATED*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Use `/activate` first, then `/interviewqon`.',
                },
                { quoted: originalMsg }
            );
            return;
        }

        let groupName = 'Unknown Group';
        try {
            groupName = (await sock.groupMetadata(chatId)).subject;
        } catch {
            /* ignore */
        }

        await groupManager.setInterviewQEnabled(chatId, groupName, true, senderPhone);
        await sock.sendMessage(
            chatId,
            {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '✅ *INTERVIEW Q ON*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    `🧠 Daily MCQ polls at *${(config.INTERVIEW_Q_TIMES || ['11:00', '15:00', '19:00']).join(' · ')}* IST${config.INTERVIEW_Q_SKIP_SUNDAY !== false ? ' (Mon–Sat)' : ''}.\n` +
                    `Answer posts automatically after *${Math.round((config.INTERVIEW_Q_ANSWER_DELAY_MS || 1_800_000) / 60_000)} min*.\n` +
                    `🏆 Weekly leaderboard + recap every Sat *${config.INTERVIEW_Q_SUMMARY_TIME || '22:00'}* — or \`/iqboard\` anytime.\n\n` +
                    '💡 `/interviewqoff` to disable',
            },
            { quoted: originalMsg }
        );
    } catch (err) {
        logger.error(`interviewqon failed: ${err.message}`);
    }
}

export async function handleInterviewQOff(sock, chatId, senderJid, { groupManager, originalMsg }) {
    try {
        if (!isGroupMessage(chatId)) {
            await sock.sendMessage(chatId, { text: 'Use `/interviewqoff` in a group.' }, { quoted: originalMsg });
            return;
        }
        const senderPhone = extractPhoneNumber(senderJid);
        const enabled = await groupManager.isInterviewQEnabled(chatId);
        if (!enabled) {
            await sock.sendMessage(
                chatId,
                { text: 'Interview Q is already off here. Use `/interviewqon` to enable.' },
                { quoted: originalMsg }
            );
            return;
        }

        let groupName = 'Unknown Group';
        try {
            groupName = (await sock.groupMetadata(chatId)).subject;
        } catch {
            /* ignore */
        }

        await groupManager.setInterviewQEnabled(chatId, groupName, false, senderPhone);
        await sock.sendMessage(
            chatId,
            {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '🛑 *INTERVIEW Q OFF*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    'Daily interview polls disabled here.\n' +
                    '💡 `/interviewqon` to enable again',
            },
            { quoted: originalMsg }
        );
    } catch (err) {
        logger.error(`interviewqoff failed: ${err.message}`);
    }
}
