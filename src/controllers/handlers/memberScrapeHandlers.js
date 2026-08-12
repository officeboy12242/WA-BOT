/**
 * Owner-only group member scrape and broadcast handlers.
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { resolvePostMessage, editMessageText } from '../../utils/waMessage.js';
import { withOptOutFooter, resolveAccountJid } from '../../services/BroadcastService.js';

const BROADCAST_CMDS = ['broadcast'];
const GROUPPOST_CMDS = ['grouppost', 'groupmsg'];

const SCRAP_SESSION_MS = 5 * 60 * 1000;
const GROUP_POST_DELAY_MS = 2500;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err) {
    if (!err) {
        return 'Unknown error';
    }
    if (typeof err === 'string') {
        return err;
    }
    return err.message || err.output?.payload?.message || String(err);
}

function sessionKey(chatId, senderJid) {
    return `${chatId}|${senderJid}`;
}

function resolveSock(getSock, fallbackSock) {
    return (typeof getSock === 'function' ? getSock() : null) || fallbackSock;
}

export function createScrapSessionStore() {
    const store = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [key, session] of store) {
            if (now > session.expiresAt) store.delete(key);
        }
    }, 60_000);
    return store;
}

function formatGroupList(groups, { stored = false } = {}) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += stored ? '📋 *SCRAPED GROUP MEMBERS* 📋\n' : '👥 *SCRAPE GROUP MEMBERS* 👥\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    groups.forEach((group, index) => {
        const count = stored ? group.stored_count : group.member_count;
        text += `*${index + 1}.* ${group.group_name}\n`;
        text += `   👥 ${count} member(s)`;
        if (stored && group.dm_count != null) {
            text += `\n   📱 DM-able: ${group.dm_count}`;
            if (group.lid_dm_count) text += ` (${group.lid_dm_count} via resolved LID)`;
            // Unreachable members are stated rather than folded into the total,
            // which is what used to make the broadcast promise more than it sent.
            if (group.unreachable_count) text += `\n   🚫 Unreachable: ${group.unreachable_count}`;
        }
        if (stored && group.scraped_at) {
            text += `\n   📅 Last scraped: ${new Date(group.scraped_at).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                dateStyle: 'medium',
                timeStyle: 'short',
            })}`;
        }
        text += '\n\n';
    });

    if (!stored) {
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        text += 'Reply with the *group number* to scrape members.\n';
        text += 'Send *cancel* to abort.\n';
        text += '⏰ Expires in 5 minutes.';
    } else {
        text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        const totalMembers = groups.reduce((s, g) => s + (g.stored_count || 0), 0);
        const totalDmable = groups.reduce((s, g) => s + (g.dm_count || 0), 0);
        text += `📊 *${groups.length} group(s)* · ${totalMembers} member(s) · 📱 ${totalDmable} DM-able\n`;
        text += '_Combined counts are before de-duplication across groups._\n\n';
        text += '💡 `/broadcast <#|all> <msg>` — DM members (add `dry` to preview)\n';
        text += '💡 `/scrapclear <#|all|stale>` — delete saved members\n';
        text += '💡 `/grouppost <#|all> <msg>` — post in group(s)';
    }

    return text;
}

/** Twenty cells, so each block is a clean 5%. */
function progressBar(done, total, width = 20) {
    const pct = total > 0 ? Math.min(1, done / total) : 0;
    const filled = Math.round(pct * width);
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}  ${Math.round(pct * 100)}%`;
}

function humanDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

/**
 * Live progress card. Pacing is deliberately slow, so a run spans hours or
 * days — without this the owner has no idea whether it is working or stuck.
 */
function formatBroadcastProgress({ label, sent, failed, skippedOptOut, skippedUnreachable = 0, cursor, total, avgGapMs, capLeft, status }) {
    const remaining = Math.max(0, total - cursor);
    const eta = avgGapMs ? humanDuration(remaining * avgGapMs) : null;
    const lines = [
        `📤 *${status || 'Broadcasting…'}*${label ? ` — ${label}` : ''}`,
        '',
        progressBar(cursor, total),
        '',
        `✅ Sent *${sent}*${failed ? ` · ❌ ${failed}` : ''}${skippedOptOut ? ` · 🚫 ${skippedOptOut} opted out` : ''}${skippedUnreachable ? ` · 🚷 ${skippedUnreachable} blocks DMs` : ''}`,
        `⏳ *${remaining}* remaining${eta ? ` · ~${eta} left` : ''}`,
    ];
    if (capLeft != null) lines.push(`📅 ${capLeft} left in today's cap`);
    return lines.join('\n');
}

export async function handleScrap(sock, chatId, senderJid, args, { memberScrapeController, isOwnerFromJid, pendingScrapSessions, originalMsg }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can scrape group members.' }, { quoted: originalMsg });
        return;
    }

    if (!memberScrapeController) {
        await sock.sendMessage(chatId, { text: '⚠️ Member scrape is not configured.' }, { quoted: originalMsg });
        return;
    }

    if (args[0]?.toLowerCase() === 'cancel') {
        pendingScrapSessions.delete(sessionKey(chatId, senderJid));
        await sock.sendMessage(chatId, { text: '❌ Group scrape cancelled.' }, { quoted: originalMsg });
        return;
    }

    const groups = await memberScrapeController.fetchParticipatingGroups(sock);
    if (!groups.length) {
        await sock.sendMessage(chatId, { text: '📭 No groups found that the bot is in.' }, { quoted: originalMsg });
        return;
    }

    pendingScrapSessions.set(sessionKey(chatId, senderJid), {
        groups,
        expiresAt: Date.now() + SCRAP_SESSION_MS,
    });

    await sock.sendMessage(chatId, { text: formatGroupList(groups) }, { quoted: originalMsg });
    logger.info(`Member scrape list sent to ${extractPhoneNumber(senderJid)} (${groups.length} groups)`);
}

export async function handleScrapMembers(sock, chatId, senderJid, { memberScrapeController, isOwnerFromJid, originalMsg }) {
    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can view scraped members.' }, { quoted: originalMsg });
        return;
    }

    if (!memberScrapeController) {
        await sock.sendMessage(chatId, { text: '⚠️ Member scrape is not configured.' }, { quoted: originalMsg });
        return;
    }

    // Pass the socket so LIDs resolve — without it the DM-able count reads
    // lower than reality and looks like the scrape lost members.
    const groups = await memberScrapeController.getStoredGroupsWithCounts(sock);
    if (!groups.length) {
        await sock.sendMessage(chatId, {
            text: '📭 No scraped members yet.\n\nUse `/scrap` to pick a group and save its members.',
        }, { quoted: originalMsg });
        return;
    }

    await sock.sendMessage(chatId, { text: formatGroupList(groups, { stored: true }) }, { quoted: originalMsg });
}

/**
 * Delete saved members — one group, everything, or just the stale rows.
 *
 * Confirmation is required for anything irreversible: scraping a 900-member
 * group again is slow, and there is no undo on a delete.
 */
export async function handleScrapClear(sock, chatId, senderJid, args, ctx) {
    const { memberScrapeController, isOwnerFromJid, originalMsg, pendingScrapSessions } = ctx;

    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owners can clear scraped members.' }, { quoted: originalMsg });
        return;
    }
    if (!memberScrapeController) {
        await sock.sendMessage(chatId, { text: '⚠️ Member scrape is not configured.' }, { quoted: originalMsg });
        return;
    }

    const arg = String(args[0] || '').trim().toLowerCase();
    const groups = await memberScrapeController.getStoredGroupsWithCounts(sock);

    if (!groups.length) {
        await sock.sendMessage(chatId, { text: '📭 Nothing saved to clear.' }, { quoted: originalMsg });
        return;
    }

    // Stale purge is safe enough to run without a confirmation step: it only
    // removes people who have not appeared in a scrape for a long time.
    if (arg === 'stale') {
        const days = Math.max(7, parseInt(args[1], 10) || 60);
        const res = await memberScrapeController.pruneStale(days);
        await sock.sendMessage(chatId, {
            text: res.removed
                ? `🧹 Removed *${res.removed}* member(s) not seen in a scrape for ${days}+ days.`
                : `✅ Nothing stale — every saved member was scraped within ${days} days.`,
        }, { quoted: originalMsg });
        return;
    }

    if (!arg) {
        const list = groups
            .map((g, i) => `*${i + 1}.* ${g.group_name} — ${g.stored_count} member(s)`)
            .join('\n');
        await sock.sendMessage(chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🗑️ *CLEAR SCRAPED MEMBERS* 🗑️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `${list}\n\n` +
                '• `/scrapclear <#>` — delete one group\n' +
                '• `/scrapclear all` — delete everything\n' +
                '• `/scrapclear stale [days]` — drop members not seen in 60+ days\n\n' +
                '_Deleting is permanent; re-scraping a large group takes a while._',
        }, { quoted: originalMsg });
        return;
    }

    const wantsAll = arg === 'all';
    const index = wantsAll ? null : parseInt(arg, 10);
    const selected = wantsAll ? null : groups[index - 1];

    if (!wantsAll && !selected) {
        await sock.sendMessage(chatId, {
            text: `❌ Invalid group number. Choose 1–${groups.length}, \`all\`, or \`stale\`.`,
        }, { quoted: originalMsg });
        return;
    }

    const target = wantsAll
        ? { label: `ALL ${groups.length} group(s)`, count: groups.reduce((s, g) => s + (g.stored_count || 0), 0) }
        : { label: selected.group_name, count: selected.stored_count };

    const key = sessionKey(chatId, senderJid);
    const pending = pendingScrapSessions?.get(key);

    if (pending?.clearTarget && pending.clearTarget.arg === arg && Date.now() < pending.expiresAt) {
        pendingScrapSessions.delete(key);
        const res = wantsAll
            ? await memberScrapeController.clearAllGroups()
            : await memberScrapeController.clearGroup(selected.group_id);
        await sock.sendMessage(chatId, {
            text: `🗑️ Deleted *${res.removed}* saved member(s) from *${target.label}*.`,
        }, { quoted: originalMsg });
        logger.info(`Scrape data cleared: ${target.label} (${res.removed} members) by ${extractPhoneNumber(senderJid)}`);
        return;
    }

    pendingScrapSessions?.set(key, {
        clearTarget: { arg },
        groups: [],
        expiresAt: Date.now() + 60_000,
    });
    await sock.sendMessage(chatId, {
        text:
            `⚠️ This deletes *${target.count}* saved member(s) from *${target.label}*.\n\n` +
            `Run \`/scrapclear ${arg}\` again within 60s to confirm.`,
    }, { quoted: originalMsg });
}

export async function handleBroadcast(sock, chatId, senderJid, args, ctx) {
    const {
        memberScrapeController, isOwnerFromJid, getSock, originalMsg,
        fullCommand, broadcastService, broadcastOptOutStore,
    } = ctx;
    try {
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only bot owners can send member broadcasts.' }, { quoted: originalMsg });
            return;
        }

        if (!memberScrapeController || !broadcastService) {
            await sock.sendMessage(chatId, { text: '⚠️ Member broadcast is not configured.' }, { quoted: originalMsg });
            return;
        }

        const firstArg = args[0]?.toLowerCase();

        /* ── control verbs ───────────────────────────────────────────────── */

        if (firstArg === 'stop' || firstArg === 'abort' || firstArg === 'cancel') {
            const running = await broadcastService.findResumable();
            if (!running.length) {
                await sock.sendMessage(chatId, { text: '📭 No broadcast is running.' }, { quoted: originalMsg });
                return;
            }
            for (const job of running) broadcastService.abort(job._id);
            await sock.sendMessage(chatId, {
                text: `🛑 Stopping ${running.length} broadcast(s). Progress is saved — \`/broadcast resume\` picks up where it stopped.`,
            }, { quoted: originalMsg });
            return;
        }

        if (firstArg === 'status') {
            const jobs = await broadcastService.findResumable();
            const remaining = await broadcastService.remainingToday(resolveAccountJid(sock));
            let text = `📊 *Broadcast status*\n\n📅 Left in today's cap: *${remaining}*\n🚫 Opted out: *${broadcastOptOutStore?.size ?? 0}*\n\n`;
            text += jobs.length
                ? jobs.map((j) => broadcastService.formatJobSummary(j, { label: j.label })).join('\n\n')
                : '_No active or paused broadcasts._';
            await sock.sendMessage(chatId, { text }, { quoted: originalMsg });
            return;
        }

        if (firstArg === 'resume') {
            const jobs = await broadcastService.findResumable();
            if (!jobs.length) {
                await sock.sendMessage(chatId, { text: '📭 Nothing to resume.' }, { quoted: originalMsg });
                return;
            }
            await sock.sendMessage(chatId, {
                text: `▶️ Resuming ${jobs.length} broadcast(s) from where they stopped.`,
            }, { quoted: originalMsg });
            for (const job of jobs) {
                void startBroadcastJob(broadcastService, getSock, chatId, job._id, job.label);
            }
            return;
        }

        // `dry` anywhere in the args previews the audience without sending.
        const isDryRun = args.some((a) => /^(dry|dryrun|preview|test)$/i.test(String(a || '')));
        const isAll = firstArg === 'all';
        let message = resolvePostMessage(
            fullCommand || '',
            BROADCAST_CMDS,
            isAll ? { type: 'all' } : { type: 'index' },
            originalMsg,
        ).trim();
        if (isDryRun) {
            message = message.replace(/^\s*(dry|dryrun|preview|test)\b\s*/i, '').trim() || '(preview)';
        }

        if (isAll) {
            if (!message) {
                await sock.sendMessage(chatId, {
                    text:
                        '❌ Usage: `/broadcast all <message>`\n\n' +
                        'DMs every unique member from *all* scraped groups (one message per person).\n' +
                        'Multiline messages are preserved. Or *reply* to a message with `/broadcast all`.\n' +
                        'Run `/scrap` on each group first, then `/scrapmembers` to verify.',
                }, { quoted: originalMsg });
                return;
            }

            const { groups, targets, unreachable } = await memberScrapeController.getAllDedupedDmTargets(sock);
            if (!groups.length) {
                await sock.sendMessage(chatId, {
                    text: '❌ No scraped groups yet. Run `/scrap` on your groups first.',
                }, { quoted: originalMsg });
                return;
            }

            const sendable = broadcastOptOutStore ? broadcastOptOutStore.filter(targets) : targets;
            if (!sendable.length) {
                await sock.sendMessage(chatId, {
                    text: '📭 No reachable DM targets across scraped groups. Re-run `/scrap` on your groups.',
                }, { quoted: originalMsg });
                return;
            }

            await launchBroadcast({
                sock, chatId, originalMsg, getSock, broadcastService, broadcastOptOutStore,
                label: `all groups (${groups.length})`,
                message,
                targets: sendable,
                suppressed: targets.length - sendable.length,
                unreachable,
                dryRun: isDryRun,
            });
            return;
        }

        const groupIndex = parseInt(args[0], 10);

        if (!Number.isFinite(groupIndex) || groupIndex < 1 || !message) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage:\n' +
                    '• `/broadcast <group#> <message>`\n' +
                    '• `/broadcast all <message>`\n\n' +
                    'Multiline format is kept. Or *reply* to a message with `/broadcast <#>`.\n' +
                    'Use `/scrapmembers` to see group numbers from scraped data.',
            }, { quoted: originalMsg });
            return;
        }

        const groups = await memberScrapeController.getStoredGroupsWithCounts(sock);
        const selected = groups[groupIndex - 1];
        if (!selected) {
            await sock.sendMessage(chatId, {
                text: groups.length
                    ? `❌ Invalid group number. Choose 1–${groups.length}.`
                    : '❌ No scraped groups yet. Run `/scrap` first.',
            }, { quoted: originalMsg });
            return;
        }

        const resolved = await memberScrapeController.resolveDmTargets(selected.group_id, sock);
        const reachable = memberScrapeController.filterTargetsForBroadcast(resolved.targets, sock);
        const sendable = broadcastOptOutStore ? broadcastOptOutStore.filter(reachable) : reachable;

        if (!sendable.length) {
            await sock.sendMessage(chatId, {
                text:
                    `📭 No reachable DM targets for *${selected.group_name}*.\n` +
                    (resolved.unreachable
                        ? `_${resolved.unreachable} member(s) hide their number and WhatsApp has never revealed it to this account._\n`
                        : '') +
                    '\nRe-run `/scrap` on that group first.',
            }, { quoted: originalMsg });
            return;
        }

        await launchBroadcast({
            sock, chatId, originalMsg, getSock, broadcastService, broadcastOptOutStore,
            label: selected.group_name,
            message,
            targets: sendable,
            suppressed: reachable.length - sendable.length,
            unreachable: resolved.unreachable,
            lidResolved: resolved.lidResolved,
            dryRun: isDryRun,
        });
    } catch (err) {
        logger.error(`Broadcast command failed: ${formatError(err)}`);
        await sock.sendMessage(chatId, {
            text: `❌ Broadcast failed: ${formatError(err)}`,
        }, { quoted: originalMsg });
    }
}

/** Edits are API traffic too — refresh the bar at most this often. */
const PROGRESS_EDIT_MS = 25_000;

/**
 * Confirm the audience, then start (or just preview) the job.
 *
 * The preview exists because the old code announced a recipient count that
 * included LID-only members it could never actually deliver to.
 */
async function launchBroadcast({
    sock, chatId, originalMsg, getSock, broadcastService, broadcastOptOutStore,
    label, message, targets, suppressed = 0, unreachable = 0, lidResolved = 0, dryRun = false,
}) {
    const accountJid = resolveAccountJid(sock);
    const capLeft = await broadcastService.remainingToday(accountJid);
    const o = broadcastService.opts;
    const avgGap = (o.minGapMs + o.maxGapMs) / 2;
    const pauses = Math.floor(targets.length / o.batchSize) * ((o.batchPauseMinMs + o.batchPauseMaxMs) / 2);
    const dayInfo = broadcastService.pacing?.enabled
        ? await broadcastService.pacing.accountDayInfo(accountJid).catch(() => null)
        : null;
    const effectiveCap = dayInfo ? Math.min(o.dailyCap, dayInfo.warmupAllowance) : o.dailyCap;
    const days = Math.ceil(targets.length / Math.max(1, effectiveCap));

    // Pre-flight: sample targets for cached privacy tokens so the owner sees
    // how many are DM-ready right now vs. how many need a first-attempt token
    // issuance (still deliverable) before the daily cap is spent.
    const readiness = await broadcastService.sampleDmReadiness(sock, targets, 10).catch(() => null);
    const readinessLine = readiness?.sampled
        ? `📡 DM readiness: *${readiness.withToken}/${readiness.sampled}* sampled have tokens cached` +
            (readiness.unreadable ? ' (a few unreadable)' : '') +
            ' — the rest get issued on first attempt'
        : null;

    const plan = [
        `📋 *Broadcast plan* — ${label}`,
        '',
        `👥 Will DM: *${targets.length}*`,
        lidResolved ? `🔓 LIDs resolved to numbers: *${lidResolved}*` : null,
        unreachable ? `🚫 Unreachable (number hidden): *${unreachable}*` : null,
        suppressed ? `🔕 Skipped (opted out): *${suppressed}*` : null,
        readinessLine,
        '',
        `⏱ Pace: ${Math.round(o.minGapMs / 1000)}–${Math.round(o.maxGapMs / 1000)}s apart, ` +
            `pausing after every ${o.batchSize}`,
        dayInfo
            ? `📈 Account day *${dayInfo.ageDays}* · 📅 allowance *${effectiveCap}* (≤ *${dayInfo.coldAllowance}* new people) · *${capLeft}* left today` +
                (days > 1 ? ` · spans ~${days} day(s)` : '')
            : `📅 Daily cap ${o.dailyCap} · *${capLeft}* left today` + (days > 1 ? ` · spans ~${days} day(s)` : ''),
        `⌛ Estimated: ~${humanDuration(targets.length * avgGap + pauses)} of sending`,
    ].filter(Boolean).join('\n');

    if (dryRun) {
        await sock.sendMessage(chatId, {
            text: `${plan}\n\n_Dry run — nothing sent. Remove \`dry\` to go ahead._`,
        }, { quoted: originalMsg });
        return;
    }

    const jobId = await broadcastService.createJob({
        label,
        message: withOptOutFooter(message),
        targets,
        chatId,
    });

    await sock.sendMessage(chatId, {
        text: `${plan}\n\n_Starting. \`/broadcast status\` anytime · \`/broadcast stop\` to halt._`,
    }, { quoted: originalMsg });

    void startBroadcastJob(broadcastService, getSock, chatId, jobId, label);
}

/**
 * Run a job and keep one message updated with a live progress bar, rather
 * than posting a new status line per recipient.
 */
async function startBroadcastJob(broadcastService, getSock, chatId, jobId, label) {
    const sock = getSock?.();
    let progressKey = null;
    let lastEdit = 0;
    const startedAt = Date.now();

    const render = async (p, status) => {
        const notify = getSock?.();
        if (!notify) return;
        const avgGapMs = p.sent > 0 ? (Date.now() - startedAt) / p.sent : null;
        const text = formatBroadcastProgress({
            label,
            ...p,
            avgGapMs,
            capLeft: await broadcastService.remainingToday().catch(() => null),
            status,
        });
        try {
            if (progressKey) await editMessageText(notify, chatId, progressKey, text);
            else progressKey = (await notify.sendMessage(chatId, { text }))?.key || null;
        } catch {
            // A failed progress edit must never abort the broadcast itself.
        }
    };

    try {
        const job = await broadcastService.getJob(jobId);
        await render(
            {
                sent: job?.sent || 0, failed: job?.failed || 0, skippedOptOut: job?.skipped_opt_out || 0,
                skippedUnreachable: job?.skipped_unreachable || 0,
                cursor: job?.cursor || 0, total: job?.targets?.length || 0,
            },
            'Broadcasting…'
        );

        const final = await broadcastService.run({
            getSock,
            jobId,
            onProgress: (p) => {
                const now = Date.now();
                if (now - lastEdit < PROGRESS_EDIT_MS) return;
                lastEdit = now;
                void render(p, 'Broadcasting…');
            },
        });

        await render(
            {
                sent: final.sent,
                failed: final.failed,
                skippedOptOut: final.skipped_opt_out || 0,
                skippedUnreachable: final.skipped_unreachable || 0,
                cursor: final.cursor,
                total: final.targets?.length || 0,
            },
            final.status === 'DONE' ? 'Broadcast complete' : `Broadcast ${final.status}`
        );

        const notify = getSock?.() || sock;
        if (notify && final.note) {
            await notify.sendMessage(chatId, { text: broadcastService.formatJobSummary(final, { label }) }).catch(() => {});
        }
    } catch (err) {
        logger.error(`Broadcast job ${jobId} crashed: ${formatError(err)}`);
        const notify = getSock?.() || sock;
        await notify?.sendMessage(chatId, {
            text: `❌ Broadcast stopped: ${formatError(err)}\n\n_Progress is saved — \`/broadcast resume\` continues._`,
        }).catch(() => {});
    }
}

export async function handleGroupPost(sock, chatId, senderJid, args, { memberScrapeController, isOwnerFromJid, getSock, originalMsg, fullCommand }) {
    try {
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only bot owners can post to groups.' }, { quoted: originalMsg });
            return;
        }

        if (!memberScrapeController) {
            await sock.sendMessage(chatId, { text: '⚠️ Group post is not configured.' }, { quoted: originalMsg });
            return;
        }

        const firstArg = args[0]?.toLowerCase();
        const isAll = firstArg === 'all';
        const message = resolvePostMessage(
            fullCommand || '',
            GROUPPOST_CMDS,
            isAll ? { type: 'all' } : { type: 'index' },
            originalMsg,
        ).trim();

        if (isAll) {
            if (!message) {
                await sock.sendMessage(chatId, {
                    text:
                        '❌ Usage: `/grouppost all <message>`\n\n' +
                        'Posts the same message in every group the bot is in.\n' +
                        'Multiline format is kept. Or *reply* to a message with `/grouppost all`.',
                }, { quoted: originalMsg });
                return;
            }

            const groups = await memberScrapeController.fetchParticipatingGroups(sock);
            if (!groups.length) {
                await sock.sendMessage(chatId, { text: '📭 No groups found that the bot is in.' }, { quoted: originalMsg });
                return;
            }

            await sock.sendMessage(chatId, {
                text:
                    `📤 Posting to *${groups.length}* group(s)...\n\n` +
                    '_Running in background — other bot commands keep working._',
            }, { quoted: originalMsg });

            void runGroupPostAllJob(getSock, sock, chatId, groups, message).catch((err) => {
                logger.error(`Grouppost-all job error: ${formatError(err)}`);
            });
            return;
        }

        const groupIndex = parseInt(args[0], 10);

        if (!Number.isFinite(groupIndex) || groupIndex < 1 || !message) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage:\n' +
                    '• `/grouppost <group#> <message>`\n' +
                    '• `/grouppost all <message>`\n\n' +
                    'Multiline format is kept. Or *reply* to a message with `/grouppost <#>`.\n' +
                    'Posts in the WhatsApp group (everyone including LID users).\n' +
                    'Use `/scrapmembers` for group numbers.',
            }, { quoted: originalMsg });
            return;
        }

        const groups = await memberScrapeController.getStoredGroupsWithCounts();
        const selected = groups[groupIndex - 1];
        if (!selected) {
            await sock.sendMessage(chatId, {
                text: groups.length
                    ? `❌ Invalid group number. Choose 1–${groups.length}.`
                    : '❌ No scraped groups yet. Run `/scrap` first.',
            }, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(selected.group_id, { text: message });
        await sock.sendMessage(chatId, {
            text: `✅ Posted to group *${selected.group_name}*.\n\n_All members in that group can see it._`,
        }, { quoted: originalMsg });

        logger.info(`Group post sent to ${selected.group_name} (${selected.group_id})`);
    } catch (err) {
        logger.error(`Group post failed: ${formatError(err)}`);
        await sock.sendMessage(chatId, {
            text: `❌ Group post failed: ${formatError(err)}`,
        }, { quoted: originalMsg });
    }
}

async function runGroupPostAllJob(getSock, fallbackSock, chatId, groups, message) {
    let sent = 0;
    let failed = 0;
    const failedNames = [];

    try {
        for (const group of groups) {
            const sock = resolveSock(getSock, fallbackSock);
            if (!sock) {
                throw new Error('WhatsApp disconnected during group post');
            }

            try {
                await sock.sendMessage(group.group_id, { text: message });
                sent++;
                logger.info(`Grouppost-all sent to ${group.group_name}`);
            } catch (err) {
                failed++;
                failedNames.push(group.group_name);
                logger.warn(`Grouppost-all failed for ${group.group_name}: ${formatError(err)}`);
            }

            await delay(GROUP_POST_DELAY_MS);
        }

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            let text =
                `✅ Grouppost-all done\n\n` +
                `📤 Posted: *${sent}* / ${groups.length}\n` +
                `❌ Failed: *${failed}*`;
            if (failedNames.length) {
                text += `\n\n_Failed:_ ${failedNames.slice(0, 8).join(', ')}`;
                if (failedNames.length > 8) text += ` +${failedNames.length - 8} more`;
            }
            await notifySock.sendMessage(chatId, { text });
        }
    } catch (err) {
        logger.error(`Grouppost-all job failed: ${formatError(err)}`);
        try {
            const notifySock = resolveSock(getSock, fallbackSock);
            await notifySock?.sendMessage(chatId, {
                text:
                    `❌ Grouppost-all stopped\n\n` +
                    `📤 Posted: *${sent}*\n` +
                    `❌ Failed: *${failed}*\n` +
                    `⚠️ Error: ${formatError(err)}`,
            });
        } catch (notifyErr) {
            logger.error(`Could not send grouppost-all failure notice: ${formatError(notifyErr)}`);
        }
    }
}

async function runScrapeJob(getSock, fallbackSock, chatId, memberScrapeController, selected) {
    try {
        const sock = resolveSock(getSock, fallbackSock);
        if (!sock) {
            throw new Error('WhatsApp disconnected');
        }

        const result = await memberScrapeController.scrapeGroup(sock, selected.group_id, selected.group_name);
        // Pass the socket so LIDs resolve; otherwise the DM-able figure reads
        // low and looks like the scrape lost people.
        const dmStats = await memberScrapeController.getDmTargetStats(selected.group_id, sock);

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            // Roll-up of every stored group, so one card answers "what do I
            // actually have saved right now" without a second command.
            const allGroups = await memberScrapeController.getStoredGroupsWithCounts(notifySock);
            const totalMembers = allGroups.reduce((s, g) => s + (g.stored_count || 0), 0);
            const totalDmable = allGroups.reduce((s, g) => s + (g.dm_count || 0), 0);

            const roster = allGroups
                .map((g, i) => {
                    const mark = g.group_id === selected.group_id ? ' ⬅️ just scraped' : '';
                    return `${i + 1}. *${g.group_name}* — ${g.stored_count} member(s) · 📱 ${g.dm_count} DM-able${mark}`;
                })
                .join('\n');

            await notifySock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '✅ *MEMBERS SCRAPED* ✅\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${result.group_name}\n` +
                    `👥 *Total:* ${result.total}\n` +
                    `🆕 *New:* ${result.inserted}\n` +
                    `🔄 *Updated:* ${result.updated}\n` +
                    (result.removed ? `🗑️ *Left the group:* ${result.removed} (removed)\n` : '') +
                    `📱 *DM-able:* ${dmStats.dm_count}` +
                    (dmStats.lid_dm_count ? ` (${dmStats.lid_dm_count} via resolved LID)` : '') +
                    '\n' +
                    (dmStats.unreachable_count ? `🚫 *Unreachable:* ${dmStats.unreachable_count} (number hidden)\n` : '') +
                    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    `📚 *ALL SAVED GROUPS* (${allGroups.length})\n\n` +
                    `${roster}\n\n` +
                    `📊 *Combined:* ${totalMembers} member(s) · 📱 ${totalDmable} DM-able\n` +
                    '_Combined counts are before de-duplication across groups._\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 `/broadcast <#|all> <msg>` · add `dry` to preview\n' +
                    '💡 `/scrapclear <#|all>` — delete saved members\n' +
                    '💡 `/grouppost <#|all> <msg>` — post in group(s)',
            });
        }

        logger.info(
            `Scraped ${result.total} members from ${result.group_name}` +
                (result.removed ? ` (${result.removed} left the group, removed)` : '')
        );
    } catch (err) {
        logger.error(`Member scrape failed: ${formatError(err)}`);
        try {
            const notifySock = resolveSock(getSock, fallbackSock);
            await notifySock?.sendMessage(chatId, {
                text: `❌ Failed to scrape *${selected.group_name}*.\n\n⚠️ ${formatError(err)}`,
            });
        } catch (notifyErr) {
            logger.error(`Could not send scrape failure notice: ${formatError(notifyErr)}`);
        }
    }
}

export async function handlePendingScrapSelection(sock, chatId, senderJid, text, { memberScrapeController, pendingScrapSessions, isOwnerFromJid, getSock, originalMsg }) {
    const key = sessionKey(chatId, senderJid);
    const session = pendingScrapSessions.get(key);
    if (!session) {
        return false;
    }
    // A pending /scrapclear confirmation shares this store but has no group
    // list — without this, a stray number would be answered with
    // "reply with a number between 1 and 0".
    if (session.clearTarget) {
        return false;
    }

    const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
    if (!isOwner) {
        pendingScrapSessions.delete(key);
        return false;
    }

    if (Date.now() > session.expiresAt) {
        pendingScrapSessions.delete(key);
        await sock.sendMessage(chatId, { text: '⏰ Group scrape session expired. Run `/scrap` again.' }, { quoted: originalMsg });
        return true;
    }

    const trimmed = text.trim();
    if (/^cancel$/i.test(trimmed)) {
        pendingScrapSessions.delete(key);
        await sock.sendMessage(chatId, { text: '❌ Group scrape cancelled.' }, { quoted: originalMsg });
        return true;
    }

    const choice = parseInt(trimmed, 10);
    if (!Number.isFinite(choice) || choice < 1 || choice > session.groups.length) {
        await sock.sendMessage(chatId, {
            text: `❌ Reply with a number between *1* and *${session.groups.length}*, or *cancel*.`,
        }, { quoted: originalMsg });
        return true;
    }

    pendingScrapSessions.delete(key);
    const selected = session.groups[choice - 1];

    await sock.sendMessage(chatId, {
        text:
            `⏳ Scraping *${selected.group_name}* in the background...\n\n` +
            '_Other bot commands keep working — you will get a summary when done._',
    }, { quoted: originalMsg });

    void runScrapeJob(getSock, sock, chatId, memberScrapeController, selected).catch((err) => {
        logger.error(`Scrape job error: ${formatError(err)}`);
    });

    return true;
}
