/**
 * Welcome message helpers.
 *
 * Default header (always included when welcome is ON):
 *   hey @username , welcome to "{group}"
 *
 * Custom text from /setwc is appended on the next line.
 */

const USERNAME_PLACEHOLDER = '@username';
const GROUP_PLACEHOLDER = '{group}';

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
 * @param {string} customPart
 * @param {string} groupName
 * @param {string} memberJid
 * @returns {{ text: string, mentions: string[] }}
 */
export function renderWelcomeMessage(customPart, groupName, memberJid) {
    const safeGroup = groupName || 'this group';
    const template = buildWelcomeTemplate(customPart);
    const mentionToken = `@${memberJid.split('@')[0]}`;

    let text = template
        .split(USERNAME_PLACEHOLDER)
        .join(mentionToken)
        .split(GROUP_PLACEHOLDER)
        .join(safeGroup)
        .split('"Group Name"')
        .join(safeGroup);

    return { text, mentions: [memberJid] };
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
