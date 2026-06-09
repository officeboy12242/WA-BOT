/**
 * WA incoming message helpers (aligned with Baileys unwrap rules).
 */

import { normalizeMessageContent } from '@whiskeysockets/baileys';

/**
 * Text the user actually typed, after unwrapping ephemeral / view-once / edits / document-with-caption, etc.
 * @param {import('@whiskeysockets/baileys').proto.Message | null | undefined} message
 * @returns {string}
 */
export function getTextFromWAMessage(message) {
    if (!message) {
        return '';
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return '';
    }
    if (typeof c.conversation === 'string' && c.conversation) {
        return c.conversation;
    }
    if (c.extendedTextMessage?.text) {
        return c.extendedTextMessage.text;
    }
    if (c.imageMessage?.caption) {
        return c.imageMessage.caption;
    }
    if (c.videoMessage?.caption) {
        return c.videoMessage.caption;
    }
    if (c.documentMessage?.caption) {
        return c.documentMessage.caption;
    }
    return '';
}

/**
 * Broader text extraction for URL detection. Link previews often put the URL in
 * `matchedText` (not `text`), and descriptions/titles can hold link metadata.
 * @param {import('@whiskeysockets/baileys').proto.Message | null | undefined} message
 * @returns {string}
 */
export function getTextForUrlScan(message) {
    if (!message) {
        return '';
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return '';
    }
    const parts = [];
    if (typeof c.conversation === 'string' && c.conversation) {
        parts.push(c.conversation);
    }
    const et = c.extendedTextMessage;
    if (et?.text) {
        parts.push(et.text);
    }
    if (et?.matchedText) {
        parts.push(et.matchedText);
    }
    if (et?.description) {
        parts.push(et.description);
    }
    if (et?.title) {
        parts.push(et.title);
    }
    if (c.imageMessage?.caption) {
        parts.push(c.imageMessage.caption);
    }
    if (c.videoMessage?.caption) {
        parts.push(c.videoMessage.caption);
    }
    if (c.documentMessage?.caption) {
        parts.push(c.documentMessage.caption);
    }
    return parts.join('\n');
}

/**
 * Author JID for permission checks. Groups may only set participantLid (LID mode), not participant.
 * @param {import('@whiskeysockets/baileys').WAMessage['key']} key
 * @returns {string}
 */
export function getMessageSenderJid(key) {
    if (!key?.remoteJid) {
        return '';
    }
    if (key.remoteJid.endsWith('@g.us')) {
        return key.participant || key.participantLid || key.participantPn || '';
    }
    return key.participant || key.remoteJid;
}
