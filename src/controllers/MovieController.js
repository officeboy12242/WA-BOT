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
    // Bollywood classics
    "🎬 _\"Ek baar jo maine commitment kar di, uske baad toh main khud ki bhi nahi sunta...\"_ — Searching! 🔍",
    "🎬 _\"Mogambo khush hua!\"_ — Your movie is being found... 🔍",
    "🎬 _\"Mere paas maa hai... aur tera movie bhi hoga!\"_ — Searching... 🔍",
    "🎬 _\"Kitne aadmi the?\"_ — Counting your results... 🔍",
    "🎬 _\"Picture abhi baaki hai mere dost...\"_ — Almost there! 🔍",
    "🎬 _\"Don ko pakadna mushkil hi nahi, namumkin hai... but finding movies? Easy!\"_ — On it! 🔍",
    "🎬 _\"Babuchak, ruk ja... results aa rahe hain!\"_ — Hold on! 🔍",
    "🎬 _\"Ye bik gayi hai gormint... but movies are still free here!\"_ — Searching... 🔍",
    "🎬 _\"Pushpa, I hate tears... but I love finding movies!\"_ — Jhukega nahi! 🔍",
    "🎬 _\"Hum jahan khade hote hain, line wahin se shuru hoti hai...\"_ — Your queue is #1! 🔍",
    "🎬 _\"Zindagi mein do cheezein chahiye... WiFi aur Movies!\"_ — Finding both... 🔍",
    "🎬 _\"Baburao, ye download karke de do...\"_ — Processing request! 🔍",
    "🎬 _\"Sharma ji ke ladke ne toh pehle hi download kar liya...\"_ — Searching fast! 🔍",
    "🎬 _\"Tumse na ho payega... chhod do! Nahi, main karunga!\"_ — Finding it! 🔍",
    "🎬 _\"Aaj mere paas gaadi hai, bangla hai, movie bhi hoga!\"_ — Searching... 🔍",
    "🎬 _\"Apun ka time aayega... aur tera movie bhi!\"_ — Processing! 🔍",
    "🎬 _\"Chulbul Pandey searching your movie, item milega!\"_ — On it! 🔍",
    "🎬 _\"Rishte mein toh hum tumhare bot lagte hain...\"_ — Searching! 🔍",
    "🎬 _\"Jali ko aag kehte hain, bujhi ko raakh... movie ko download!\"_ — Finding! 🔍",
    "🎬 _\"Keh ke lunga... tera movie!\"_ — Searching hard! 🔍",
    "🎬 _\"All izz well, movie mil jayegi!\"_ — Searching... 🔍",
    "🎬 _\"Tension nahi lene ka, movie aa rahi hai!\"_ — Hold on! 🔍",
    "🎬 _\"Main aaj bhi phenke hue paise nahi uthata... but movies dhundhta hoon!\"_ — Searching! 🔍",
    "🎬 _\"Bas kar pagle, rulaayega kya? Movie dhundh raha hoon!\"_ — Almost! 🔍",
    "🎬 _\"Circuit, bhai ka movie dhundh!\"_ — Processing! 🔍",
    "🎬 _\"Log kehte hain iske baap ka server hai... dhundhega toh milega!\"_ — On it! 🔍",
    "🎬 _\"Yeh Baburao ka style hai!\"_ — Searching in style! 🔍",
    "🎬 _\"Bade bade deshon mein aisi chhoti chhoti searches hoti rehti hain...\"_ — Finding! 🔍",
    "🎬 _\"Senorita, aapki movie dhundhi ja rahi hai!\"_ — Almost there! 🔍",
    "🎬 _\"Main udna chahta hoon, daudna chahta hoon, movie dhundhna chahta hoon!\"_ — Searching! 🔍",
    "🎬 _\"Dialogue bolne mein time lagta hai, movie dhundhne mein nahi!\"_ — Quick search! 🔍",
    "🎬 _\"Chal Dhanno! Movie dhundhne chal!\"_ — Galloping to results! 🔍",
    "🎬 _\"Bhai log, movie ka intezaam ho raha hai!\"_ — Hold tight! 🔍",
    "🎬 _\"Hera Pheri mein movie kaise dhundhe? Aise!\"_ — Searching! 🔍",
    "🎬 _\"Ye lo, Paisa hi Paisa hoga... aur movie bhi!\"_ — Finding! 🔍",
    "🎬 _\"Yahan se daffa ho jao... movie dhundh ke aa raha hoon!\"_ — On my way! 🔍",
    "🎬 _\"Aamdani atthanni kharcha rupaiya... but downloading is free!\"_ — Searching! 🔍",
    "🎬 _\"Main apni favourite hoon... aur movie bhi dhundh lungi!\"_ — On it! 🔍",
    "🎬 _\"Jab tak todenge nahi, tab tak chhodenge nahi!\"_ — Searching hard! 🔍",
    "🎬 _\"Beta, tumse na ho payega... mujhe do!\"_ — Bot searching! 🔍",
    "🎬 _\"Itna sannata kyun hai bhai? Movie dhundh raha hoon!\"_ — Processing! 🔍",
    "🎬 _\"Thapad se darr nahi lagta sahab, movie na milne se lagta hai!\"_ — Finding! 🔍",
    "🎬 _\"Koi dhanda chhota nahi hota... aur koi movie unfindable nahi!\"_ — Searching! 🔍",
    "🎬 _\"Pehle movie aata tha, ab movie dhundhte hain!\"_ — On it! 🔍",
    "🎬 _\"Tera movie toh pakka milega, Gabbar guarantee deta hai!\"_ — Searching! 🔍",
    "🎬 _\"Mein hoon na... movie dhundh raha hoon!\"_ — Hold on! 🔍",
    "🎬 _\"Sardaar Bucking Fam hai... movie dhundh raha hai!\"_ — Processing! 🔍",
    "🎬 _\"Khiladi No.1 searching your movie!\"_ — Almost done! 🔍",
    "🎬 _\"Devdas toh movie ke bina mar gaya... tu wait kar!\"_ — Finding! 🔍",
    "🎬 _\"Arey O Sambha... movie dhundh!\"_ — Searching vault! 🔍",
    // Hollywood classics
    "🎬 _\"I'll be back... with your results!\"_ — Hold tight! 🔍",
    "🎬 _\"Why so serious?\"_ — Let me find that movie for you 🃏🔍",
    "🎬 _\"Thanos snapped, but your movie survived!\"_ — Finding it now... 🔍",
    "🎬 _\"With great power comes great movies...\"_ — Searching the multiverse! 🔍",
    "🎬 _\"I am Iron Man... and I found your download!\"_ — Processing... 🔍",
    "🎬 _\"Avengers... Assemble your downloads!\"_ — Gathering results... 🔍",
    "🎬 _\"May the Force be with your download speed!\"_ — Searching galaxy... 🔍",
    "🎬 _\"To infinity... and beyond! Finding your movie!\"_ — Searching! 🔍",
    "🎬 _\"I'm gonna make him an offer he can't refuse...\"_ — Your movie! 🔍",
    "🎬 _\"Here's looking at you, kid... and your movie!\"_ — Searching! 🔍",
    "🎬 _\"You talking to me? I'm finding your movie!\"_ — On it! 🔍",
    "🎬 _\"Houston, we have a movie to find!\"_ — Launching search! 🔍",
    "🎬 _\"Elementary, my dear Watson... the movie is near!\"_ — Deducing! 🔍",
    "🎬 _\"After all this time? Always... searching for your movie!\"_ — Finding! 🔍",
    "🎬 _\"I am Groot... and I'm searching!\"_ — Growing results! 🔍",
    "🎬 _\"It's not who I am underneath, but what I download that defines me!\"_ — Searching! 🔍",
    "🎬 _\"Wakanda Forever! Searching the Vibranium servers!\"_ — On it! 🔍",
    "🎬 _\"I see dead movies... wait, found alive ones!\"_ — Searching! 🔍",
    "🎬 _\"Life is like a box of movies, you never know what you'll find!\"_ — Searching! 🔍",
    "🎬 _\"Keep your friends close, and your movies closer!\"_ — Finding! 🔍",
    "🎬 _\"They may take our lives, but they'll never take our movies!\"_ — Searching! 🔍",
    "🎬 _\"Just keep searching, just keep searching...\"_ — Dory mode! 🔍",
    "🎬 _\"I volunteer as tribute... to find your movie!\"_ — On it! 🔍",
    "🎬 _\"Expecto Patronum!\"_ — Summoning your movie results! 🔍",
    "🎬 _\"You shall not pass... without your download link!\"_ — Searching! 🔍",
    "🎬 _\"Winter is coming... but your movie is coming faster!\"_ — Finding! 🔍",
    "🎬 _\"In a galaxy far, far away... your movie exists!\"_ — Searching! 🔍",
    "🎬 _\"It's a bird! It's a plane! It's your movie results!\"_ — Almost! 🔍",
    "🎬 _\"I am inevitable... and so are your results!\"_ — Searching! 🔍",
    "🎬 _\"That's what I do. I drink coffee and I find movies!\"_ — On it! 🔍",
    "🎬 _\"Say hello to my little search engine!\"_ — Finding! 🔍",
    "🎬 _\"Frankly my dear, I do give a damn about your movie!\"_ — Searching! 🔍",
    "🎬 _\"We're gonna need a bigger download link!\"_ — Finding! 🔍",
    "🎬 _\"One does not simply walk into Mordor... but one can search movies!\"_ — On it! 🔍",
    "🎬 _\"Bond. James Bond. Searching for your movie!\"_ — Undercover search! 🔍",
    "🎬 _\"Roads? Where we're going, we don't need roads... just downloads!\"_ — Searching! 🔍",
    "🎬 _\"Not all those who wander are lost... some are searching movies!\"_ — Finding! 🔍",
    "🎬 _\"My precious... movie results!\"_ — Gollum searching! 🔍",
    "🎬 _\"I'll find your movie. I have a very particular set of skills!\"_ — Searching! 🔍",
    "🎬 _\"Hasta la vista, baby... results incoming!\"_ — Processing! 🔍",
    // Fun originals
    "🎬 _\"Server pe raid maar rahe hain bhai...\"_ — Finding your movie! 🔍",
    "🎬 _\"Netflix ko competition de rahe hain free mein!\"_ — Searching! 🔍",
    "🎬 _\"Popcorn ready kar, movie aa rahi hai!\"_ — Almost there! 🔍",
    "🎬 _\"Ek second... AI apna kaam kar raha hai!\"_ — Processing! 🔍",
    "🎬 _\"Downloading happiness for you...\"_ — Searching database! 🔍",
    "🎬 _\"Bro chill, bot kaam kar raha hai!\"_ — Finding your movie! 🔍",
    "🎬 _\"VPN on karke baitho, link aa raha hai!\"_ — Searching! 🔍",
    "🎬 _\"Internet ki duniya mein kuch bhi mumkin hai!\"_ — Finding! 🔍",
    "🎬 _\"Torrent se tez dhundhta hai ye bot!\"_ — Searching fast! 🔍",
    "🎬 _\"Relax bro, free mein milega... bas ruk!\"_ — Processing! 🔍",
    "🎬 _\"Data pack bachao, movie seedha yahaan se lo!\"_ — Finding! 🔍",
    "🎬 _\"Piracy is wrong... but searching is free!\"_ — On it! 🔍",
];

const NO_RESULTS_DIALOGUES = [
    "🎭 _\"Ye movie toh Gabbar bhi nahi dhundh paaya!\"_\nNo results found. Try a different name!",
    "🎭 _\"Houston, we have a problem...\"_\nNo movies found for that search. Try again!",
    "🎭 _\"Kuch toh gadbad hai Daya!\"_\nCouldn't find any movies. Check the spelling!",
    "🎭 _\"I looked everywhere... even in the Upside Down!\"_\nNo results. Try another name!",
    "🎭 _\"Thanos must have snapped this movie away...\"_\nNo results found! Try something else.",
    "🎭 _\"Mogambo naakhush hua...\"_\nMovie not found! Try another spelling.",
    "🎭 _\"Baburao ko bhi nahi mila...\"_\nNo results! Double check the name.",
    "🎭 _\"Even Doctor Strange couldn't find this in 14 million timelines!\"_\nTry different keywords!",
    "🎭 _\"Gabbar ne poori duniya dhundhi... nahi mila!\"_\nNo results. Try shorter name!",
    "🎭 _\"404: Movie not found in the multiverse!\"_\nTry a different search term!",
    "🎭 _\"Ye movie toh Bermuda Triangle mein gayab ho gayi!\"_\nNo results found!",
    "🎭 _\"Circuit, bhai ko movie nahi mili!\"_\nTry searching with movie year too!",
    "🎭 _\"JARVIS couldn't locate this one, sir!\"_\nTry alternate title or spelling!",
    "🎭 _\"This movie is more hidden than One Piece treasure!\"_\nNo results! Try again.",
    "🎭 _\"Gandalf searched the mines of Moria... nothing!\"_\nTry different keywords!",
    "🎭 _\"Na server mein hai, na database mein... nahi mila bhai!\"_\nTry another name!",
    "🎭 _\"Sherlock Holmes bhi confuse ho gaya!\"_\nNo results. Check spelling!",
    "🎭 _\"Hera Pheri ho gayi search mein!\"_\nNothing found. Try again with correct name!",
    "🎭 _\"Ye movie abhi release nahi hui shayad!\"_\nNo results found. Try another!",
    "🎭 _\"Server ne kaha — ye movie mujhe bhi nahi pata!\"_\nTry a different search!",
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
