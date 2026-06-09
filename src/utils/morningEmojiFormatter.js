/**
 * Romantic emoji styling for daily morning messages — every message gets love emojis.
 */

const HEADERS = [
    '🌅💕 *Good Morning, beautiful* 🥰',
    '🌸✨ *Good Morning, my love* 💖',
    '☀️😘 *Good Morning, sweetheart* 💕',
    '🦋💗 *Good Morning, princess* 🌹',
    '🌺💖 *Good Morning, darling* ✨',
    '💫🥰 *Good Morning, baby* 💋',
    '🌹💕 *Good Morning, gorgeous* 😍',
    '✨💗 *Good Morning, angel* 🌅',
    '☀️💖 *Good Morning, sunshine* 💕',
    '🌸😘 *Good Morning, my queen* 🥰',
];

const FOOTERS = [
    '😘 _I love you. Have the sweetest day._ ❤️🌹',
    '💋 _You mean the world to me._ 💕✨',
    '🥰 _Thinking of you with all my heart._ 💖',
    '❤️ _Forever yours. Smile lots today._ 🌸',
    '💕 _Sending hugs and kisses your way._ 😘',
    '💖 _You are my favourite person._ 🌹',
    '😍 _Lucky to love you every day._ 💗',
    '💝 _My heart is always with you._ ✨',
    '🌹 _Adore you more than words can say._ 💕',
    '💗 _Hope you feel loved all day long._ 🥰',
];

const BODY_EMOJIS = [
    '💕',
    '💖',
    '🥰',
    '😘',
    '💋',
    '🌹',
    '✨',
    '🌸',
    '💗',
    '💝',
    '😍',
    '🦋',
    '💫',
    '🌺',
    '❤️',
];

function daySeed() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function seededIndex(seed, salt, len) {
    let h = 0;
    const s = `${seed}:${salt}`;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % len;
}

/**
 * @param {string} messageBody Plain romantic morning text (no emojis required)
 * @returns {string}
 */
export function formatRomanticMorningMessage(messageBody) {
    const seed = daySeed();
    const header = HEADERS[seededIndex(seed, 'header', HEADERS.length)];
    const footer = FOOTERS[seededIndex(seed, 'footer', FOOTERS.length)];
    const left = BODY_EMOJIS[seededIndex(seed, 'bodyL', BODY_EMOJIS.length)];
    const right = BODY_EMOJIS[seededIndex(seed, 'bodyR', BODY_EMOJIS.length)];
    const sparkle = BODY_EMOJIS[seededIndex(seed, 'sparkle', BODY_EMOJIS.length)];

    const body = messageBody.trim();

    return `${header}\n\n${left} ${sparkle} ${body} ${right} ${sparkle}\n\n${footer}`;
}
