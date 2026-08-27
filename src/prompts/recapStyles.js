/**
 * Recap personalities for the daily group summary.
 *
 * A style changes the VOICE and the section headings — never the JSON schema.
 * That is deliberate: four different response shapes would mean four parsers and
 * four ways to fail, whereas the model is perfectly capable of writing awards or
 * match commentary into the same {about, vibe, topics, notable, wrap_up, verdict}
 * fields. One parser, four personalities.
 *
 * Style choice is DETERMINISTIC per group per day. Recaps get retried (self-heal,
 * chunk-merge, a restart mid-send), and a random pick would hand the same group
 * two different personalities for the same date. Hashing groupId+date also means
 * two groups on the same evening usually get different voices, which is the point.
 */

/**
 * @typedef {object} RecapStyle
 * @property {string} key
 * @property {string} label        shown in /summarystyle
 * @property {string} banner       card title line
 * @property {string} persona      appended to the summary system prompt
 * @property {{topics:string, notable:string, wrapUp:string, verdict:string}} headings
 * @property {string[]} topicMarks per-topic prefix, cycled
 */

/** @type {Record<string, RecapStyle>} */
export const RECAP_STYLES = {
    awards: {
        key: 'awards',
        label: '🏆 Daily Awards Show',
        banner: '🏆 *TONIGHT\'S AWARDS* 🏆',
        persona: [
            'STYLE — DAILY AWARDS SHOW: you are the host of a small, affectionate awards ceremony for this group.',
            'Write each "topic" as an AWARD: the title is the award name (invent ones that fit the day —',
            'Main Character, Best Plot Twist, Ghost of the Day, Longest Silence, Hill Nobody Died On,',
            'Best Comeback, Most Dramatic Overreaction, etc.), and the detail says who won it and why.',
            'CRITICAL: Use ACTUAL QUOTES from the chat to show what happened. Do not just summarize.',
            'Example: "🥇 Main Character — Rahul for declaring \"I will never eat pizza again\" and then ordering one 20 mins later."',
            'Give awards for real things that happened, including quiet ones. Tease, never insult.',
        ].join(' '),
        headings: { topics: '🏆 *Tonight\'s awards*', notable: '📸 *Also spotted*', wrapUp: '📝 *In short*', verdict: '🎤 *My two cents*' },
        topicMarks: ['🥇', '🥈', '🥉', '🎭', '🤫', '💤'],
    },

    sports: {
        key: 'sports',
        label: '🎙️ Sports Commentary',
        banner: '🎙️ *LIVE FROM THE GROUP CHAT* 🎙️',
        persona: [
            'STYLE — SPORTS COMMENTARY: you are a live match commentator and the chat is the match.',
            'Narrate with momentum — who came in early, who countered, where it turned, who ran out of steam.',
            'Use commentary energy (caps for emphasis, short punchy sentences) but stay readable.',
            'Each "topic" is a passage of play. If the day was quiet, call it a slow first half — do not invent action.',
        ].join(' '),
        headings: { topics: '⚡ *Passages of play*', notable: '📣 *Highlights*', wrapUp: '🏁 *Full time*', verdict: '🎤 *My two cents*' },
        topicMarks: ['⚡', '🔄', '🎯', '🔥', '💫', '🏹'],
    },

    documentary: {
        key: 'documentary',
        label: '🌍 Nature Documentary',
        banner: '🌍 *THE GROUP CHAT — A STUDY* 🌍',
        persona: [
            'STYLE — NATURE DOCUMENTARY: you are a calm wildlife narrator observing this group as a species.',
            'Deadpan and unhurried. The humour comes from restraint and from treating ordinary chat as remarkable',
            'animal behaviour — territorial displays, migration patterns, rare cooperation.',
            'Refer to members by first name as specimens of note. Never mock; observe with fondness.',
            'Short, declarative sentences. Do not overuse the word "here".',
        ].join(' '),
        headings: { topics: '🔬 *Observed behaviour*', notable: '🐦 *Rarer sightings*', wrapUp: '📖 *Field notes*', verdict: '🎤 *My two cents*' },
        topicMarks: ['🦎', '🐒', '🦜', '🐝', '🦉', '🐾'],
    },

    tabloid: {
        key: 'tabloid',
        label: '📰 Tabloid Front Page',
        banner: '📰 *THE DAILY GROUP* 📰',
        persona: [
            'STYLE — TABLOID FRONT PAGE: you are a gleefully over-dramatic tabloid, reporting mundane chat as scandal.',
            'Each "topic" is a HEADLINE in caps, with a one or two line story under it in breathless reporter voice.',
            'Invent nothing factual — only the drama is exaggerated. Mock the situation, never the person.',
            'Attribute quotes only to what was actually said.',
        ].join(' '),
        headings: { topics: '🚨 *Headlines*', notable: '🤐 *In brief*', wrapUp: '📝 *The full story*', verdict: '🎤 *My two cents*' },
        topicMarks: ['🚨', '💥', '😱', '🔍', '📢', '⚡'],
    },
};

export const RECAP_STYLE_KEYS = Object.keys(RECAP_STYLES);
export const DEFAULT_RECAP_STYLE = 'awards';

/** Stable 32-bit hash — no Math.random, so a retry picks the same style. */
function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/**
 * Style for a given group and date.
 *
 * @param {string} groupId
 * @param {string} dateStr e.g. '2026-08-12'
 * @param {string} [forced] config override: a style key, or 'rotate'/'' to rotate
 * @returns {RecapStyle}
 */
export function pickRecapStyle(groupId, dateStr, forced = '') {
    const want = String(forced || '').trim().toLowerCase();
    if (want && want !== 'rotate' && RECAP_STYLES[want]) {
        return RECAP_STYLES[want];
    }
    const seed = `${String(groupId || '')}|${String(dateStr || '')}`;
    const key = RECAP_STYLE_KEYS[hashString(seed) % RECAP_STYLE_KEYS.length];
    return RECAP_STYLES[key];
}

/** Resolve a user-typed style name, or null if it names none. */
export function parseRecapStyle(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    if (s === 'rotate' || s === 'auto' || s === 'mix') return 'rotate';
    if (RECAP_STYLES[s]) return s;
    const alias = {
        award: 'awards', trophy: 'awards', trophies: 'awards',
        sport: 'sports', commentary: 'sports', match: 'sports', cricket: 'sports',
        doc: 'documentary', nature: 'documentary', attenborough: 'documentary', wildlife: 'documentary',
        news: 'tabloid', newspaper: 'tabloid', gossip: 'tabloid', paper: 'tabloid',
    }[s];
    return alias || null;
}
