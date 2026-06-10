/**
 * Movie Search Controller
 * Handles /movie command with daily limits, humor dialogues, and auto-delete
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, isGroupMessage } from '../utils/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');

const MOVIE_API = 'https://pronoob-drive.vercel.app/?name=';
const DAILY_LIMIT = 5;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours
const PAYMENT_CONTACT = '917887499710';

const SEARCH_DIALOGUES = [
    "🎬 _\"Ek baar jo maine commitment kar di, uske baad toh main khud ki bhi nahi sunta...\"_ — Searching for you! 🔍",
    "🎬 _\"I'll be back... with your results!\"_ — Hold tight! 🔍",
    "🎬 _\"Mogambo khush hua!\"_ — Your movie is being found... 🔍",
    "🎬 _\"Why so serious?\"_ — Let me find that movie for you 🃏🔍",
    "🎬 _\"Mere paas maa hai... aur tera movie bhi hoga!\"_ — Searching... 🔍",
    "🎬 _\"Kitne aadmi the?\"_ — Counting your results... 🔍",
    "🎬 _\"Thanos snapped, but your movie survived!\"_ — Finding it now... 🔍",
    "🎬 _\"Picture abhi baaki hai mere dost...\"_ — Almost there! 🔍",
    "🎬 _\"Don ko pakadna mushkil hi nahi, namumkin hai... but finding movies? Easy!\"_ — On it! 🔍",
    "🎬 _\"With great power comes great movies...\"_ — Searching the multiverse! 🔍",
    "🎬 _\"Babuchak, ruk ja... results aa rahe hain!\"_ — Hold on! 🔍",
    "🎬 _\"I am Iron Man... and I found your download!\"_ — Processing... 🔍",
    "🎬 _\"Ye bik gayi hai gormint... but movies are still free here!\"_ — Searching... 🔍",
    "🎬 _\"Pushpa, I hate tears... but I love finding movies!\"_ — Jhukega nahi! 🔍",
    "🎬 _\"Avengers... Assemble your downloads!\"_ — Gathering results... 🔍",
    "🎬 _\"Hum jahan khade hote hain, line wahin se shuru hoti hai...\"_ — Your queue is #1! 🔍",
    "🎬 _\"May the Force be with your download speed!\"_ — Searching galaxy... 🔍",
    "🎬 _\"Zindagi mein do cheezein chahiye... WiFi aur Movies!\"_ — Finding both... 🔍",
];

const NO_RESULTS_DIALOGUES = [
    "🎭 _\"Ye movie toh Gabbar bhi nahi dhundh paaya!\"_\nNo results found. Try a different name!",
    "🎭 _\"Houston, we have a problem...\"_\nNo movies found for that search. Try again!",
    "🎭 _\"Kuch toh gadbad hai Daya!\"_\nCouldn't find any movies. Check the spelling!",
    "🎭 _\"I looked everywhere... even in the Upside Down!\"_\nNo results. Try another name!",
    "🎭 _\"Thanos must have snapped this movie away...\"_\nNo results found! Try something else.",
];

function getRandomDialogue(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function cleanTitle(raw) {
    return raw.replace(/^\*+|\*+$/g, '').trim();
}

function formatMovieResults(query, results) {
    const maxResults = 15;
    const items = results.slice(0, maxResults);

    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  🎬 *MOVIE SEARCH RESULTS*  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🔍 *Query:* _"${query}"_\n`;
    text += `📊 *Found:* ${results.length} result(s)${results.length > maxResults ? ` (showing top ${maxResults})` : ''}\n`;
    text += '─────────────────────────────\n\n';

    items.forEach((item, idx) => {
        const title = cleanTitle(item.title);
        text += `*${idx + 1}.* 🎥 ${title}\n`;

        if (item.links?.length) {
            item.links.forEach((link) => {
                text += `     📦 ${link.size}  →  ${link.url}\n`;
            });
        }
        text += '\n';
    });

    text += '─────────────────────────────\n';
    text += '💡 _Click any link to download_\n';
    text += '⚠️ _Use VPN if links are blocked_\n';
    text += '─────────────────────────────\n';
    text += `🤖 _Powered by Sassy Bot_ ⚡\n`;
    text += '⏰ _This message auto-deletes in 5 hours_';

    return text;
}

function formatLimitReached(remaining) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃   ⛔ *DAILY LIMIT REACHED*   ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🎬 You've used all *${DAILY_LIMIT}* free searches today!\n\n`;
    text += '─────────────────────────────\n';
    text += '🌟 *Want unlimited searches?*\n\n';
    text += '1️⃣ Scan the QR code below to pay\n';
    text += `2️⃣ Send the payment screenshot to:\n`;
    text += `    📱 *wa.me/${PAYMENT_CONTACT}*\n`;
    text += '3️⃣ Get unlimited access! 🎉\n';
    text += '─────────────────────────────\n\n';
    text += '_Your limit resets at midnight IST_ 🕛';

    return text;
}

class MovieController {
    constructor(mongoDb, groupManager) {
        this.mongoDb = mongoDb;
        this.groupManager = groupManager;
        this.searchLimits = null;
        this.scheduledDeletes = [];
    }

    async init() {
        this.searchLimits = this.mongoDb.collection('movie_search_limits');
        await this.searchLimits.createIndex(
            { user_id: 1, date: 1 },
            { unique: true, name: 'user_daily_limit' }
        );
        logger.info('Movie search controller ready');
    }

    getTodayDateStr() {
        const now = new Date();
        const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        return ist.toISOString().split('T')[0];
    }

    async getUserSearchCount(userId) {
        const today = this.getTodayDateStr();
        const record = await this.searchLimits.findOne({ user_id: userId, date: today });
        return record?.count || 0;
    }

    async incrementSearchCount(userId) {
        const today = this.getTodayDateStr();
        await this.searchLimits.updateOne(
            { user_id: userId, date: today },
            { $inc: { count: 1 }, $setOnInsert: { user_id: userId, date: today } },
            { upsert: true }
        );
    }

    async isUnlimitedUser(phoneNumber) {
        if (!this.groupManager) return false;
        if (this.groupManager.isOwner(phoneNumber)) return true;
        if (this.groupManager.isModerator(phoneNumber)) return true;
        if (await this.groupManager.isDynamicModerator(phoneNumber)) return true;
        if (await this.groupManager.isPremiumUser(phoneNumber)) return true;
        return false;
    }

    scheduleDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
        if (!isGroupMessage(chatId)) return;

        const timer = setTimeout(async () => {
            try {
                await sock.sendMessage(chatId, { delete: messageKey });
                logger.info(`🗑️ Auto-deleted movie result in ${chatId}`);
            } catch (err) {
                logger.error(`Failed to auto-delete movie msg: ${err.message}`);
            }
        }, delayMs);

        this.scheduledDeletes.push(timer);
    }

    async handleMovieSearch(sock, chatId, senderJid, args) {
        const query = args.join(' ').trim();
        if (!query) {
            const usage = '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n'
                + '┃     🎬 *MOVIE SEARCH*      ┃\n'
                + '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n'
                + '*Usage:*  `/movie <name>`\n\n'
                + '*Examples:*\n'
                + '• `/movie Avengers`\n'
                + '• `/movie Pushpa 2`\n'
                + '• `/movie Interstellar`\n'
                + '• `/movie Animal`\n\n'
                + `📊 Daily limit: *${DAILY_LIMIT}* free searches\n`
                + '─────────────────────────────\n'
                + '_Search Bollywood, Hollywood & more!_ 🍿';
            await sock.sendMessage(chatId, { text: usage });
            return;
        }

        const userId = extractPhoneNumber(senderJid) || senderJid;
        const unlimited = await this.isUnlimitedUser(userId);
        const currentCount = unlimited ? 0 : await this.getUserSearchCount(userId);

        if (!unlimited && currentCount >= DAILY_LIMIT) {
            const limitMsg = formatLimitReached();
            const sent = await sock.sendMessage(chatId, { text: limitMsg });
            this.scheduleDelete(sock, chatId, sent.key);

            if (existsSync(QR_IMAGE_PATH)) {
                try {
                    const qrSent = await sock.sendMessage(chatId, {
                        image: readFileSync(QR_IMAGE_PATH),
                        caption: `💳 *Scan to pay for unlimited movie searches!*\n\nAfter payment, send screenshot to:\n📱 wa.me/${PAYMENT_CONTACT}`,
                    });
                    this.scheduleDelete(sock, chatId, qrSent.key);
                } catch (err) {
                    logger.error(`Failed to send QR image: ${err.message}`);
                }
            }
            return;
        }

        const dialogue = getRandomDialogue(SEARCH_DIALOGUES);
        const remaining = unlimited ? '∞' : (DAILY_LIMIT - currentCount - 1);
        const searchingMsg = await sock.sendMessage(chatId, { text: dialogue });

        try {
            const response = await axios.get(`${MOVIE_API}${encodeURIComponent(query)}`, {
                timeout: 15000,
            });

            const results = response.data?.data?.data;

            try {
                await sock.sendMessage(chatId, { delete: searchingMsg.key });
            } catch {}

            if (!results?.length) {
                const noResult = getRandomDialogue(NO_RESULTS_DIALOGUES);
                const noSent = await sock.sendMessage(chatId, { text: noResult });
                this.scheduleDelete(sock, chatId, noSent.key);
                if (!unlimited) await this.incrementSearchCount(userId);
                return;
            }

            if (!unlimited) await this.incrementSearchCount(userId);

            const resultText = formatMovieResults(query, results);
            const footer = unlimited
                ? '\n\n⭐ _Unlimited searches (Premium/Staff)_'
                : `\n\n🔢 _Searches left today: *${remaining}* / ${DAILY_LIMIT}_`;
            const sent = await sock.sendMessage(chatId, { text: resultText + footer });

            this.scheduleDelete(sock, chatId, sent.key);

            logger.info(`🎬 Movie search "${query}" by ${userId} → ${results.length} results (${remaining} left)`);
        } catch (err) {
            try {
                await sock.sendMessage(chatId, { delete: searchingMsg.key });
            } catch {}

            const errorDialogues = [
                "🎭 _\"Technical difficulties... even JARVIS needs a break!\"_\n\n⚠️ Search failed. Try again in a moment!",
                "🎭 _\"Server ne haath khade kar diye!\"_\n\n⚠️ Couldn't reach the movie database. Try again!",
                "🎭 _\"Not even Doctor Strange saw this error coming...\"_\n\n⚠️ Something went wrong. Try later!",
            ];
            const errSent = await sock.sendMessage(chatId, {
                text: getRandomDialogue(errorDialogues),
            });
            this.scheduleDelete(sock, chatId, errSent.key);

            logger.error(`Movie search error for "${query}": ${err.message}`);
        }
    }
}

export default MovieController;
