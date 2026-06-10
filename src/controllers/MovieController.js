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
import { config } from '../config/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');

const MOVIE_API = 'https://pronoob-drive.vercel.app/?name=';
const DAILY_LIMIT = 5;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours
const KEEP_ALIVE_INTERVAL_MS = 4 * 60 * 1000; // ping every 4 minutes
const SUMMARY_HOUR = 23;
const SUMMARY_MINUTE = 55;
const WEEKLY_DAY = 0; // Sunday
const WEEKLY_HOUR = 12;
const WEEKLY_MINUTE = 0;
const PAYMENT_CONTACT = '917887499710';
const SEARCH_LOG_JID = `${PAYMENT_CONTACT}@s.whatsapp.net`;

const MOVIE_EMOJIS = ['🎬', '🍿', '🎥', '📽️', '🎞️', '🎭', '🌟', '⭐', '🔥', '💎'];

function formatDailySummary(stats) {
    const { totalSearches, uniqueUsers, topMovies, movieOfTheDay, date } = stats;

    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  📊 *DAILY MOVIE RECAP* 📊  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${date}*\n`;
    text += '─────────────────────────────\n\n';

    text += `🔍 *Total Searches:* ${totalSearches}\n`;
    text += `👥 *Users Who Searched:* ${uniqueUsers}\n\n`;

    if (movieOfTheDay) {
        text += '🏆 *MOVIE OF THE DAY*\n';
        text += `   ${MOVIE_EMOJIS[Math.floor(Math.random() * MOVIE_EMOJIS.length)]} *${movieOfTheDay.query}* — searched ${movieOfTheDay.count} time(s)\n\n`;
    }

    if (topMovies.length) {
        text += '🔥 *TOP 5 SEARCHED*\n';
        topMovies.forEach((m, i) => {
            const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] || `${i + 1}.`;
            text += `   ${medal} _${m.query}_ — ${m.count} search(es)\n`;
        });
        text += '\n';
    }

    text += '─────────────────────────────\n';

    if (totalSearches === 0) {
        text += '📭 _No one searched today… bots need love too!_ 🥲\n';
    } else if (totalSearches < 5) {
        text += '🌱 _Quiet day at the movies! Search more tomorrow_ 🍿\n';
    } else if (totalSearches < 20) {
        text += '🔥 _Decent day! The popcorn was popping_ 🍿\n';
    } else {
        text += '🚀 _Blockbuster day! You all went full cinema mode_ 🎉\n';
    }

    text += '─────────────────────────────\n';
    text += '💡 _Try `/movie <name>` to search_ 🎬';

    return text;
}

function formatWeeklyTrending(movies, weekLabel, source) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃ 🔥 *WEEKLY TRENDING MOVIES* 🔥┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `📅 *${weekLabel}*\n`;
    text += '─────────────────────────────\n\n';

    if (!movies.length) {
        text += '📭 _Nothing trending this week!_\n';
        text += '_Be the first → `/movie <name>`_ 🍿\n';
    } else if (source === 'tmdb') {
        text += '🌍 *Trending worldwide right now:*\n\n';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        movies.forEach((m, i) => {
            const badge = medals[i] || `${i + 1}.`;
            const year = m.year ? ` (${m.year})` : '';
            const rating = m.rating ? ` ⭐ ${m.rating}` : '';
            text += `${badge} *${m.title}*${year}${rating}\n`;
            if (m.plot) text += `     _${m.plot}_\n`;
            text += '\n';
        });
    } else {
        text += '🎬 *Most searched this week:*\n\n';
        const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
        movies.forEach((m, i) => {
            const badge = medals[i] || `${i + 1}.`;
            const bar = '🟩'.repeat(Math.min(m.count, 10));
            text += `${badge} *${m.title}*\n`;
            text += `     ${bar} (${m.count})\n\n`;
        });
    }

    text += '─────────────────────────────\n';
    if (source === 'tmdb' && movies.length) {
        text += '✅ _Already in Sassy\'s database — just search!_\n';
    }
    text += '🍿 _Try any movie → `/movie <name>`_\n';
    text += '⭐ _Go Premium for unlimited searches!_';

    return text;
}

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

        this.searchLog = this.mongoDb.collection('movie_search_log');
        await this.searchLog.createIndex({ date: 1, chat_id: 1 }, { name: 'search_log_date_chat' });
        await this.searchLog.createIndex(
            { date: 1, chat_id: 1, query_lower: 1 },
            { name: 'search_log_query' }
        );

        this._startKeepAlive();
        this._scheduleDailySummary();
        this._scheduleWeeklyTrending();
        logger.info('Movie search controller ready');
    }

    _startKeepAlive() {
        const ping = async () => {
            try {
                await axios.get(MOVIE_API + 'ping', { timeout: 10000 });
                logger.info('🏓 Movie API keep-alive ping OK');
            } catch {
                logger.warn('🏓 Movie API keep-alive ping failed (will retry)');
            }
        };
        ping();
        this._keepAliveTimer = setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }

    async logSearch(userId, query, resultCount, chatId) {
        try {
            await this.searchLog.insertOne({
                user_id: userId,
                query: query.slice(0, 100),
                query_lower: query.toLowerCase().slice(0, 100),
                result_count: resultCount,
                chat_id: chatId,
                date: this.getTodayDateStr(),
                created_at: new Date(),
            });
        } catch (err) {
            logger.warn(`Failed to log movie search: ${err.message}`);
        }
    }

    async getDailySummaryStats(dateStr, chatId) {
        const matchFilter = { date: dateStr };
        if (chatId) matchFilter.chat_id = chatId;

        const pipeline = [
            { $match: matchFilter },
            { $group: {
                _id: '$query_lower',
                query: { $first: '$query' },
                count: { $sum: 1 },
                users: { $addToSet: '$user_id' },
            }},
            { $sort: { count: -1 } },
        ];
        const grouped = await this.searchLog.aggregate(pipeline).toArray();

        const totalSearches = grouped.reduce((sum, g) => sum + g.count, 0);
        const allUsers = new Set();
        grouped.forEach((g) => g.users.forEach((u) => allUsers.add(u)));

        const topMovies = grouped.slice(0, 5).map((g) => ({
            query: g.query,
            count: g.count,
        }));
        const movieOfTheDay = topMovies[0] || null;

        const dateFormatted = new Date(dateStr + 'T00:00:00+05:30').toLocaleDateString('en-IN', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });

        return { totalSearches, uniqueUsers: allUsers.size, topMovies, movieOfTheDay, date: dateFormatted };
    }

    _scheduleDailySummary() {
        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);
            target.setHours(SUMMARY_HOUR, SUMMARY_MINUTE, 0, 0);
            if (target <= ist) target.setDate(target.getDate() + 1);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                + ` ${SUMMARY_HOUR}:${String(SUMMARY_MINUTE).padStart(2, '0')}`;
            logger.info(`🎬 Next movie summary scheduled at ${label} IST (in ${Math.round(delayMs / 60000)}m)`);

            this._summaryTimer = setTimeout(async () => {
                await this._postDailySummary();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postDailySummary() {
        try {
            if (!this._sock) {
                logger.warn('Movie summary: no socket available, skipping');
                return;
            }

            const dateStr = this.getTodayDateStr();
            const movieGroups = await this.groupManager.getMovieEnabledGroups();
            if (!movieGroups.length) {
                logger.info('Movie summary: no movie-enabled groups, skipping');
                return;
            }

            let sent = 0;
            for (const group of movieGroups) {
                try {
                    const stats = await this.getDailySummaryStats(dateStr, group.group_id);
                    if (stats.totalSearches === 0) continue;
                    const text = formatDailySummary(stats);
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.warn(`Movie summary failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🎬 Daily movie summary posted to ${sent} group(s) (${movieGroups.length} enabled)`);
        } catch (err) {
            logger.error(`Movie daily summary error: ${err.message}`);
        }
    }

    setSock(sock) {
        this._sock = sock;
    }

    _getWeekDateRange() {
        const now = new Date();
        const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        const end = new Date(ist);
        end.setHours(23, 59, 59, 999);
        const start = new Date(ist);
        start.setDate(start.getDate() - 6);
        start.setHours(0, 0, 0, 0);

        const fmt = (d) => d.toISOString().split('T')[0];
        const label = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
        return {
            startDate: fmt(start),
            endDate: fmt(end),
            weekLabel: `${label(start)} – ${label(end)}`,
        };
    }

    async _fetchTmdbTrending(limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/trending/movie/week',
                { params: { api_key: key, language: 'en-US' }, timeout: 10000 }
            );
            const results = (data?.results || []).slice(0, limit);
            return results.map((m) => ({
                title: m.title || m.original_title,
                year: m.release_date?.split('-')[0] || '',
                rating: m.vote_average ? m.vote_average.toFixed(1) : '',
                plot: m.overview ? m.overview.slice(0, 120) + (m.overview.length > 120 ? '…' : '') : '',
            }));
        } catch (err) {
            logger.warn(`TMDB trending fetch failed: ${err.message}`);
            return null;
        }
    }

    async _getSearchBasedTrending(limit = 10) {
        const { startDate, endDate } = this._getWeekDateRange();
        const pipeline = [
            { $match: { date: { $gte: startDate, $lte: endDate }, result_count: { $gt: 0 } } },
            { $group: {
                _id: '$query_lower',
                query: { $first: '$query' },
                count: { $sum: 1 },
            }},
            { $sort: { count: -1 } },
            { $limit: limit },
        ];
        const results = await this.searchLog.aggregate(pipeline).toArray();
        return results.map((r) => ({ title: r.query, count: r.count }));
    }

    async getWeeklyTrending(limit = 10) {
        const { weekLabel } = this._getWeekDateRange();

        const tmdb = await this._fetchTmdbTrending(limit);
        if (tmdb?.length) {
            return { movies: tmdb, weekLabel, source: 'tmdb' };
        }

        const searched = await this._getSearchBasedTrending(limit);
        return { movies: searched, weekLabel, source: 'search' };
    }

    _scheduleWeeklyTrending() {
        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);

            const daysUntil = (WEEKLY_DAY - ist.getDay() + 7) % 7 || 7;
            target.setDate(target.getDate() + daysUntil);
            target.setHours(WEEKLY_HOUR, WEEKLY_MINUTE, 0, 0);

            if (target <= ist) target.setDate(target.getDate() + 7);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
            logger.info(`🔥 Weekly trending scheduled for ${label} ${WEEKLY_HOUR}:${String(WEEKLY_MINUTE).padStart(2, '0')} IST (in ${Math.round(delayMs / 3600000)}h)`);

            this._weeklyTimer = setTimeout(async () => {
                await this._postWeeklyTrending();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postWeeklyTrending() {
        try {
            if (!this._sock) {
                logger.warn('Weekly trending: no socket available, skipping');
                return;
            }

            const trendingGroups = await this.groupManager.getWeeklyTrendingGroups();
            if (!trendingGroups.length) {
                logger.info('Weekly trending: no groups with trending enabled, skipping');
                return;
            }

            const { movies, weekLabel, source } = await this.getWeeklyTrending(10);
            const text = formatWeeklyTrending(movies, weekLabel, source);

            let sent = 0;
            for (const group of trendingGroups) {
                try {
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.warn(`Weekly trending failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🔥 Weekly trending posted to ${sent}/${trendingGroups.length} group(s)`);
        } catch (err) {
            logger.error(`Weekly trending error: ${err.message}`);
        }
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

    async adjustSearchCount(userId, amount, days = 1) {
        const today = this.getTodayDateStr();
        const currentCount = await this.getUserSearchCount(userId);
        const newCount = Math.max(0, currentCount - amount);
        
        // Update today's count
        await this.searchLimits.updateOne(
            { user_id: userId, date: today },
            { $set: { count: newCount }, $setOnInsert: { user_id: userId, date: today } },
            { upsert: true }
        );
        
        // Pre-set future days with negative count (extra searches)
        for (let i = 1; i < days; i++) {
            const futureDate = new Date(today + 'T00:00:00+05:30');
            futureDate.setDate(futureDate.getDate() + i);
            const futureDateStr = futureDate.toISOString().split('T')[0];
            
            await this.searchLimits.updateOne(
                { user_id: userId, date: futureDateStr },
                { $set: { count: -amount }, $setOnInsert: { user_id: userId, date: futureDateStr } },
                { upsert: true }
            );
        }
        
        return {
            previousUsed: currentCount,
            newUsed: newCount,
            previousRemaining: Math.max(0, DAILY_LIMIT - currentCount),
            newRemaining: Math.max(0, DAILY_LIMIT - newCount),
            days,
        };
    }

    async isUnlimitedUser(phoneNumber) {
        if (!this.groupManager) return false;
        if (this.groupManager.isOwner(phoneNumber)) return true;
        if (this.groupManager.isModerator(phoneNumber)) return true;
        if (await this.groupManager.isDynamicModerator(phoneNumber)) return true;
        if (await this.groupManager.isBotAdmin(phoneNumber)) return true;
        if (await this.groupManager.isPremiumUser(phoneNumber)) return true;
        return false;
    }

    async _notifySearchLog(sock, userId, query, resultCount, chatId, pushName) {
        try {
            const isGroup = chatId.endsWith('@g.us');
            const source = isGroup ? `Group: ${chatId.split('@')[0]}` : 'DM';
            const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
            const name = pushName || userId;
            const text = `📋 *Search Log*\n`
                + `👤 ${name}\n`
                + `🔍 _${query}_\n`
                + `📊 ${resultCount} result(s)\n`
                + `📍 ${source}\n`
                + `🕐 ${time} IST`;
            await sock.sendMessage(SEARCH_LOG_JID, { text });
        } catch (err) {
            logger.warn(`Search log notify failed: ${err.message}`);
        }
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

    async _resolvePhoneNumber(sock, chatId, senderJid) {
        const direct = extractPhoneNumber(senderJid);
        if (direct && !senderJid?.includes('@lid')) return direct;

        if (senderJid?.includes('@lid') && chatId?.endsWith('@g.us')) {
            try {
                const meta = await sock.groupMetadata(chatId);
                for (const p of meta.participants || []) {
                    if (p.lid === senderJid || p.id === senderJid) {
                        const real = extractPhoneNumber(p.id);
                        if (real) return real;
                    }
                }
            } catch {}
        }
        return direct || senderJid;
    }

    async handleMovieSearch(sock, chatId, senderJid, args, pushName = '') {
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

        const userId = await this._resolvePhoneNumber(sock, chatId, senderJid);
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
                void this.logSearch(userId, query, 0, chatId);
                void this._notifySearchLog(sock, userId, query, 0, chatId, pushName);
                return;
            }

            if (!unlimited) await this.incrementSearchCount(userId);
            void this.logSearch(userId, query, results.length, chatId);
            void this._notifySearchLog(sock, userId, query, results.length, chatId, pushName);

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
