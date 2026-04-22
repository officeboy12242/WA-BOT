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
    // Extract number before @ symbol
    return jid.split('@')[0];
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
