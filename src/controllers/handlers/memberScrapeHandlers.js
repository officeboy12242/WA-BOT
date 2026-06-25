/**
 * Owner-only group member scrape and broadcast handlers.
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { resolvePostMessage } from '../../utils/waMessage.js';

const BROADCAST_CMDS = ['broadcast'];
const GROUPPOST_CMDS = ['grouppost', 'groupmsg'];

const SCRAP_SESSION_MS = 5 * 60 * 1000;
const BROADCAST_DELAY_MS = 3500;
const GROUP_POST_DELAY_MS = 2500;
const TCTOKEN_RECOVERY_DELAY_MS = 6000;

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
            if (group.phone_dm_count != null || group.lid_dm_count != null) {
                text += ` (${group.phone_dm_count || 0} phone · ${group.lid_dm_count || 0} LID)`;
            }
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
        text += '💡 `/broadcast <#> <message>` or `/broadcast all <message>` — DM members\n';
        text += '💡 `/grouppost <#> <message>` or `/grouppost all <message>` — post in group(s)';
    }

    return text;
}

/**
 * Check if we already hold a privacy token (tctoken) for the given JID.
 * Tokens are stored in the auth database under `tctoken-{jid}`.  For phone
 * JIDs the token is stored under the LID equivalent, so we resolve via the
 * Baileys LID mapping.
 */
async function hasTcToken(authDB, sock, targetJid) {
    if (!authDB) return false;
    if (authDB.get(`tctoken-${targetJid}`)) return true;

    if (targetJid.endsWith('@s.whatsapp.net')) {
        try {
            const phone = targetJid.split('@')[0];
            const lid = await sock?.signalRepository?.lidMapping?.getLIDForPN?.(phone);
            if (lid) {
                const lidJid = jidNormalizedUser(lid) || lid;
                if (authDB.get(`tctoken-${lidJid}`)) return true;
            }
        } catch { /* ignore */ }
    }

    return false;
}

/**
 * Send a DM for broadcast.  When the target has no tctoken the first
 * sendMessage triggers a background 463 recovery issuance inside Baileys.
 * The original message is silently lost, so we wait for the recovery to
 * complete and then re-send.
 */
async function sendDmWithRetry(sock, targetJid, message, authDB) {
    const hadToken = await hasTcToken(authDB, sock, targetJid);

    await sock.sendMessage(targetJid, { text: message });

    if (!hadToken) {
        logger.info(`No tctoken for ${targetJid} — waiting for 463 recovery before re-send`);
        await delay(TCTOKEN_RECOVERY_DELAY_MS);
        await sock.sendMessage(targetJid, { text: message });
    }
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

    const groups = await memberScrapeController.getStoredGroupsWithCounts();
    if (!groups.length) {
        await sock.sendMessage(chatId, {
            text: '📭 No scraped members yet.\n\nUse `/scrap` to pick a group and save its members.',
        }, { quoted: originalMsg });
        return;
    }

    await sock.sendMessage(chatId, { text: formatGroupList(groups, { stored: true }) }, { quoted: originalMsg });
}

export async function handleBroadcast(sock, chatId, senderJid, args, { memberScrapeController, isOwnerFromJid, getSock, originalMsg, authDatabase, fullCommand }) {
    try {
        const isOwner = await isOwnerFromJid(sock, chatId, senderJid);
        if (!isOwner) {
            await sock.sendMessage(chatId, { text: '❌ Only bot owners can send member broadcasts.' }, { quoted: originalMsg });
            return;
        }

        if (!memberScrapeController) {
            await sock.sendMessage(chatId, { text: '⚠️ Member broadcast is not configured.' }, { quoted: originalMsg });
            return;
        }

        const firstArg = args[0]?.toLowerCase();
        const isAll = firstArg === 'all';
        const message = resolvePostMessage(
            fullCommand || '',
            BROADCAST_CMDS,
            isAll ? { type: 'all' } : { type: 'index' },
            originalMsg,
        ).trim();

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

            const { groups, targets } = await memberScrapeController.getAllDedupedDmTargets(sock);
            if (!groups.length) {
                await sock.sendMessage(chatId, {
                    text: '❌ No scraped groups yet. Run `/scrap` on your groups first.',
                }, { quoted: originalMsg });
                return;
            }
            if (!targets.length) {
                await sock.sendMessage(chatId, {
                    text: '📭 No DM targets across scraped groups. Re-run `/scrap` on your groups.',
                }, { quoted: originalMsg });
                return;
            }

            await sock.sendMessage(chatId, {
                text:
                    `📤 Broadcasting to *${targets.length}* unique member(s) across *${groups.length}* scraped group(s)...\n\n` +
                    '_Running in background — other bot commands keep working._',
            }, { quoted: originalMsg });

            void runBroadcastAllJob(getSock, sock, chatId, groups.length, message, targets, authDatabase).catch((err) => {
                logger.error(`Broadcast-all job error: ${formatError(err)}`);
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

        const rawTargets = await memberScrapeController.getDmTargets(selected.group_id);
        const targets = memberScrapeController.filterTargetsForBroadcast(rawTargets, sock);
        const dmStats = await memberScrapeController.getDmTargetStats(selected.group_id);
        if (!targets.length) {
            await sock.sendMessage(chatId, {
                text:
                    `📭 No DM targets found for *${selected.group_name}*.\n\n` +
                    'Re-run `/scrap` on that group first.',
            }, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                `📤 Broadcasting to *${targets.length}* member(s) from *${selected.group_name}*...\n` +
                `📱 Phone: *${dmStats.phone_dm_count}* · 🔒 LID: *${dmStats.lid_dm_count}*\n\n` +
                '_Running in background — other bot commands keep working._',
        }, { quoted: originalMsg });

        void runBroadcastJob(getSock, sock, chatId, selected, message, targets, authDatabase).catch((err) => {
            logger.error(`Broadcast job error: ${formatError(err)}`);
        });
    } catch (err) {
        logger.error(`Broadcast command failed: ${formatError(err)}`);
        await sock.sendMessage(chatId, {
            text: `❌ Broadcast failed: ${formatError(err)}`,
        }, { quoted: originalMsg });
    }
}

async function runBroadcastAllJob(getSock, fallbackSock, chatId, groupCount, message, targets, authDB) {
    let sent = 0;
    let failed = 0;

    try {
        for (const targetJid of targets) {
            const sock = resolveSock(getSock, fallbackSock);
            if (!sock) {
                throw new Error('WhatsApp disconnected during broadcast');
            }

            try {
                await sendDmWithRetry(sock, targetJid, message, authDB);
                sent++;
            } catch (err) {
                failed++;
                logger.warn(`Broadcast-all failed for ${targetJid}: ${formatError(err)}`);
            }

            await delay(BROADCAST_DELAY_MS);
        }

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            await notifySock.sendMessage(chatId, {
                text:
                    `✅ Broadcast-all done\n\n` +
                    `📢 Groups scraped: *${groupCount}*\n` +
                    `📤 Sent: *${sent}*\n` +
                    `❌ Failed: *${failed}*`,
            });
        }

        logger.info(`Broadcast-all: groups=${groupCount}, sent=${sent}, failed=${failed}`);
    } catch (err) {
        logger.error(`Broadcast-all job failed: ${formatError(err)}`);
        try {
            const notifySock = resolveSock(getSock, fallbackSock);
            await notifySock?.sendMessage(chatId, {
                text:
                    `❌ Broadcast-all stopped\n\n` +
                    `📤 Sent: *${sent}*\n` +
                    `❌ Failed: *${failed}*\n` +
                    `⚠️ Error: ${formatError(err)}`,
            });
        } catch (notifyErr) {
            logger.error(`Could not send broadcast-all failure notice: ${formatError(notifyErr)}`);
        }
    }
}

async function runBroadcastJob(getSock, fallbackSock, chatId, selected, message, targets, authDB) {
    let sent = 0;
    let failed = 0;

    try {
        for (const targetJid of targets) {
            const sock = resolveSock(getSock, fallbackSock);
            if (!sock) {
                throw new Error('WhatsApp disconnected during broadcast');
            }

            try {
                await sendDmWithRetry(sock, targetJid, message, authDB);
                sent++;
            } catch (err) {
                failed++;
                logger.warn(`Broadcast failed for ${targetJid}: ${formatError(err)}`);
            }

            await delay(BROADCAST_DELAY_MS);
        }

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            await notifySock.sendMessage(chatId, {
                text:
                    `✅ Broadcast done for *${selected.group_name}*\n\n` +
                    `📤 Sent: *${sent}*\n` +
                    `❌ Failed: *${failed}*`,
            });
        }

        logger.info(`Broadcast to ${selected.group_name}: sent=${sent}, failed=${failed}`);
    } catch (err) {
        logger.error(`Broadcast job failed: ${formatError(err)}`);
        try {
            const notifySock = resolveSock(getSock, fallbackSock);
            await notifySock?.sendMessage(chatId, {
                text:
                    `❌ Broadcast stopped for *${selected.group_name}*\n\n` +
                    `📤 Sent: *${sent}*\n` +
                    `❌ Failed: *${failed}*\n` +
                    `⚠️ Error: ${formatError(err)}`,
            });
        } catch (notifyErr) {
            logger.error(`Could not send broadcast failure notice: ${formatError(notifyErr)}`);
        }
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
        const dmStats = await memberScrapeController.getDmTargetStats(selected.group_id);

        const notifySock = resolveSock(getSock, fallbackSock);
        if (notifySock) {
            await notifySock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '✅ *MEMBERS SCRAPED* ✅\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${result.group_name}\n` +
                    `👥 *Total:* ${result.total}\n` +
                    `🆕 *New:* ${result.inserted}\n` +
                    `🔄 *Updated:* ${result.updated}\n` +
                    `📱 *DM-able:* ${dmStats.dm_count} (${dmStats.phone_dm_count} phone · ${dmStats.lid_dm_count} LID)\n\n` +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '💡 `/scrapmembers` — view saved groups\n' +
                    '💡 `/broadcast <#> <message>` or `/broadcast all <message>`\n' +
                    '💡 `/grouppost <#> <message>` or `/grouppost all <message>`',
            });
        }

        logger.info(`Scraped ${result.total} members from ${result.group_name}`);
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
