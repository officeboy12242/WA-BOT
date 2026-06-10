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
        names: ['/ping'],
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
        names: ['/news'],
        key: 'news',
        scope: 'any',
        role: 'anyone',
        help: 'Preview 10 tech news items; staff post to activated groups',
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
        help: 'Turn on courses + tech news (staff only)',
    },
    {
        names: ['/deactivate'],
        key: 'deactivate',
        scope: 'group_only',
        role: 'staff',
        help: 'Turn off courses + tech news (staff only)',
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
        help: 'Set welcome extra line; default header auto-added',
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
        help: 'Pause automatic course posting (bot-wide)',
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
 * @param {{ isStaff?: boolean, isPrivileged?: boolean, canManageAdmins?: boolean }} access
 * @returns {string}
 */
function fmtCmd(def) {
    return `• ${def.names.join(' / ')} — ${def.help}`;
}

/**
 * @param {object} opts
 * @param {boolean} opts.isStaff
 * @param {boolean} opts.isPrivileged
 * @param {boolean} opts.canManageAdmins
 * @param {boolean} opts.canSetWelcome
 * @param {boolean} opts.isOwner
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
    features = {},
} = {}) {
    const movieEnabled = features.movie || movieOnly;

    const all = COMMAND_REGISTRY;
    const isMovieCmd = (d) => d.category === 'movie';

    let out = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += '🤖 *BOT COMMANDS* 🤖\n';
    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    const anyoneGeneral = all.filter((d) => d.role === 'anyone' && !isMovieCmd(d));
    const anyoneMovie = all.filter((d) => d.role === 'anyone' && isMovieCmd(d));

    if (movieEnabled) {
        out += '🎬 *Movie Search*\n\n';
        for (const def of anyoneMovie) out += fmtCmd(def) + '\n';
        out += '\n📝 *Search tips:*\n';
        out += '`/movie Pushpa 2` · `/search Avengers` · `/m Animal`\n';
        out += '📊 5 free/day · ⭐ Premium = unlimited\n\n';
    }

    out += '📌 *Everyone*\n\n';
    for (const def of anyoneGeneral) out += fmtCmd(def) + '\n';

    if (!movieEnabled && (isStaff || isOwner)) {
        out += '\n🎬 *Movie search*\n\n';
        for (const def of anyoneMovie) out += fmtCmd(def) + '\n';
    }

    if (isStaff) {
        const staffGeneral = all.filter((d) => d.role === 'staff' && !isMovieCmd(d));
        const staffMovie = all.filter((d) => d.role === 'staff' && isMovieCmd(d));

        if (staffGeneral.length) {
            out += '\n👮 *Staff* (owners, moderators, bot admins, group admins)\n\n';
            for (const def of staffGeneral) out += fmtCmd(def) + '\n';
        }
        if (staffMovie.length) {
            out += '\n🎬 *Movie management* (staff)\n\n';
            for (const def of staffMovie) out += fmtCmd(def) + '\n';
        }
    }

    if (canManageAdmins) {
        const adminMgr = all.filter((d) => d.role === 'admin_managers');
        if (adminMgr.length) {
            out += '\n👑 *Admin managers* (owners, moderators, bot admins)\n\n';
            for (const def of adminMgr) out += fmtCmd(def) + '\n';
        }
    }

    if (canSetWelcome) {
        const wc = all.filter((d) => d.role === 'welcome_setters');
        if (wc.length) {
            out += '\n👋 *Welcome messages* (admins & admin managers)\n\n';
            for (const def of wc) out += fmtCmd(def) + '\n';
        }
    }

    if (isPrivileged) {
        const admCmds = all.filter((d) => d.role === 'admins');
        if (admCmds.length) {
            out += '\n🔧 *Admins* (owners, bot admins, or group admins in this chat)\n\n';
            for (const def of admCmds) out += fmtCmd(def) + '\n';
        }
    }

    if (isOwner) {
        const ownerGeneral = all.filter((d) => d.role === 'owner' && !isMovieCmd(d));
        const ownerMovie = all.filter((d) => d.role === 'owner' && isMovieCmd(d));

        if (ownerGeneral.length) {
            out += '\n👑 *Owner only*\n\n';
            for (const def of ownerGeneral) out += fmtCmd(def) + '\n';
        }
        if (ownerMovie.length) {
            out += '\n👑⭐ *Owner — movie management*\n\n';
            for (const def of ownerMovie) out += fmtCmd(def) + '\n';
        }
    }

    out += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    if (movieOnly) {
        out += '🎬 _Movie features enabled_ · 🍿 _`/movie <name>` to search_';
    } else {
        out += '💡 Courses post on schedule; tech news at 10 AM & 10 PM IST where activated.';
    }
    return out;
}
