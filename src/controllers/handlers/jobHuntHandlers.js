/**
 * /jobhunt commands
 */

import { extractPhoneNumber, isGroupMessage } from '../../utils/permissions.js';
import { logger } from '../../utils/logger.js';
import { formatJobHuntDigest, formatJobHuntLimitAlert } from '../../utils/jobHuntFormatter.js';

export async function handleJobHunt(sock, chatId, senderJid, args, ctx) {
    const { jobHuntController, groupManager, botSettings, originalMsg } = ctx;
    const senderPhone = extractPhoneNumber(senderJid);
    const isOwner = groupManager?.isOwner?.(senderPhone);
    const action = (args[0] || '').toLowerCase();

    if (!jobHuntController) {
        await sock.sendMessage(chatId, { text: '❌ Job hunt is not available on this bot.' }, { quoted: originalMsg });
        return;
    }

    try {
        if (!action || action === 'status' || action === 'help') {
            const text = await jobHuntController.getStatus();
            await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
            return;
        }

        if (action === 'on' || action === 'off') {
            if (!isGroupMessage(chatId)) {
                await sock.sendMessage(chatId, {
                    text: 'ℹ️ Use `/jobhunt on|off` *in a group*. For owner DMs use `/jobhunt dm on|off`.',
                }, { quoted: originalMsg });
                return;
            }
            if (!groupManager.isStaff?.(senderPhone) && !isOwner) {
                await sock.sendMessage(chatId, { text: '❌ Staff/owner only.' }, { quoted: originalMsg });
                return;
            }
            let groupName = 'Group';
            try {
                groupName = (await sock.groupMetadata(chatId)).subject;
            } catch {}
            const enabled = action === 'on';
            await groupManager.setJobHuntEnabled(chatId, groupName, enabled, senderPhone);
            await sock.sendMessage(chatId, {
                text: enabled
                    ? `✅ *Job Hunt ON* for *${groupName}*\nNightly matches will post here.`
                    : `🛑 *Job Hunt OFF* for *${groupName}*`,
            }, { quoted: originalMsg });
            return;
        }

        if (action === 'dm') {
            if (!isOwner) {
                await sock.sendMessage(chatId, { text: '❌ Owner only.' }, { quoted: originalMsg });
                return;
            }
            const sub = (args[1] || '').toLowerCase();
            if (sub !== 'on' && sub !== 'off') {
                await sock.sendMessage(chatId, { text: 'Usage: `/jobhunt dm on` or `/jobhunt dm off`' }, { quoted: originalMsg });
                return;
            }
            await jobHuntController.setOwnerDmEnabled(sub === 'on');
            await sock.sendMessage(chatId, {
                text: sub === 'on' ? '✅ Owner DM job alerts *ON*' : '🛑 Owner DM job alerts *OFF*',
            }, { quoted: originalMsg });
            return;
        }

        if (action === 'top') {
            await sock.sendMessage(chatId, { text: '🔎 Checking links are still live…' }, { quoted: originalMsg });
            let jobs = await jobHuntController.scanner.getLatestScanJobs(
                Math.max(jobHuntController.getCandidate().topN * 3, 15),
            );
            jobs = await jobHuntController.scanner.revalidateJobs(jobs);
            jobs = jobs.slice(0, jobHuntController.getCandidate().topN);
            const text = formatJobHuntDigest(jobs, { scanDate: jobs[0]?.scan_date });
            await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
            return;
        }

        if (action === 'scan') {
            if (!isOwner) {
                await sock.sendMessage(chatId, { text: '❌ Only owners can trigger a full scan.' }, { quoted: originalMsg });
                return;
            }
            if (jobHuntController.scanner.isBusy()) {
                await sock.sendMessage(chatId, { text: '🟡 Scan already running — please wait.' }, { quoted: originalMsg });
                return;
            }
            await sock.sendMessage(chatId, {
                text:
                    '🚀 Starting *India* job hunt…\n' +
                    '🔎 Naukri → Indeed → LinkedIn\n' +
                    '_Usually 5–15 min. Digest arrives when done._',
            }, { quoted: originalMsg });
            void jobHuntController.runAndNotify(sock).catch(async (err) => {
                logger.error(`JobHunt manual scan failed: ${err.message}`);
                await sock.sendMessage(chatId, { text: `❌ Scan failed: ${err.message}` }).catch(() => {});
            });
            return;
        }

        if (action === 'draft') {
            const n = parseInt(args[1], 10);
            if (!Number.isFinite(n) || n < 1) {
                await sock.sendMessage(chatId, { text: 'Usage: `/jobhunt draft 1`' }, { quoted: originalMsg });
                return;
            }
            await sock.sendMessage(chatId, { text: `✏️ Drafting application for *#${n}*…` }, { quoted: originalMsg });
            const { message, warnings } = await jobHuntController.draftForIndex(n);
            if (warnings?.length) {
                await sock.sendMessage(chatId, { text: formatJobHuntLimitAlert(warnings, []) });
            }
            // Split if too long
            if (message.length > 3500) {
                const mid = message.indexOf('─────────────────────────────', 200);
                const cut = mid > 0 ? mid : 3500;
                await sock.sendMessage(chatId, { text: message.slice(0, cut) });
                await sock.sendMessage(chatId, { text: message.slice(cut) });
            } else {
                await sock.sendMessage(chatId, { text: message });
            }
            return;
        }

        if (action === 'resume') {
            if (!isOwner) {
                await sock.sendMessage(chatId, { text: '❌ Owner only.' }, { quoted: originalMsg });
                return;
            }
            const text = args.slice(1).join(' ').trim();
            if (!text || text.length < 40) {
                await sock.sendMessage(chatId, {
                    text:
                        '📄 *Set resume*\n\n' +
                        '`/jobhunt resume Your full resume text here...`\n\n' +
                        '_Or set `JOB_HUNT_RESUME` on the server._',
                }, { quoted: originalMsg });
                return;
            }
            await botSettings.setJobHuntResume(text.slice(0, 20_000));
            await sock.sendMessage(chatId, {
                text: `✅ Resume saved (${Math.min(text.length, 20000)} chars). Next scan will use it.`,
            }, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(chatId, {
            text: await jobHuntController.getStatus(),
        }, { quoted: originalMsg });
    } catch (err) {
        logger.error(`JobHunt command error: ${err.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${err.message}` }, { quoted: originalMsg }).catch(() => {});
    }
}
