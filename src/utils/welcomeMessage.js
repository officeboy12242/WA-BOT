/**
 * Welcome message helpers.
 *
 * Default header (always included when welcome is ON):
 *   hey @username , welcome to "{group}"
 *
 * Custom text from /setwc is appended on the next line.
 */

import { jidNormalizedUser } from 'baileys';

const USERNAME_PLACEHOLDER = '@username';
const GROUP_PLACEHOLDER = '{group}';

const JID_DOMAIN_RE = /@(s\.whatsapp\.net|lid(?:\.\w+)?|g\.us)$/i;

export const DEFAULT_HEADER_TEMPLATE = `hey ${USERNAME_PLACEHOLDER} , welcome to "${GROUP_PLACEHOLDER}"`;

/**
 * @param {string} [customPart]
 * @returns {string}
 */
export function buildWelcomeTemplate(customPart = '') {
    const custom = (customPart || '').trim();
    if (!custom) {
        return DEFAULT_HEADER_TEMPLATE;
    }
    return `${DEFAULT_HEADER_TEMPLATE}\n${custom}`;
}

/**
 * Strip the default header if an admin pasted the full template.
 * @param {string} input
 * @returns {string}
 */
export function normalizeCustomWelcomePart(input) {
    let text = (input || '').trim();
    if (!text) {
        return '';
    }

    text = text.replace(
        /^hey\s+@username\s*,\s*welcome\s+to\s+"(\{group\}|[^"]+)"\s*/i,
        ''
    ).trim();

    return text;
}

/**
 * @param {string} jid
 * @returns {boolean}
 */
export function isValidParticipantJid(jid) {
    const normalized = typeof jid === 'string' ? jid.replace(/:\d+(?=@)/, '').trim() : '';
    if (!normalized || !normalized.includes('@')) {
        return false;
    }
    return JID_DOMAIN_RE.test(normalized);
}

function parseEmbeddedParticipantId(raw) {
    if (typeof raw !== 'string') {
        return '';
    }
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('id')) {
        return '';
    }
    try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        if (parsed?.id) {
            return normalizeParticipantEntry(parsed.id);
        }
    } catch {
        const match = trimmed.match(/['"]?id['"]?\s*[:=]\s*['"]?([^'"},\s]+)/i);
        if (match?.[1]) {
            return normalizeParticipantEntry(match[1]);
        }
    }
    return '';
}

/**
 * Normalize Baileys participant entry (string JID or { id, lid, ... } object).
 * Rejects display names and other non-JID strings.
 * @param {string | object | null | undefined} entry
 * @returns {string}
 */
export function normalizeParticipantEntry(entry) {
    if (!entry) {
        return '';
    }
    if (typeof entry === 'string') {
        let cleaned = entry.replace(/:\d+(?=@)/, '').trim();
        if (!cleaned) {
            return '';
        }

        const embedded = parseEmbeddedParticipantId(cleaned);
        if (embedded) {
            return embedded;
        }

        if (!cleaned.includes('@')) {
            const digits = cleaned.replace(/\D/g, '');
            if (/^\d{10,15}$/.test(digits)) {
                cleaned = `${digits}@s.whatsapp.net`;
            } else {
                return '';
            }
        }

        const normalized = jidNormalizedUser(cleaned) || cleaned;
        return isValidParticipantJid(normalized) ? normalized : '';
    }
    if (typeof entry === 'object') {
        const raw = entry.id || entry.jid || entry.lid || entry.phoneNumber || entry.pn;
        if (typeof raw === 'string' && raw) {
            return normalizeParticipantEntry(raw);
        }
        if (raw && typeof raw === 'object' && raw.user) {
            const server = raw.server || 's.whatsapp.net';
            return normalizeParticipantEntry(`${raw.user}@${server}`);
        }
    }
    return '';
}

/**
 * @param {string} jid
 * @returns {string}
 */
export function mentionDisplayToken(jid) {
    if (!jid || !isValidParticipantJid(jid)) {
        return '@member';
    }
    const user = String(jid).split('@')[0].split(':')[0];
    return `@${user}`;
}

/**
 * @param {string} customPart
 * @param {string} groupName
 * @param {string} memberJid
 * @returns {{ text: string, mentions: string[] }}
 */
export function renderWelcomeMessage(customPart, groupName, memberJid) {
    const safeGroup = groupName || 'this group';
    const template = buildWelcomeTemplate(customPart);
    const safeJid = isValidParticipantJid(memberJid) ? memberJid : '';
    const mentionToken = mentionDisplayToken(safeJid);

    let text = template
        .split(USERNAME_PLACEHOLDER)
        .join(mentionToken)
        .split(GROUP_PLACEHOLDER)
        .join(safeGroup)
        .split('"Group Name"')
        .join(safeGroup);

    return { text, mentions: safeJid ? [safeJid] : [] };
}

/**
 * @param {string} customPart
 * @param {string} groupName
 * @returns {string}
 */
export function previewWelcomeMessage(customPart, groupName) {
    const { text } = renderWelcomeMessage(
        customPart,
        groupName,
        '919999999999@s.whatsapp.net'
    );
    return text.replace('@919999999999', '@NewMember');
}

/**
 * @param {boolean} enabled
 * @returns {string}
 */
export function formatWelcomeStatus(enabled) {
    return enabled ? '✅ ON' : '❌ OFF';
}

export { USERNAME_PLACEHOLDER, GROUP_PLACEHOLDER };
