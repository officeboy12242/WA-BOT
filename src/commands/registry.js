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
 *   - admins       → owners, bot admins, or WhatsApp group admins in that group (auto-detected)
 */

/** @typedef {'any' | 'group_only' | 'dm_only'} ChatScope */
/** @typedef {'anyone' | 'staff' | 'admins'} Role */

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
        names: ['/news'],
        key: 'news',
        scope: 'any',
        role: 'anyone',
        help: 'Preview latest Inshorts tech news digest',
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
        names: ['/groups'],
        key: 'groups',
        scope: 'any',
        role: 'admins',
        help: 'List groups where courses are posted',
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
        role: 'admins',
        help: 'Add a bot admin by phone number',
    },
    {
        names: ['/removeadmin'],
        key: 'removeadmin',
        scope: 'any',
        role: 'admins',
        help: 'Remove a bot admin',
    },
    {
        names: ['/admins'],
        key: 'admins',
        scope: 'any',
        role: 'admins',
        help: 'List bot admins',
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
 * @param {{ isStaff?: boolean, isPrivileged?: boolean }} access
 * @returns {string}
 */
export function formatHelpText({ isStaff = false, isPrivileged = false } = {}) {
    const anyone = COMMAND_REGISTRY.filter((d) => d.role === 'anyone');
    const staffOnly = COMMAND_REGISTRY.filter((d) => d.role === 'staff');
    const adminOnly = COMMAND_REGISTRY.filter((d) => d.role === 'admins');

    let out = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += '🤖 *BOT COMMANDS* 🤖\n';
    out += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    out += '📌 *Everyone*\n\n';

    for (const def of anyone) {
        const label = def.names.join(' / ');
        out += `• ${label} — ${def.help}\n`;
    }

    if (isStaff) {
        out += '\n👮 *Staff* (owners, moderators, bot admins, group admins)\n\n';
        for (const def of staffOnly) {
            const label = def.names.join(' / ');
            out += `• ${label} — ${def.help}\n`;
        }
    }

    if (isPrivileged) {
        out += '\n🔧 *Admins* (owners, bot admins, or group admins in this chat)\n\n';
        for (const def of adminOnly) {
            const label = def.names.join(' / ');
            out += `• ${label} — ${def.help}\n`;
        }
    }

    out += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    out += '💡 Courses post on schedule; tech news at 10 AM & 10 PM IST where activated.';
    return out;
}
