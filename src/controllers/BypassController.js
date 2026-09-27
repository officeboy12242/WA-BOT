/**
 * BypassController — /bypass command + group auto-detect.
 *
 *   /bypass <link>            resolve one HDHub4u/HubCloud/GDFlix link now
 *   /bypasson / /bypassoff    (staff) auto-bypass pasted links in this group
 *
 * Free users: 3 bypasses/day (MOVIE_BYPASS_DAILY_LIMIT). Owners, moderators,
 * bot admins and premium users are unlimited — same rule set as /movie.
 * Progress is edited into the same message; results replace it; the footer
 * shows remaining bypasses (or the premium upsell when exhausted).
 *
 * Auto-detect: when a group has /bypasson, WhatsAppService calls
 * maybeAutoBypass() for every message; the first bypassable link is handled.
 */

import { dirname, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { messageQueue } from '../utils/messageQueue.js';
import { sendAndDelete } from '../utils/autoDelete.js';
import { isGroupMessage, extractPhoneNumber, normalizePhoneNumber } from '../utils/permissions.js';
import { bypassSingleLink, isBypassableUrl } from '../services/HdHubBypassService.js';
import { shortLinkService } from '../services/ShortLinkService.js';
import { urlShortener } from '../utils/urlShortener.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');
const BYPASS_DAILY_LIMIT = Math.max(1, parseInt(process.env.MOVIE_BYPASS_DAILY_LIMIT, 10) || 3);
const BYPASS_PROGRESS_PRIORITY = 2;
const BYPASS_BUDGET_MS = config.MOVIE_HD_BYPASS_BUDGET_MS || 8_000;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours

/** Hosts whose links are auto-bypassable (mirror of HdHubBypassService families). */
const BYPASS_HOST_RE = /https?:\/\/[^\s"'<>]*(hubcloud|hubdrive|hubcdn|hubstream|hdhubdrive|driveseed|hdstream4u|nexdrive|gdflix)\.[a-z.]+[^\s"'<>]*/i;

/** First bypassable URL in a text message, or null. */
export function extractBypassableUrl(text) {
    const m = String(text || '').match(BYPASS_HOST_RE);
    return m ? m[0] : null;
}

function normalizeOwnMessageKey(messageKey, chatId) {
    if (!messageKey?.id) return null;
    return {
        remoteJid: chatId || messageKey.remoteJid,
        id: messageKey.id,
        fromMe: true,
        ...(messageKey.participant ? { participant: messageKey.participant } : {}),
    };
}

function resolveOutboundJid(key, chatId) {
    return key?.remoteJid || chatId;
}

const BAR_BLOCKS = 18;
function progressBar(percent) {
    const filled = Math.max(1, Math.min(BAR_BLOCKS, Math.round((percent / 100) * BAR_BLOCKS)));
    return '█'.repeat(filled) + '░'.repeat(BAR_BLOCKS - filled);
}

function formatBypassProgress(url, percent, note = '') {
    let msg = '🔗 *BYPASSING…*\n\n';
    msg += `> ${url.slice(0, 90)}\n`;
    msg += `[${progressBar(percent)}] ${percent}%\n`;
    if (note) msg += `> ${note}\n`;
    return msg.trimEnd();
}

function formatBypassResult({ title, links, remaining, unlimited }) {
    let msg = '✅ *BYPASS SUCCESSFUL*\n\n';
    if (title) msg += `📄 ${title}\n\n`;
    for (const l of links) {
        msg += `┌ 📌 ${l.label}\n`;
        msg += `└ 🔗 ${l.url}\n`;
    }
    msg += '\n─────────────────────────────\n';
    msg += '⚠️ _Use VPN if links are blocked_\n';
    msg += '⏰ _Download links expire in 7 hours_\n';
    msg += '─────────────────────────────\n';
    if (unlimited) {
        msg += '⭐ _Unlimited bypasses (Premium/Staff)_';
    } else {
        msg += `🔢 _Bypasses left today: *${remaining}* / ${BYPASS_DAILY_LIMIT}_\n`;
        msg += '⏰ _This message auto-deletes in 5 hours_';
    }
    return msg;
}

function formatBypassFailed(url, remaining, unlimited) {
    let msg = '❌ *BYPASS FAILED*\n\n';
    msg += `> ${url.slice(0, 90)}\n\n`;
    msg += 'The link may be dead, password-protected, or not supported yet.\n';
    msg += '_Supported: HDHub4u, HubCloud, HubDrive, HubCDN pages._\n\n';
    msg += '─────────────────────────────\n';
    if (unlimited) {
        msg += '⭐ _Unlimited bypasses (Premium/Staff)_';
    } else {
        msg += `🔢 _Bypasses left today: *${remaining}* / ${BYPASS_DAILY_LIMIT}_\n`;
        msg += '⏰ _This message auto-deletes in 5 hours_';
    }
    return msg;
}

function formatGdflixLimited(url) {
    let msg = '⛔ *GDFLIX NOT SUPPORTED*\n\n';
    msg += `> ${url.slice(0, 90)}\n\n`;
    msg += 'GDFlix pages are protected by Cloudflare Turnstile — the bot cannot solve it.\n';
    msg += '_Only their Telegram mirror exists, which is excluded._\n\n';
    msg += '💡 *Instead:* open the movie page on HDHub4u and send me its\n';
    msg += 'HubCloud / HubDrive / HubCDN link — those bypass fully.\n';
    msg += '─────────────────────────────';
    return msg;
}

function formatLimitReached() {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃   ⛔ *DAILY LIMIT REACHED*   ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🔗 You've used all *${BYPASS_DAILY_LIMIT}* free bypasses today!\n\n`;
    text += '─────────────────────────────\n';
    text += '🌟 *Want unlimited bypasses?*\n\n';
    text += '1️⃣ Scan the QR code below to pay\n';
    text += '2️⃣ Send the payment screenshot to:\n';
    text += `    📱 *wa.me/${config.PAYMENT_CONTACT || '917887499710'}*\n`;
    text += '3️⃣ Get unlimited access! 🎉\n';
    text += '─────────────────────────────\n\n';
    text += '_Your limit resets at midnight IST_ 🕛';
    return text;
}

class BypassController {
    constructor(mongoDb, groupManager) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.bypassLimits = null;
        /** @type {Map<string, { unlimited: boolean, at: number }>} */
        this._unlimitedCache = new Map();
        /** one in-flight bypass per user per chat */
        this._activeByUser = new Map();
    }

    async init() {
        this.bypassLimits = this.mongoDb.collection('bypass_limits');
        await this.bypassLimits.createIndex(
            { user_id: 1, date: 1 },
            { unique: true, name: 'user_daily_bypass_limit' }
        );
        logger.info('Bypass controller ready');
    }

    getTodayDateStr() {
        const now = new Date();
        const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        return ist.toISOString().split('T')[0];
    }

    async getUserBypassCount(userId) {
        const normalized = normalizePhoneNumber(userId);
        const record = await this.bypassLimits.findOne({ user_id: normalized, date: this.getTodayDateStr() });
        return record?.count || 0;
    }

    async incrementBypassCount(userId) {
        const normalized = normalizePhoneNumber(userId);
        await this.bypassLimits.updateOne(
            { user_id: normalized, date: this.getTodayDateStr() },
            { $inc: { count: 1 }, $setOnInsert: { user_id: normalized, date: this.getTodayDateStr() } },
            { upsert: true }
        );
    }

    async isUnlimitedUser(phoneNumber) {
        if (!this.groupManager) return false;
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized) return false;

        const cached = this._unlimitedCache.get(normalized);
        if (cached && Date.now() - cached.at < 60_000) return cached.unlimited;

        const gm = this.groupManager;
        const [owner, moderator, dynamicMod, botAdmin, premium] = await Promise.all([
            Promise.resolve(gm.isOwner(normalized)),
            Promise.resolve(gm.isModerator(normalized)),
            gm.isDynamicModerator(normalized),
            gm.isBotAdmin(normalized),
            gm.isPremiumUser(normalized),
        ]);
        const unlimited = owner || moderator || dynamicMod || botAdmin || premium;
        if (this._unlimitedCache.size > 500) {
            this._unlimitedCache.delete(this._unlimitedCache.keys().next().value);
        }
        this._unlimitedCache.set(normalized, { unlimited, at: Date.now() });
        return unlimited;
    }

    scheduleDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
        if (!messageKey?.id) return;
        setTimeout(() => {
            try {
                const key = normalizeOwnMessageKey(messageKey, chatId);
                if (key) void sock?.sendMessage(resolveOutboundJid(key, chatId), { delete: key });
            } catch {}
        }, delayMs).unref?.();
    }

    /**
     * Core flow: progress message → bypass → shorten → edit to results.
     * @returns {Promise<boolean>} true when a bypass was attempted
     */
    async _runBypass(sock, chatId, senderJid, url, originalMsg, pushName = '') {
        void pushName;
        const userKey = `${chatId}:${normalizePhoneNumber(senderJid)}`;
        if (this._activeByUser.has(userKey)) {
            await sendAndDelete(sock, chatId, {
                text: '⏳ One bypass at a time — wait for the current one to finish.',
            }, originalMsg, 30_000);
            return true;
        }

        const unlimited = await this.isUnlimitedUser(senderJid);
        let used = unlimited ? 0 : await this.getUserBypassCount(senderJid);
        if (!unlimited && used >= BYPASS_DAILY_LIMIT) {
            const sent = await sendAndDelete(sock, chatId, { text: formatLimitReached() }, originalMsg);
            this.scheduleDelete(sock, chatId, sent?.key);
            if (existsSync(QR_IMAGE_PATH)) {
                try {
                    const qr = await sock.sendMessage(chatId, {
                        image: readFileSync(QR_IMAGE_PATH),
                        caption: '💳 *Scan to pay for unlimited bypasses!*\n\nAfter payment, send screenshot to the owner.',
                    }, { quoted: originalMsg });
                    this.scheduleDelete(sock, chatId, qr?.key);
                } catch {}
            }
            return true;
        }

        this._activeByUser.set(userKey, true);
        const run = (async () => {
            // 1) progress message (edited in place through the flow)
            let progressMsg = null;
            try {
                progressMsg = await sock.sendMessage(chatId, {
                    text: formatBypassProgress(url, 15, '🔎 Fetching page…'),
                }, { quoted: originalMsg });
            } catch {}

            const editProgress = async (percent, note) => {
                if (!progressMsg?.key) return;
                try {
                    await messageQueue.enqueue(chatId, async () => {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: formatBypassProgress(url, percent, note),
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                    }, BYPASS_PROGRESS_PRIORITY);
                } catch {}
            };

            try {
                await editProgress(35, '🔓 Unlocking download servers…');

                // 2) resolve
                const { title, links } = await bypassSingleLink(url, BYPASS_BUDGET_MS);
                if (!links.length) {
                    const isGdflix = /gdflix\./i.test(url);
                    if (progressMsg?.key) {
                        try {
                            await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                                text: isGdflix
                                    ? formatGdflixLimited(url)
                                    : formatBypassFailed(url, Math.max(0, BYPASS_DAILY_LIMIT - used), unlimited),
                                edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                                linkPreview: false,
                            });
                            this.scheduleDelete(sock, chatId, progressMsg.key);
                        } catch {}
                    }
                    logger.info(`Bypass failed for ${url}`);
                    return;
                }

                await editProgress(70, '🔗 Creating short links…');

                // 3) short links (expiring /d/ + display shortener) — same as /movie
                try {
                    await Promise.all(links.map(async (l) => {
                        try {
                            const minted = await shortLinkService.shorten(l.url);
                            const expiring = typeof minted === 'string' ? minted : minted?.url;
                            if (!expiring) return;
                            const display = await urlShortener._toDisplayShortUrl(expiring);
                            l.url = display || expiring;
                        } catch (e) {
                            logger.warn(`Bypass short link failed for one server: ${e?.message || e}`);
                        }
                    }));
                } catch (err) {
                    logger.warn(`Bypass short-link step failed (sending direct): ${err?.message || err}`);
                }

                await editProgress(100, '✅ Done');

                // 4) consume one credit
                if (!unlimited) {
                    await this.incrementBypassCount(senderJid);
                    used += 1;
                }

                // 5) replace progress with results
                const resultText = formatBypassResult({
                    title,
                    links,
                    remaining: Math.max(0, BYPASS_DAILY_LIMIT - used),
                    unlimited,
                });
                if (progressMsg?.key) {
                    try {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: resultText,
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                        this.scheduleDelete(sock, chatId, progressMsg.key);
                        return;
                    } catch {}
                }
                const sent = await sock.sendMessage(chatId, { text: resultText, linkPreview: false }, { quoted: originalMsg });
                this.scheduleDelete(sock, chatId, sent?.key);
            } catch (err) {
                logger.error(`Bypass error: ${err?.stack || err?.message || err}`);
                if (progressMsg?.key) {
                    try {
                        await sock.sendMessage(resolveOutboundJid(progressMsg.key, chatId), {
                            text: formatBypassFailed(url, Math.max(0, BYPASS_DAILY_LIMIT - used), unlimited),
                            edit: normalizeOwnMessageKey(progressMsg.key, chatId),
                            linkPreview: false,
                        });
                        this.scheduleDelete(sock, chatId, progressMsg.key);
                    } catch {}
                }
            } finally {
                this._activeByUser.delete(userKey);
            }
        })();

        await run;
        return true;
    }

    /** /bypass <link> */
    async handleBypass(sock, chatId, senderJid, args, originalMsg = null, pushName = '') {
        const url = (args || []).find((a) => /^https?:\/\//i.test(a)) || extractBypassableUrl((args || []).join(' '));
        if (!url) {
            await sendAndDelete(sock, chatId, {
                text:
                    '🔗 *LINK BYPASSER*\n\n' +
                    'Usage: `/bypass <link>`\n\n' +
                    '_Supported links:_\n' +
                    '• HDHub4u / HubCloud / HubDrive / HubCDN\n\n' +
                    `_Free limit: ${BYPASS_DAILY_LIMIT} bypasses/day · admins & premium: unlimited_`,
            }, originalMsg);
            return;
        }
        if (!isBypassableUrl(url)) {
            await sendAndDelete(sock, chatId, {
                text:
                    '⚠️ That link is not a supported bypass target.\n\n' +
                    '_Supported: HDHub4u, HubCloud, HubDrive, HubCDN pages._',
            }, originalMsg);
            return;
        }
        await this._runBypass(sock, chatId, senderJid, url, originalMsg, pushName);
    }

    /** /bypasson — staff only (enforced by registry role) */
    async handleBypassOn(sock, chatId, senderJid, originalMsg = null) {
        if (!isGroupMessage(chatId)) {
            await sendAndDelete(sock, chatId, { text: 'Use `/bypasson` in a group.' }, originalMsg);
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        await this.groupManager.setBypassAuto(chatId, groupName, true, extractPhoneNumber(senderJid));
        await sendAndDelete(sock, chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '✅ *BYPASS AUTO ON* ✅\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📢 *Group:* ${groupName}\n\n` +
                '🔗 HDHub4u / HubCloud / GDFlix links pasted here are bypassed automatically.\n' +
                '_No command needed — just send the link._\n\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '💡 Use `/bypassoff` to turn this off',
        }, originalMsg);
        logger.info(`🔗 Bypass auto ON: ${groupName} (${chatId})`);
    }

    /** /bypassoff — staff only (enforced by registry role) */
    async handleBypassOff(sock, chatId, senderJid, originalMsg = null) {
        if (!isGroupMessage(chatId)) {
            await sendAndDelete(sock, chatId, { text: 'Use `/bypassoff` in a group.' }, originalMsg);
            return;
        }
        const wasEnabled = await this.groupManager.isBypassAutoEnabled(chatId);
        if (!wasEnabled) {
            await sendAndDelete(sock, chatId, {
                text:
                    'ℹ️ *BYPASS AUTO OFF*\n\nAuto bypass is not enabled in this group.\n\nUse `/bypasson` to enable it.',
            }, originalMsg);
            return;
        }
        let groupName = 'Unknown Group';
        try { groupName = (await sock.groupMetadata(chatId)).subject; } catch {}
        await this.groupManager.setBypassAuto(chatId, groupName, false, extractPhoneNumber(senderJid));
        await sendAndDelete(sock, chatId, {
            text:
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                '🛑 *BYPASS AUTO OFF* 🛑\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Links in this group will no longer be bypassed automatically.',
        }, originalMsg);
        logger.info(`🔗 Bypass auto OFF: ${groupName} (${chatId})`);
    }

    /** Called by WhatsAppService for every non-command group text. */
    async maybeAutoBypass(sock, chatId, text, senderJid, msg) {
        if (!chatId?.endsWith('@g.us')) return; // groups only
        if (!this.groupManager) return;
        try {
            if (!(await this.groupManager.isBypassAutoEnabled(chatId))) return;
        } catch {
            return;
        }
        const url = extractBypassableUrl(text);
        if (!url) return;
        // ignore our own outgoing text — caller filters, but double-check
        if (msg?.key?.fromMe) return;
        void this._runBypass(sock, chatId, senderJid, url, msg, msg?.pushName || '');
    }
}

export const bypassController = new BypassController(null, null);
export default BypassController;
