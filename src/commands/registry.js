/**
 * Command registry — single place for names, where they work, and who can run them.
 *
 * scope:
 *   - any          → DM and groups
 *   - group_only   → WhatsApp groups (@g.us) only
 *   - dm_only      → direct chats only
 *
 * role:
 *   - anyone       → any member / any DM user
 *   - staff        → owners, moderators (.env), DB admins, or WhatsApp group admins
 *   - admins           → owners, bot admins, or WhatsApp group admins in that group (auto-detected)
 *   - admin_managers   → owners, moderators, or bot admins (manage /addadmin /removeadmin)
 *   - welcome_setters  → admins or admin_managers (set group welcome messages)
 */

/** @typedef {'any' | 'group_only' | 'dm_only'} ChatScope */
/** @typedef {'anyone' | 'staff' | 'admins' | 'admin_managers' | 'welcome_setters' | 'owner'} Role */

/**
 * @typedef {object} CommandDefinition
 * @property {string[]} names       Primary name first; aliases after (e.g. ['/insta','/i'])
 * @property {string} key           Stable id for dispatch
 * @property {ChatScope} scope
 * @property {Role} role
 * @property {string} help          One line for /help
 */

/** @type {CommandDefinition[]} */
export const COMMAND_REGISTRY = [
    {
        names: ['/ping', '/a', '/alive'],
        key: 'ping',
        scope: 'any',
        role: 'anyone',
        help: 'Check if bot is alive',
    },
    {
        names: ['/help'],
        key: 'help',
        scope: 'any',
        role: 'anyone',
        help: 'Show this list',
    },
    {
        names: ['/facts'],
        key: 'facts',
        scope: 'group_only',
        role: 'anyone',
        help: 'Random fun fact (groups only)',
    },
    {
        names: ['/insta', '/i'],
        key: 'insta',
        scope: 'any',
        role: 'anyone',
        help: 'Download Instagram post/reel; auto in DMs & groups with `/instaon`',
    },
    {
        names: ['/movie', '/m', '/search', '/s'],
        key: 'movie',
        scope: 'any',
        role: 'anyone',
        help: 'Search & download movies (5/day free)',
        category: 'movie',
    },
    {
        names: ['/upcoming'],
        key: 'upcoming',
        scope: 'any',
        role: 'anyone',
        help: 'Upcoming movies releasing soon (from TMDB)',
        category: 'movie',
    },
    {
        names: ['/genre', '/recommend'],
        key: 'genre',
        scope: 'any',
        role: 'anyone',
        help: 'Top movies by genre (action, horror, comedy, etc)',
        category: 'movie',
    },
    {
        names: ['/sticker', '/stk'],
        key: 'sticker',
        scope: 'any',
        role: 'anyone',
        help: 'Create sticker from image/video (reply; options: circle/c, crop, pack, author, nometadata)',
    },
    {
        names: ['/steal'],
        key: 'steal',
        scope: 'any',
        role: 'anyone',
        help: 'Steal sticker — change metadata or make circular (reply; options: circle/c, pack, author)',
    },
    {
        names: ['/toimg', '/image'],
        key: 'toimg',
        scope: 'any',
        role: 'anyone',
        help: 'Convert sticker to image (reply to sticker)',
    },
    {
        names: ['/rgb'],
        key: 'rgb',
        scope: 'any',
        role: 'anyone',
        help: 'Animated rainbow/RGB text sticker — `/rgb Your Text`',
    },
    {
        names: ['/news'],
        key: 'news',
        scope: 'any',
        role: 'anyone',
        help: 'Preview 10 tech news items; staff post to news-enabled groups',
    },
    {
        names: ['/github'],
        key: 'github',
        scope: 'any',
        role: 'anyone',
        help: 'Preview GitHub repos; staff reply yes/no to post to github-enabled groups',
    },
    {
        names: ['/horo', '/horoscope'],
        key: 'horo',
        scope: 'any',
        role: 'anyone',
        help: 'Daily horoscope — `/horo capricorn` or `/horo cap`',
    },
    {
        names: ['/posted'],
        key: 'posted',
        scope: 'any',
        role: 'anyone',
        help: 'Course statistics for this chat',
    },
    {
        names: ['/status'],
        key: 'status',
        scope: 'any',
        role: 'anyone',
        help: 'Bot status and posting stats',
    },
    {
        names: ['/activate'],
        key: 'activate',
        scope: 'group_only',
        role: 'staff',
        help: 'Turn on courses in this group (staff only)',
    },
    {
        names: ['/deactivate'],
        key: 'deactivate',
        scope: 'group_only',
        role: 'staff',
        help: 'Turn off courses + tech news in this group (staff only)',
    },
    {
        names: ['/newson'],
        key: 'newson',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable scheduled tech news in this group',
    },
    {
        names: ['/newsoff'],
        key: 'newsoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable tech news only — courses continue',
    },
    {
        names: ['/githubon'],
        key: 'githubon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable daily GitHub trending repos in this group',
    },
    {
        names: ['/githuboff'],
        key: 'githuboff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable GitHub trending only — courses continue',
    },
    {
        names: ['/instaon'],
        key: 'instaon',
        scope: 'group_only',
        role: 'staff',
        help: 'Auto-download Instagram links pasted in this group',
    },
    {
        names: ['/instaoff'],
        key: 'instaoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Stop auto Instagram download in this group',
    },
    {
        names: ['/setwc'],
        key: 'setwc',
        scope: 'group_only',
        role: 'welcome_setters',
        help: 'Set welcome extra line; auto-deletes after 2 min — `/setwc on` to enable',
    },
    {
        names: ['/warn'],
        key: 'warn',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Warn a member (reply/@tag/phone) + reason — auto-kick at 5 warns',
    },
    {
        names: ['/mywarns'],
        key: 'mywarns',
        scope: 'group_only',
        help: 'View your warnings and reasons in this group',
    },
    {
        names: ['/warns'],
        key: 'warns',
        scope: 'group_only',
        role: 'group_admins',
        help: 'View a member\'s warnings (reply/@tag/phone)',
    },
    {
        names: ['/clearwarns'],
        key: 'clearwarns',
        scope: 'group_only',
        role: 'group_admins',
        help: 'Clear all warnings for a member (reply/@tag/phone)',
    },
    {
        names: ['/dellast', '/del'],
        key: 'dellast',
        scope: 'group_only',
        role: 'admins',
        help: 'Delete oldest tracked messages — `/dellast 20`, reply + `/del`, or `/delall` (bot admin)',
    },
    {
        names: ['/delall'],
        key: 'delall',
        scope: 'group_only',
        role: 'admins',
        help: 'Delete all tracked messages in group (up to 500)',
    },
    {
        names: ['/groups'],
        key: 'groups',
        scope: 'any',
        role: 'admins',
        help: 'List courses-active & insta-auto groups with member counts',
    },
    {
        names: ['/pause'],
        key: 'pause',
        scope: 'any',
        role: 'admins',
        help: 'Pause automatic course posting only (tech news continues)',
    },
    {
        names: ['/resume'],
        key: 'resume',
        scope: 'any',
        role: 'admins',
        help: 'Resume automatic course posting',
    },
    {
        names: ['/clear'],
        key: 'clear',
        scope: 'any',
        role: 'admins',
        help: 'Start deleting posted courses for this chat (needs /confirm)',
    },
    {
        names: ['/confirm'],
        key: 'confirm',
        scope: 'any',
        role: 'admins',
        help: 'Confirm /clear',
    },
    {
        names: ['/cancel'],
        key: 'cancel',
        scope: 'any',
        role: 'admins',
        help: 'Cancel pending /clear',
    },
    {
        names: ['/addadmin'],
        key: 'addadmin',
        scope: 'any',
        role: 'admin_managers',
        help: 'Add bot admin (phone, @tag, or reply)',
    },
    {
        names: ['/removeadmin'],
        key: 'removeadmin',
        scope: 'any',
        role: 'admin_managers',
        help: 'Remove bot admin (phone, @tag, or reply)',
    },
    {
        names: ['/admins'],
        key: 'admins',
        scope: 'any',
        role: 'admins',
        help: 'List bot staff + WhatsApp group admins',
    },
    {
        names: ['/movieon'],
        key: 'movieon',
        scope: 'group_only',
        role: 'staff',
        help: 'Enable movie search + daily recap in this group',
        category: 'movie',
    },
    {
        names: ['/movieoff'],
        key: 'movieoff',
        scope: 'group_only',
        role: 'staff',
        help: 'Disable movie features in this group',
        category: 'movie',
    },
    {
        names: ['/trending'],
        key: 'trending',
        scope: 'group_only',
        role: 'staff',
        help: 'Toggle weekly trending movies — `/trending on` or `/trending off`',
        category: 'movie',
    },
    {
        names: ['/addpremium'],
        key: 'addpremium',
        scope: 'any',
        role: 'owner',
        help: 'Grant premium (unlimited movies) — phone, @tag, or reply',
        category: 'movie',
    },
    {
        names: ['/removepremium', '/rmpremium'],
        key: 'removepremium',
        scope: 'any',
        role: 'owner',
        help: 'Revoke premium — phone, @tag, or reply',
        category: 'movie',
    },
    {
        names: ['/premium'],
        key: 'premium',
        scope: 'any',
        role: 'owner',
        help: 'List all premium users',
        category: 'movie',
    },
    {
        names: ['/increaselimit', '/addlimit'],
        key: 'increaselimit',
        scope: 'any',
        role: 'admins',
        help: 'Add searches to user — `/increaselimit 5` or `/increaselimit 5 3d` (reply/@tag)',
        category: 'movie',
    },
    {
        names: ['/checklimit', '/mylimit'],
        key: 'checklimit',
        scope: 'any',
        role: 'anyone',
        help: 'Check movie search limit — yours or tag/reply (admins only)',
        category: 'movie',
    },
    {
        names: ['/addmod'],
        key: 'addmod',
        scope: 'any',
        role: 'owner',
        help: 'Add moderator — phone, @tag, or reply',
    },
    {
        names: ['/removemod', '/rmmod'],
        key: 'removemod',
        scope: 'any',
        role: 'owner',
        help: 'Remove moderator — phone, @tag, or reply',
    },
    {
        names: ['/addchannel'],
        key: 'addchannel',
        scope: 'any',
        role: 'owner',
        help: 'Add sticker source channel (owner only)',
    },
    {
        names: ['/removechannel', '/rmchannel'],
        key: 'removechannel',
        scope: 'any',
        role: 'owner',
        help: 'Remove sticker source channel (owner only)',
    },
    {
        names: ['/channels'],
        key: 'channels',
        scope: 'any',
        role: 'owner',
        help: 'List sticker source channels (owner only)',
    },
    {
        names: ['/scrap'],
        key: 'scrap',
        scope: 'any',
        role: 'owner',
        help: 'Pick a group by number and scrape all members to database (owner only)',
    },
    {
        names: ['/scrapmembers', '/scraped'],
        key: 'scrapmembers',
        scope: 'any',
        role: 'owner',
        help: 'List scraped groups and member counts (owner only)',
    },
    {
        names: ['/broadcast'],
        key: 'broadcast',
        scope: 'any',
        role: 'owner',
        help: 'DM scraped members — multiline/reply supported — `/broadcast <#> <msg>` or `/broadcast all <msg>` (owner only)',
    },
    {
        names: ['/grouppost', '/groupmsg'],
        key: 'grouppost',
        scope: 'any',
        role: 'owner',
        help: 'Post in group(s) — multiline/reply supported — `/grouppost <#> <msg>` or `/grouppost all <msg>` (owner only)',
    },
    {
        names: ['/driveurl', '/drivesource'],
        key: 'driveurl',
        scope: 'any',
        role: 'owner',
        help: 'Manage Drive scrape URLs — add/remove/list/test Render sources (owner only)',
        category: 'movie',
    },
    {
        names: ['/vv', '/viewonce'],
        key: 'viewonce',
        scope: 'any',
        role: 'anyone',
        help: 'Reply to a view-once message to reveal it',
    },
    {
        names: ['/deploy', '/redeploy'],
        key: 'deploy',
        scope: 'any',
        role: 'owner',
        help: 'Trigger Render redeploy of latest commit (owner only)',
    },
];

const nameIndex = new Map();
for (const def of COMMAND_REGISTRY) {
    for (const n of def.names) {
        nameIndex.set(n.toLowerCase(), def);
    }
}

/**
 * @param {string} cmdFirstToken e.g. '/ping'
 * @returns {CommandDefinition | undefined}
 */
export function findCommand(cmdFirstToken) {
    if (!cmdFirstToken) return undefined;
    return nameIndex.get(cmdFirstToken.toLowerCase());
}

/**
 * Get all registered command names (for suggestions)
 */
export function getAllCommandNames() {
    return Array.from(nameIndex.keys());
}

/**
 * Simple string similarity (Levenshtein-like)
 */
function similarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) costs[j] = j;
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return (longer.length - costs[s2.length]) / longer.length;
}

/**
 * Find similar commands for suggestions
 */
export function findSimilarCommands(input, maxResults = 3) {
    if (!input) return [];
    const inputLower = input.toLowerCase().replace(/^\//, '');
    const allNames = getAllCommandNames();
    
    const matches = allNames
        .map(name => ({
            name,
            score: similarity(inputLower, name.replace(/^\//, ''))
        }))
        .filter(m => m.score > 0.3) // Min 30% similarity
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults);
    
    return matches.map(m => m.name);
}

/**
 * @param {{ isStaff?: boolean, isPrivileged?: boolean, canManageAdmins?: boolean }} access
 * @returns {string}
 */
function fmtCmd(def) {
    const primaryCmd = `\`${def.names[0]}\``;
    const aliases = def.names.length > 1 ? ` _(${def.names.slice(1).join(', ')})_` : '';
    return `  • ${primaryCmd}${aliases}\n    ↳ ${def.help}`;
}

/**
 * @param {object} opts
 * @param {boolean} opts.isStaff
 * @param {boolean} opts.isPrivileged
 * @param {boolean} opts.canManageAdmins
 * @param {boolean} opts.canSetWelcome
 * @param {boolean} opts.isOwner
 * @param {boolean} opts.isDirectMessage - user is in a private chat with the bot
 * @param {boolean} opts.movieOnly - group has only movie features, not full activation
 * @param {object}  opts.features  - { courses, insta, movie, trending, welcome }
 */
export function formatHelpText({
    isStaff = false,
    isPrivileged = false,
    canManageAdmins = false,
    canSetWelcome = false,
    isOwner = false,
    movieOnly = false,
    isDirectMessage = false,
    features = {},
} = {}) {
    const movieEnabled = features.movie || movieOnly || isDirectMessage;

    const all = COMMAND_REGISTRY;
    const isMovieCmd = (d) => d.category === 'movie';

    let out = '╔════════════════════════════════╗\n';
    out += '║   🤖 BOT COMMAND GUIDE 🤖   ║\n';
    out += '╚════════════════════════════════╝\n\n';

    // ─── GENERAL SECTION ───
    const anyoneGeneral = all.filter((d) => d.role === 'anyone' && !isMovieCmd(d));
    if (anyoneGeneral.length) {
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '📱 *GENERAL COMMANDS*\n';
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '_Everyone can use:_\n\n';
        for (const def of anyoneGeneral) out += fmtCmd(def) + '\n';
        out += '\n';
    }

    // ─── MEDIA SECTION ───
    const mediaCommands = all.filter(d => ['insta', 'toimg'].some(k => d.key.includes(k)) && d.role === 'anyone');
    if (mediaCommands.length) {
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '🎨 *MEDIA TOOLS*\n';
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '_Download & create content:_\n\n';
        for (const def of mediaCommands) out += fmtCmd(def) + '\n';
        out += '\n';
    }

    // ─── STICKER SECTION ───
    const stickerCommands = all.filter(d => ['sticker', 'steal'].includes(d.key) && d.role === 'anyone');
    if (stickerCommands.length) {
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '🎭 *STICKER CREATOR*\n';
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '_Create & modify stickers:_\n\n';
        for (const def of stickerCommands) out += fmtCmd(def) + '\n';
        out += '\n';
    }

    // ─── MOVIE SECTION ───
    const anyoneMovie = all.filter((d) => d.role === 'anyone' && isMovieCmd(d));
    if (movieEnabled && anyoneMovie.length) {
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '🎬 *MOVIE SEARCH*\n';
        out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
        out += '_Search for movies & shows:_\n\n';
        for (const def of anyoneMovie) out += fmtCmd(def) + '\n';
        out += '\n📊 *Daily Limit:* 5 free searches\n';
        out += '⭐ *Premium:* Unlimited searches\n';
        out += '💡 *Tip:* `/movie Pushpa 2` · `/search Avengers` · `/m Animal`\n\n';
    }

    // ─── GROUP SETTINGS (Staff) ───
    if (isStaff) {
        const staffCommands = all.filter((d) => d.role === 'staff' && !isMovieCmd(d));
        if (staffCommands.length) {
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '👮 *GROUP SETTINGS* (Staff)\n';
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '_Owners, admins, moderators:_\n\n';
            for (const def of staffCommands) out += fmtCmd(def) + '\n';
            out += '\n';
        }
    }

    // ─── ADMIN TOOLS (Privileged) ───
    if (isPrivileged) {
        const adminCmds = all.filter((d) => d.role === 'admins');
        if (adminCmds.length) {
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '🔧 *ADMIN TOOLS*\n';
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '_Manage bot & group:_\n\n';
            for (const def of adminCmds) out += fmtCmd(def) + '\n';
            out += '\n';
        }
    }

    // ─── ADMIN MANAGERS ───
    if (canManageAdmins) {
        const adminMgr = all.filter((d) => d.role === 'admin_managers');
        if (adminMgr.length) {
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '👑 *BOT ADMIN MANAGER*\n';
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '_Manage who is a bot admin:_\n\n';
            for (const def of adminMgr) out += fmtCmd(def) + '\n';
            out += '\n';
        }
    }

    // ─── WELCOME MESSAGES ───
    if (canSetWelcome) {
        const wc = all.filter((d) => d.role === 'welcome_setters');
        if (wc.length) {
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '👋 *WELCOME MESSAGES*\n';
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '_Set group welcome text:_\n\n';
            for (const def of wc) out += fmtCmd(def) + '\n';
            out += '\n';
        }
    }

    // ─── OWNER SECTION ───
    if (isOwner) {
        const ownerGeneral = all.filter((d) => d.role === 'owner' && !isMovieCmd(d));
        const ownerMovie = all.filter((d) => d.role === 'owner' && isMovieCmd(d));

        if (ownerGeneral.length) {
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            out += '👑 *OWNER ONLY COMMANDS*\n';
            out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            for (const def of ownerGeneral) out += fmtCmd(def) + '\n';
            out += '\n';
        }

        if (ownerMovie.length) {
            out += '👑⭐ *OWNER — MOVIE MANAGEMENT*\n\n';
            for (const def of ownerMovie) out += fmtCmd(def) + '\n';
            out += '\n';
        }
    }

    // ─── FOOTER ───
    out += '╔════════════════════════════════╗\n';
    if (movieOnly) {
        out += '║ 🎬 MOVIE FEATURES ENABLED 🎬 ║\n';
        out += '║ 🍿 Use /movie to search 🍿  ║\n';
    } else {
        out += '║  📚 COURSES & 📰 NEWS ACTIVE   ║\n';
        out += '║   Posts at 10 AM & 10 PM IST   ║\n';
    }
    out += '╚════════════════════════════════╝\n';

    return out;
}
