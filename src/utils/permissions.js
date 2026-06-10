/**
 * Permission Utilities
 * Helper functions for permission checks
 */

/**
 * Extract phone number from WhatsApp JID
 * @param {string} jid - WhatsApp JID (e.g., "919876543210@s.whatsapp.net")
 * @returns {string} - Phone number
 */
export function extractPhoneNumber(jid) {
    if (!jid) return '';
    // Extract number before @ symbol, also handle :0 suffix in newer WhatsApp
    const beforeAt = jid.split('@')[0];
    // Remove :0 or :XX device suffix if present
    return beforeAt.split(':')[0];
}

/**
 * Digits-only phone for DB lookups and comparisons.
 * @param {string} value
 * @returns {string}
 */
export function normalizePhoneNumber(value) {
    if (!value) {
        return '';
    }
    return String(value).replace(/\D/g, '');
}

/**
 * Check if message is from a group
 * @param {string} jid - WhatsApp JID
 * @returns {boolean}
 */
export function isGroupMessage(jid) {
    return jid && jid.endsWith('@g.us');
}

/**
 * Extract group ID from JID
 * @param {string} jid - WhatsApp JID
 * @returns {string}
 */
export function extractGroupId(jid) {
    return jid;
}
