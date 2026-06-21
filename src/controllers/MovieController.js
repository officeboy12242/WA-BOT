/**
 * Movie Search Controller
 * Handles /movie command with daily limits, humor dialogues, and auto-delete
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, isGroupMessage, normalizePhoneNumber } from '../utils/permissions.js';
import { config } from '../config/config.js';
import { atozService } from '../services/AtoZService.js';
import { pronoobDriveService } from '../services/PronoobDriveService.js';
import { urlShortener } from '../utils/urlShortener.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QR_IMAGE_PATH = resolve(__dirname, '../../assets/payment_qr.jpg');

const DAILY_LIMIT = 5;
const AUTO_DELETE_MS = 5 * 60 * 60 * 1000; // 5 hours
const GROUP_HANDOFF_MS = 5 * 60 * 1000; // 5 minutes — DM then delete from group
const DM_HANDOFF_RETRIES = 2;
const DM_HANDOFF_RETRY_MS = 1500;
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

const TMDB_GENRES = {
    action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80,
    documentary: 99, drama: 18, family: 10751, fantasy: 14, history: 36,
    horror: 27, music: 10402, mystery: 9648, romance: 10749, scifi: 878,
    'sci-fi': 878, thriller: 53, war: 10752, western: 37,
};

function formatUpcomingMovies(movies, dateRange) {
    let text = '╔════════════════════════════════╗\n';
    text += '║  🎬 UPCOMING MOVIES 🎬       ║\n';
    text += '╚════════════════════════════════╝\n\n';
    text += `📅 *${dateRange}*\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (!movies.length) {
        text += '📭 _No upcoming releases found for this period._\n';
    } else {
        movies.forEach((m, i) => {
            text += `*${i + 1}.* 🎥 *${m.title}*\n`;
            text += `   📅 ${m.releaseDate} | 🎭 ${m.genres}\n`;
            if (m.cast) text += `   👥 *Cast:* ${m.cast}\n`;
            if (m.plot) text += `   📝 _${m.plot}_\n`;
            text += '\n';
        });
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '🍿 _Use `/movie <name>` to search & download!_';
    return text;
}

function formatGenreMovies(genre, movies) {
    const genreTitle = genre.charAt(0).toUpperCase() + genre.slice(1);
    let text = '╔════════════════════════════════╗\n';
    text += `║  🎭 TOP ${genreTitle.toUpperCase()} MOVIES 🎭     ║\n`;
    text += '╚════════════════════════════════╝\n\n';
    text += `🔥 *Popular ${genreTitle} Movies Right Now:*\n`;
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    if (!movies.length) {
        text += '📭 _No movies found for this genre._\n';
    } else {
        movies.forEach((m, i) => {
            const rating = m.rating ? ` ⭐ ${m.rating}` : '';
            text += `*${i + 1}.* 🎥 *${m.title}* (${m.year})${rating}\n`;
            if (m.cast) text += `   👥 *Cast:* ${m.cast}\n`;
            if (m.plot) text += `   📝 _${m.plot}_\n`;
            text += '\n';
        });
    }

    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += `🎭 _Available genres: action, comedy, horror, thriller, romance, drama, scifi, adventure, animation, mystery_\n`;
    text += '🍿 _Use `/movie <name>` to search & download!_';
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

function normalizeLidJid(value) {
    if (!value) return '';
    const jid = value.includes('@') ? value : `${value}@lid`;
    return jidNormalizedUser(jid) || jid;
}

function participantMatchesSender(participant, senderJid) {
    const norm = (jid) => (jid ? (jidNormalizedUser(jid) || jid) : '');
    const target = norm(senderJid);
    if (!target) return false;

    for (const field of [participant.id, participant.lid, participant.phoneNumber, participant.pn]) {
        if (!field) continue;
        const normalized = norm(field);
        if (normalized === target || field === senderJid) return true;
    }
    return false;
}

function phoneFromParticipant(participant) {
    const fromPn = normalizePhoneNumber(extractPhoneNumber(participant.phoneNumber || participant.pn || ''));
    if (/^\d{10,15}$/.test(fromPn)) return fromPn;

    const id = participant.id || '';
    if (!id.includes('@lid')) {
        const fromId = normalizePhoneNumber(extractPhoneNumber(id));
        if (/^\d{10,15}$/.test(fromId)) return fromId;
    }
    return '';
}

function getRandomDialogue(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function cleanTitle(raw) {
    return raw.replace(/^\*+|\*+$/g, '').trim();
}

/** Quoting @lid senders in groups can hang Baileys — skip quote in that case. */
function shouldQuoteMessage(originalMsg) {
    if (!originalMsg?.key) return false;
    const participant = originalMsg.key.participant || originalMsg.key.remoteJid || '';
    return !participant.includes('@lid');
}

function movieReplyOptions(originalMsg) {
    const opts = { linkPreview: false };
    if (shouldQuoteMessage(originalMsg)) {
        opts.quoted = originalMsg;
    }
    return opts;
}

const WHATSAPP_MAX_LENGTH = 4096;
const SEARCH_COUNT_FOOTER_RESERVE = 80;

function formatMovieResultBlock(item, globalIdx) {
    const title = cleanTitle(item.title);
    const sourceTag = item.source ? ` [${item.source}]` : '';
    let block = `*${globalIdx}.* 🎥 ${title}${sourceTag}\n`;

    if (item.links?.length) {
        item.links.forEach((link) => {
            block += `     📦 ${link.size}  →  ${link.url}\n`;
        });
    }

    return `${block}\n`;
}

function formatMovieResultsFooter() {
    let text = '─────────────────────────────\n';
    text += '💡 _Click link to download/watch_\n';
    text += '⚠️ _Use VPN if links are blocked_\n';
    text += '⏰ _Download links expire in 7 hours_\n';
    text += '─────────────────────────────\n';
    text += '🤖 _Powered by Sassy Bot_ ⚡\n';
    text += '⏰ _This message auto-deletes in 5 hours_';
    return text;
}

function formatMovieResultsHeader(query, totalResults, pushName, sources, { totalPages = 1 } = {}) {
    let text = '';

    if (pushName) {
        text += `🎉 Hey *${pushName}*! Here are your results 🍿\n\n`;
    }
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += '┃  🎬 *MOVIE SEARCH RESULTS*  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    text += `🔍 *Query:* _"${query}"_\n`;
    text += `📊 *Found:* ${totalResults} result(s)`;
    if (totalPages > 1) {
        text += ` _(${totalPages} messages)_`;
    }
    text += '\n';
    if (sources.length > 0) {
        text += `🌐 *Sources:* ${sources.join(', ')}\n`;
    }
    text += '─────────────────────────────\n\n';
    return text;
}

function formatMovieResultsContinuation(from, to, totalResults) {
    return `📄 *Results ${from}-${to} of ${totalResults}*\n─────────────────────────────\n\n`;
}

function formatMovieResults(query, results, pushName = '', sources = []) {
    if (!results.length) return [];

    const footer = formatMovieResultsFooter();
    const blocks = results.map((item, idx) => formatMovieResultBlock(item, idx + 1));
    const totalResults = results.length;
    const maxLen = WHATSAPP_MAX_LENGTH - SEARCH_COUNT_FOOTER_RESERVE;
    const messages = [];
    let chunkStart = 0;

    while (chunkStart < blocks.length) {
        const isFirst = messages.length === 0;
        let body = '';
        let i = chunkStart;

        while (i < blocks.length) {
            const chunkEnd = i + 1;
            const header = isFirst
                ? formatMovieResultsHeader(query, totalResults, pushName, sources)
                : formatMovieResultsContinuation(chunkStart + 1, chunkEnd, totalResults);
            const atEnd = chunkEnd === blocks.length;
            const candidate = header + body + blocks[i] + (atEnd ? footer : '');

            if (candidate.length > maxLen && i > chunkStart) break;

            body += blocks[i];
            i++;
        }

        const chunkEnd = i;
        const header = isFirst
            ? formatMovieResultsHeader(query, totalResults, pushName, sources)
            : formatMovieResultsContinuation(chunkStart + 1, chunkEnd, totalResults);

        let text = header + body;
        if (chunkEnd === blocks.length) {
            text += footer;
        }

        messages.push(text);
        chunkStart = chunkEnd;
    }

    if (messages.length > 1) {
        const baseHeader = formatMovieResultsHeader(query, totalResults, pushName, sources);
        const multiHeader = formatMovieResultsHeader(query, totalResults, pushName, sources, {
            totalPages: messages.length,
        });
        messages[0] = multiHeader + messages[0].slice(baseHeader.length);
    }

    return messages;
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
        this._activeDeleteTimers = 0;
        this._sock = null;
        this._getSock = null;
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
        this._scheduleWeeklyUpcoming();
        this._scheduleExpireLimitAlerts();
        logger.info('Movie search controller ready');
    }

    _startKeepAlive() {
        pronoobDriveService.startKeepAlive();
    }

    stopKeepAlive() {
        pronoobDriveService.stopKeepAlive();
    }

    async logSearch(userId, query, resultCount, chatId) {
        try {
            const normalizedUserId = normalizePhoneNumber(userId);
            await this.searchLog.insertOne({
                user_id: normalizedUserId,
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

            logger.info(`📊 Preparing daily summary for ${movieGroups.length} group(s)...`);
            
            let sent = 0;
            let skipped = 0;
            for (const group of movieGroups) {
                try {
                    const stats = await this.getDailySummaryStats(dateStr, group.group_id);
                    if (stats.totalSearches === 0) {
                        skipped++;
                        continue;
                    }
                    const text = formatDailySummary(stats);
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Summary posted to ${group.group_name || group.group_id} (${stats.totalSearches} searches)`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Summary failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🎬 Daily movie summary: ${sent} sent, ${skipped} skipped (no activity), ${movieGroups.length} total`);
        } catch (err) {
            logger.error(`Movie daily summary error: ${err.message}`, err.stack);
        }
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

            logger.info(`🔥 Preparing weekly trending for ${trendingGroups.length} group(s)...`);
            
            const { movies, weekLabel, source } = await this.getWeeklyTrending(10);
            
            if (!movies || movies.length === 0) {
                logger.warn('Weekly trending: no movies found, skipping post');
                return;
            }
            
            const text = formatWeeklyTrending(movies, weekLabel, source);
            logger.info(`🔥 Trending data ready: ${movies.length} movie(s) from ${source}`);

            let sent = 0;
            for (const group of trendingGroups) {
                try {
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Trending posted to ${group.group_name || group.group_id}`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Trending failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🔥 Weekly trending posted to ${sent}/${trendingGroups.length} group(s)`);
        } catch (err) {
            logger.error(`Weekly trending error: ${err.message}`, err.stack);
        }
    }

    _scheduleWeeklyUpcoming() {
        const UPCOMING_DAY = 1; // Monday
        const UPCOMING_HOUR = 10;
        const UPCOMING_MINUTE = 0;

        const scheduleNext = () => {
            const now = new Date();
            const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
            const target = new Date(ist);

            const daysUntil = (UPCOMING_DAY - ist.getDay() + 7) % 7 || 7;
            target.setDate(target.getDate() + daysUntil);
            target.setHours(UPCOMING_HOUR, UPCOMING_MINUTE, 0, 0);

            if (target <= ist) target.setDate(target.getDate() + 7);

            const delayMs = target.getTime() - ist.getTime();
            const label = target.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
            logger.info(`🎬 Weekly upcoming scheduled for ${label} ${UPCOMING_HOUR}:${String(UPCOMING_MINUTE).padStart(2, '0')} IST (in ${Math.round(delayMs / 3600000)}h)`);

            this._upcomingTimer = setTimeout(async () => {
                await this._postWeeklyUpcoming();
                scheduleNext();
            }, delayMs);
        };
        scheduleNext();
    }

    async _postWeeklyUpcoming() {
        try {
            if (!this._sock) {
                logger.warn('Weekly upcoming: no socket available, skipping');
                return;
            }

            const movieGroups = await this.groupManager.getMovieEnabledGroups();
            if (!movieGroups.length) {
                logger.info('Weekly upcoming: no movie-enabled groups, skipping');
                return;
            }

            logger.info(`🎬 Preparing weekly upcoming for ${movieGroups.length} group(s)...`);
            
            const movies = await this._fetchUpcoming(8);
            if (!movies?.length) {
                logger.warn('Weekly upcoming: no upcoming movies found, skipping');
                return;
            }

            const now = new Date();
            const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            const dateRange = `${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${twoWeeks.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;
            const text = formatUpcomingMovies(movies, dateRange);
            
            logger.info(`🎬 Upcoming data ready: ${movies.length} movie(s)`);

            let sent = 0;
            for (const group of movieGroups) {
                try {
                    await this._sock.sendMessage(group.group_id, { text });
                    sent++;
                    logger.info(`✅ Upcoming posted to ${group.group_name || group.group_id}`);
                    await new Promise((r) => setTimeout(r, 500));
                } catch (err) {
                    logger.error(`❌ Upcoming failed for ${group.group_id}: ${err.message}`);
                }
            }
            logger.info(`🎬 Weekly upcoming posted to ${sent}/${movieGroups.length} group(s)`);
        } catch (err) {
            logger.error(`Weekly upcoming error: ${err.message}`, err.stack);
        }
    }

    getTodayDateStr() {
        const now = new Date();
        const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        return ist.toISOString().split('T')[0];
    }

    async getUserSearchCount(userId) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        const record = await this.searchLimits.findOne({ user_id: normalizedUserId, date: today });
        return record?.count || 0;
    }

    async incrementSearchCount(userId) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        await this.searchLimits.updateOne(
            { user_id: normalizedUserId, date: today },
            { $inc: { count: 1 }, $setOnInsert: { user_id: normalizedUserId, date: today } },
            { upsert: true }
        );
    }

    async adjustSearchCount(userId, amount, days = 1) {
        const normalizedUserId = normalizePhoneNumber(userId);
        const today = this.getTodayDateStr();
        const currentCount = await this.getUserSearchCount(normalizedUserId);
        const newCount = Math.max(0, currentCount - amount);
        
        // Update today's count
        await this.searchLimits.updateOne(
            { user_id: normalizedUserId, date: today },
            { $set: { count: newCount }, $setOnInsert: { user_id: normalizedUserId, date: today } },
            { upsert: true }
        );
        
        // Pre-set future days with negative count (extra searches)
        for (let i = 1; i < days; i++) {
            const futureDate = new Date(today + 'T00:00:00+05:30');
            futureDate.setDate(futureDate.getDate() + i);
            const futureDateStr = futureDate.toISOString().split('T')[0];
            
            await this.searchLimits.updateOne(
                { user_id: normalizedUserId, date: futureDateStr },
                { $set: { count: -amount }, $setOnInsert: { user_id: normalizedUserId, date: futureDateStr } },
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
        if (!this.groupManager) {
            logger.warn(`⚠️ No groupManager available for unlimited check: ${phoneNumber}`);
            return false;
        }
        
        // Normalize phone number for consistent checking
        const normalizedPhone = normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone) {
            logger.warn(`⚠️ Invalid phone number for unlimited check: ${phoneNumber}`);
            return false;
        }
        
        if (this.groupManager.isOwner(normalizedPhone)) {
            logger.info(`✓ ${normalizedPhone} is owner (unlimited)`);
            return true;
        }
        if (this.groupManager.isModerator(normalizedPhone)) {
            logger.info(`✓ ${normalizedPhone} is moderator (unlimited)`);
            return true;
        }
        if (await this.groupManager.isDynamicModerator(normalizedPhone)) {
            logger.info(`✓ ${normalizedPhone} is dynamic moderator (unlimited)`);
            return true;
        }
        if (await this.groupManager.isBotAdmin(normalizedPhone)) {
            logger.info(`✓ ${normalizedPhone} is bot admin (unlimited)`);
            return true;
        }
        if (await this.groupManager.isPremiumUser(normalizedPhone)) {
            logger.info(`✓ ${normalizedPhone} is premium user (unlimited)`);
            return true;
        }
        
        logger.debug(`✗ ${normalizedPhone} is regular user (limited)`);
        return false;
    }

    async _notifySearchLog(sock, userId, query, resultCount, chatId, pushName) {
        try {
            const isGroup = chatId.endsWith('@g.us');
            let source = 'DM';
            
            if (isGroup) {
                try {
                    const groupMeta = await sock.groupMetadata(chatId);
                    source = `📍 ${groupMeta.subject || 'Unknown Group'}`;
                } catch {
                    source = `📍 Group (${chatId.split('@')[0]})`;
                }
            }
            
            const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
            const name = pushName || userId;
            const text = `📋 *Search Log*\n`
                + `👤 ${name}\n`
                + `🔍 _${query}_\n`
                + `📊 ${resultCount} result(s)\n`
                + `${source}\n`
                + `🕐 ${time} IST`;
            await sock.sendMessage(SEARCH_LOG_JID, { text });
        } catch (err) {
            logger.warn(`Search log notify failed: ${err.message}`);
        }
    }

    setSock(sock) {
        this._sock = sock;
    }

    setGetSock(getSock) {
        this._getSock = getSock;
    }

    _resolveActiveSock(fallbackSock) {
        return (typeof this._getSock === 'function' ? this._getSock() : null) || this._sock || fallbackSock;
    }

    async _sendDmWithRetry(sock, targetJid, text) {
        let lastErr;
        for (let attempt = 0; attempt <= DM_HANDOFF_RETRIES; attempt++) {
            try {
                await sock.sendMessage(targetJid, { text, linkPreview: false });
                return;
            } catch (err) {
                lastErr = err;
                if (attempt < DM_HANDOFF_RETRIES) {
                    await new Promise((r) => setTimeout(r, DM_HANDOFF_RETRY_MS));
                }
            }
        }
        throw lastErr;
    }

    async _resolveDmTarget(sock, chatId, senderJid) {
        const targets = await this._resolveDmTargets(sock, chatId, senderJid);
        return targets[0] || null;
    }

    async _resolveDmTargets(sock, chatId, senderJid) {
        const targets = [];
        const seen = new Set();

        const addTarget = (jid, via) => {
            if (!jid || seen.has(jid)) return;
            seen.add(jid);
            targets.push({ jid, via });
        };

        const directPhone = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (/^\d{10,15}$/.test(directPhone) && !senderJid.includes('@lid')) {
            addTarget(`${directPhone}@s.whatsapp.net`, 'phone');
        }

        if (chatId?.endsWith('@g.us') && sock) {
            try {
                const meta = await sock.groupMetadata(chatId);
                for (const participant of meta.participants || []) {
                    if (!participantMatchesSender(participant, senderJid)) continue;

                    const phone = phoneFromParticipant(participant);
                    if (/^\d{10,15}$/.test(phone)) {
                        addTarget(`${phone}@s.whatsapp.net`, 'phone');
                    }

                    const lidSource = participant.lid
                        || (participant.id?.endsWith('@lid') ? participant.id : '')
                        || (senderJid.includes('@lid') ? senderJid : '');
                    const lidJid = normalizeLidJid(lidSource);
                    if (lidJid.endsWith('@lid')) {
                        addTarget(lidJid, 'lid');
                    }
                    break;
                }
            } catch (err) {
                logger.warn(`Group metadata DM lookup failed: ${err.message}`);
            }
        }

        if (!targets.length && senderJid.includes('@lid')) {
            const lidJid = normalizeLidJid(senderJid);
            if (lidJid.endsWith('@lid')) {
                addTarget(lidJid, 'lid');
            }
        }

        if (!targets.length && senderJid.endsWith('@s.whatsapp.net') && /^\d{10,15}$/.test(directPhone)) {
            addTarget(`${directPhone}@s.whatsapp.net`, 'phone');
        }

        if (targets.length) {
            logger.info(`DM targets for ${senderJid}: ${targets.map((t) => `${t.jid} (${t.via})`).join(', ')}`);
        }

        return targets;
    }

    async _resolveDmJid(sock, chatId, senderJid) {
        const target = await this._resolveDmTarget(sock, chatId, senderJid);
        return target?.jid || null;
    }

    _scheduleGroupResultHandoff(fallbackSock, chatId, senderJid, messageKeys, messageTexts) {
        if (!messageKeys.length || !messageTexts.length) return;

        setTimeout(async () => {
            const sock = this._resolveActiveSock(fallbackSock);
            if (!sock) {
                logger.error('Group movie handoff aborted: WhatsApp socket unavailable');
                return;
            }

            try {
                const dmTargets = await this._resolveDmTargets(sock, chatId, senderJid);
                let dmDelivered = false;

                for (const dmTarget of dmTargets) {
                    const intro =
                        '🎬 *Your movie search results*\n' +
                        '_Saved from the group before auto-delete._\n' +
                        '─────────────────────────────\n\n';

                    try {
                        await this._sendDmWithRetry(sock, dmTarget.jid, intro);
                        for (const text of messageTexts) {
                            await this._sendDmWithRetry(sock, dmTarget.jid, text);
                            await new Promise((r) => setTimeout(r, 400));
                        }
                        dmDelivered = true;
                        logger.info(`📩 Movie results sent to DM ${dmTarget.jid} (${dmTarget.via})`);
                        break;
                    } catch (err) {
                        logger.warn(`DM handoff failed via ${dmTarget.via} (${dmTarget.jid}): ${err.message}`);
                    }
                }

                if (!dmDelivered) {
                    logger.warn(`Could not DM movie results for ${senderJid} — keeping group messages`);
                    return;
                }

                for (const key of messageKeys) {
                    try {
                        await sock.sendMessage(chatId, { delete: key });
                    } catch {}
                }
                logger.info(`🗑️ Group movie results deleted from ${chatId} after ${GROUP_HANDOFF_MS / 60000}m`);
            } catch (err) {
                logger.error(`Group movie handoff failed: ${err.stack || err.message}`);
            }
        }, GROUP_HANDOFF_MS);
    }

    scheduleDelete(sock, chatId, messageKey, delayMs = AUTO_DELETE_MS) {
        if (!isGroupMessage(chatId)) return;

        this._activeDeleteTimers++;
        setTimeout(async () => {
            this._activeDeleteTimers--;
            try {
                await sock.sendMessage(chatId, { delete: messageKey });
                logger.info(`🗑️ Auto-deleted movie result in ${chatId}`);
            } catch (err) {
                logger.error(`Failed to auto-delete movie msg: ${err.message}`);
            }
        }, delayMs);
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

    async handleMovieSearch(sock, chatId, senderJid, args, pushName = '', originalMsg = null) {
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
        const normalizedUserId = normalizePhoneNumber(userId);
        const unlimited = await this.isUnlimitedUser(userId);
        const currentCount = unlimited ? 0 : await this.getUserSearchCount(normalizedUserId);

        logger.info(`🎬 Movie search by ${userId} (normalized: ${normalizedUserId}): unlimited=${unlimited}, count=${currentCount}`);

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
            const withTimeout = (promise, ms) =>
                Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

            const [driveResults, atozResults] = await Promise.allSettled([
                withTimeout(pronoobDriveService.searchMovies(query, 5), 8000),
                withTimeout(atozService.searchMovies(query, 3), 8000),
            ]);

            let results = [];
            const sources = [];

            if (driveResults.status === 'fulfilled' && driveResults.value?.length > 0) {
                results.push(...driveResults.value);
                sources.push('Drive');
                logger.info(`Drive: ${driveResults.value.length} results for "${query}"`);
            } else {
                logger.warn(`Drive: ${driveResults.status === 'rejected' ? driveResults.reason?.message : 'no results'} for "${query}"`);
            }

            if (atozResults.status === 'fulfilled' && atozResults.value?.length > 0) {
                results.push(...atozResults.value);
                sources.push('AtoZ');
                logger.info(`AtoZ: ${atozResults.value.length} results for "${query}"`);
            } else {
                logger.warn(`AtoZ: ${atozResults.status === 'rejected' ? atozResults.reason?.message : 'no results'} for "${query}"`);
            }

            if (!results?.length) {
                try {
                    await sock.sendMessage(chatId, { delete: searchingMsg.key });
                } catch {}

                const noResult = getRandomDialogue(NO_RESULTS_DIALOGUES);
                const noSent = await sock.sendMessage(chatId, { text: noResult, linkPreview: false }, movieReplyOptions(originalMsg));
                this.scheduleDelete(sock, chatId, noSent.key);
                if (!unlimited) await this.incrementSearchCount(normalizedUserId);
                void this.logSearch(normalizedUserId, query, 0, chatId);
                void this._notifySearchLog(sock, normalizedUserId, query, 0, chatId, pushName);
                return;
            }

            if (!unlimited) await this.incrementSearchCount(normalizedUserId);
            void this.logSearch(normalizedUserId, query, results.length, chatId);

            await urlShortener.shortenMovieResults(results);

            const resultMessages = formatMovieResults(query, results, pushName, sources);
            logger.info(`Formatted ${resultMessages.length} message(s) for "${query}" (${resultMessages.reduce((a, m) => a + m.length, 0)} chars)`);

            if (!resultMessages.length) {
                try {
                    await sock.sendMessage(chatId, { delete: searchingMsg.key });
                } catch {}
                const errSent = await sock.sendMessage(chatId, {
                    text: '⚠️ Found movies but could not format results. Try again.',
                    linkPreview: false,
                }, movieReplyOptions(originalMsg));
                this.scheduleDelete(sock, chatId, errSent.key);
                return;
            }

            const footer = unlimited
                ? '\n\n⭐ _Unlimited searches (Premium/Staff)_'
                : `\n\n🔢 _Searches left today: *${remaining}* / ${DAILY_LIMIT}_`;

            const isGroup = isGroupMessage(chatId);
            const groupHandoffKeys = [];
            const groupHandoffTexts = [];

            if (isGroup) {
                const handoffNote = '\n\n📩 _Results will be sent to your DM in 5 min, then removed from group._';
                resultMessages[resultMessages.length - 1] += handoffNote;
            }

            let sentCount = 0;
            for (let i = 0; i < resultMessages.length; i++) {
                let text = resultMessages[i];
                if (i === resultMessages.length - 1) {
                    text += footer;
                }

                try {
                    logger.info(`Sending movie result part ${i + 1}/${resultMessages.length} (${text.length} chars) to ${chatId}...`);
                    const sent = await sock.sendMessage(
                        chatId,
                        { text, linkPreview: false },
                        i === 0 ? movieReplyOptions(originalMsg) : { linkPreview: false },
                    );
                    logger.info(`Sent movie result part ${i + 1} OK`);

                    if (sent?.key) {
                        sentCount++;
                        if (isGroup) {
                            groupHandoffKeys.push(sent.key);
                            groupHandoffTexts.push(text);
                        } else {
                            this.scheduleDelete(sock, chatId, sent.key);
                        }
                    }

                    if (i < resultMessages.length - 1) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                } catch (sendErr) {
                    logger.error(`Movie result send failed (part ${i + 1}/${resultMessages.length}): ${sendErr.stack || sendErr.message}`);
                    if (sentCount === 0) {
                        throw sendErr;
                    }
                }
            }

            if (isGroup && groupHandoffKeys.length) {
                this._scheduleGroupResultHandoff(sock, chatId, senderJid, groupHandoffKeys, groupHandoffTexts);
            }

            try {
                await sock.sendMessage(chatId, { delete: searchingMsg.key });
            } catch {}

            logger.info(`🎬 Movie search "${query}" by ${userId} → ${results.length} results from [${sources.join(', ')}] (${sentCount}/${resultMessages.length} msg(s), ${remaining} left)`);
            void this._notifySearchLog(sock, normalizedUserId, query, results.length, chatId, pushName);
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
                linkPreview: false,
            }, movieReplyOptions(originalMsg));
            this.scheduleDelete(sock, chatId, errSent.key);

            logger.error(`Movie search error for "${query}": ${err.stack || err.message}`);
        }
    }

    async handleUpcoming(sock, chatId, senderJid, originalMsg = null) {
        try {
            const movies = await this._fetchUpcoming(10);
            if (!movies) {
                await sock.sendMessage(chatId, { text: '⚠️ Could not fetch upcoming movies. TMDB API may be unavailable.' }, { quoted: originalMsg || undefined });
                return;
            }

            const now = new Date();
            const twoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
            const dateRange = `${now.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} - ${twoWeeks.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`;

            const text = formatUpcomingMovies(movies, dateRange);
            await sock.sendMessage(chatId, { text }, { quoted: originalMsg || undefined });
            logger.info(`🎬 Upcoming movies sent to ${chatId}`);
        } catch (err) {
            logger.error(`Upcoming movies error: ${err.message}`);
            await sock.sendMessage(chatId, { text: '⚠️ Failed to fetch upcoming movies.' }, { quoted: originalMsg || undefined });
        }
    }

    async handleGenre(sock, chatId, senderJid, args, originalMsg = null) {
        const genreName = (args[0] || '').toLowerCase();

        if (!genreName || !TMDB_GENRES[genreName]) {
            const available = Object.keys(TMDB_GENRES).filter(g => g !== 'sci-fi').join(', ');
            await sock.sendMessage(chatId, {
                text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    + '🎭 *GENRE RECOMMENDATIONS*\n'
                    + '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
                    + '*Usage:* `/genre <name>`\n\n'
                    + '*Available genres:*\n'
                    + `${available}\n\n`
                    + '*Examples:*\n'
                    + '• `/genre action`\n'
                    + '• `/recommend horror`\n'
                    + '• `/genre comedy`',
            }, { quoted: originalMsg || undefined });
            return;
        }

        try {
            const movies = await this._fetchGenreMovies(genreName, 10);
            if (!movies) {
                await sock.sendMessage(chatId, { text: '⚠️ Could not fetch genre movies. TMDB API may be unavailable.' }, { quoted: originalMsg || undefined });
                return;
            }

            const text = formatGenreMovies(genreName, movies);
            await sock.sendMessage(chatId, { text }, { quoted: originalMsg || undefined });
            logger.info(`🎭 Genre "${genreName}" sent to ${chatId}`);
        } catch (err) {
            logger.error(`Genre movies error: ${err.message}`);
            await sock.sendMessage(chatId, { text: '⚠️ Failed to fetch genre movies.' }, { quoted: originalMsg || undefined });
        }
    }

    async _fetchUpcoming(limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/movie/upcoming',
                { params: { api_key: key, language: 'en-US', region: 'IN' }, timeout: 10000 }
            );
            const genreMap = await this._getGenreMap();
            const results = await this._enrichTmdbMovies((data?.results || []).slice(0, limit));
            return results.map((m) => ({
                title: m.title || m.original_title,
                releaseDate: m.release_date ? new Date(m.release_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBA',
                genres: (m.genre_ids || []).map(id => genreMap[id] || '').filter(Boolean).join(', ') || 'N/A',
                cast: m.cast || '',
                plot: m.overview || '',
            }));
        } catch (err) {
            logger.warn(`TMDB upcoming fetch failed: ${err.message}`);
            return null;
        }
    }

    async _fetchGenreMovies(genreName, limit = 10) {
        const key = config.TMDB_API_KEY;
        if (!key) return null;

        const genreId = TMDB_GENRES[genreName];
        if (!genreId) return null;

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/discover/movie',
                {
                    params: {
                        api_key: key,
                        language: 'en-US',
                        sort_by: 'popularity.desc',
                        with_genres: genreId,
                        'vote_count.gte': 50,
                    },
                    timeout: 10000,
                }
            );
            const results = await this._enrichTmdbMovies((data?.results || []).slice(0, limit));
            return results.map((m) => ({
                title: m.title || m.original_title,
                year: m.release_date?.split('-')[0] || '',
                rating: m.vote_average ? m.vote_average.toFixed(1) : '',
                cast: m.cast || '',
                plot: m.overview || '',
            }));
        } catch (err) {
            logger.warn(`TMDB genre fetch failed: ${err.message}`);
            return null;
        }
    }

    async _enrichTmdbMovies(movies = []) {
        const key = config.TMDB_API_KEY;
        if (!key || !movies.length) return movies;

        const enriched = await Promise.all(movies.map(async (movie) => {
            if (!movie?.id) return movie;

            try {
                const { data } = await axios.get(
                    `https://api.themoviedb.org/3/movie/${movie.id}`,
                    {
                        params: {
                            api_key: key,
                            language: 'en-US',
                            append_to_response: 'credits',
                        },
                        timeout: 10000,
                    }
                );

                const cast = (data?.credits?.cast || [])
                    .slice(0, 5)
                    .map((actor) => actor.name)
                    .filter(Boolean)
                    .join(', ');

                return {
                    ...movie,
                    overview: data?.overview || movie.overview || '',
                    cast,
                };
            } catch (err) {
                logger.warn(`TMDB details fetch failed for ${movie.title || movie.id}: ${err.message}`);
                return movie;
            }
        }));

        return enriched;
    }

    async _getGenreMap() {
        if (this._genreCache) return this._genreCache;
        const key = config.TMDB_API_KEY;
        if (!key) return {};

        try {
            const { data } = await axios.get(
                'https://api.themoviedb.org/3/genre/movie/list',
                { params: { api_key: key, language: 'en-US' }, timeout: 10000 }
            );
            this._genreCache = {};
            for (const g of (data?.genres || [])) {
                this._genreCache[g.id] = g.name;
            }
            return this._genreCache;
        } catch (err) {
            logger.warn(`TMDB genre list fetch failed: ${err.message}`);
            return {};
        }
    }

    _scheduleExpireLimitAlerts() {
        // Check for bonus limits expiring tomorrow, every hour at :00
        const checkAlerts = async () => {
            try {
                const now = new Date();
                const tomorrowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                tomorrowStart.setHours(0, 0, 0, 0);
                const tomorrowStr = tomorrowStart.toISOString().split('T')[0];

                // Find all records with negative count (bonus searches) expiring tomorrow
                const expiringLimits = await this.searchLimits.find({ count: { $lt: 0 }, date: tomorrowStr }).toArray();
                
                if (!expiringLimits.length) return;

                for (const limit of expiringLimits) {
                    const userId = limit.user_id;
                    const bonusAmount = -limit.count;
                    
                    try {
                        // Send to group if possible, DM as fallback
                        const dmText = `⏰ *Bonus Search Expiring Soon*\n\n`
                            + `⚠️ Your *${bonusAmount} bonus search(es)* expire tomorrow!\n\n`
                            + `Use them today or you'll lose them. ⏳`;
                        
                        if (!this.sock) return;
                        await this.sock.sendMessage(`${userId}@s.whatsapp.net`, { text: dmText });
                    } catch (err) {
                        logger.warn(`Failed to send expiry alert to ${userId}: ${err.message}`);
                    }
                }
            } catch (err) {
                logger.error(`Error checking expire limits: ${err.message}`);
            }
        };

        checkAlerts();
        setInterval(checkAlerts, 60 * 60 * 1000); // Check hourly
    }
}

export default MovieController;
