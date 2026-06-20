/**
 * Owner-only group member scrape and broadcast handlers.
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';

const SCRAP_SESSION_MS = 5 * 60 * 1000;
const BROADCAST_DELAY_MS = 3500;
const DM_RETRY_DELAY_MS = 1500;
const DM_MAX_RETRIES = 1;

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
    return new Map();
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
        text += '💡 `/broadcast <number> <message>` — DM members\n';
        text += '💡 `/grouppost <number> <message>` — post in the group';
    }

    return text;
}

async function sendDmWithRetry(sock, targetJid, message) {
    let lastErr;
    for (let attempt = 0; attempt <= DM_MAX_RETRIES; attempt++) {
        try {
            await sock.sendMessage(targetJid, { text: message });
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < DM_MAX_RETRIES) {
                await delay(DM_RETRY_DELAY_MS);
            }
        }
    }
    throw lastErr;
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

export async function handleBroadcast(sock, chatId, senderJid, args, { memberScrapeController, isOwnerFromJid, getSock, originalMsg }) {
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

        const groupIndex = parseInt(args[0], 10);
        const message = args.slice(1).join(' ').trim();

        if (!Number.isFinite(groupIndex) || groupIndex < 1 || !message) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage: `/broadcast <group#> <message>`\n\n' +
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

        void runBroadcastJob(getSock, sock, chatId, selected, message, targets).catch((err) => {
            logger.error(`Broadcast job error: ${formatError(err)}`);
        });
    } catch (err) {
        logger.error(`Broadcast command failed: ${formatError(err)}`);
        await sock.sendMessage(chatId, {
            text: `❌ Broadcast failed: ${formatError(err)}`,
        }, { quoted: originalMsg });
    }
}

async function runBroadcastJob(getSock, fallbackSock, chatId, selected, message, targets) {
    let sent = 0;
    let failed = 0;

    try {
        for (const targetJid of targets) {
            const sock = resolveSock(getSock, fallbackSock);
            if (!sock) {
                throw new Error('WhatsApp disconnected during broadcast');
            }

            try {
                await sendDmWithRetry(sock, targetJid, message);
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

export async function handleGroupPost(sock, chatId, senderJid, args, { memberScrapeController, isOwnerFromJid, originalMsg }) {
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

        const groupIndex = parseInt(args[0], 10);
        const message = args.slice(1).join(' ').trim();

        if (!Number.isFinite(groupIndex) || groupIndex < 1 || !message) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage: `/grouppost <group#> <message>`\n\n' +
                    'Posts one message in the WhatsApp group (reaches everyone including LID users).\n' +
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
                    '💡 `/broadcast <#> <message>` — DM all members\n' +
                    '💡 `/grouppost <#> <message>` — post in the group',
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
