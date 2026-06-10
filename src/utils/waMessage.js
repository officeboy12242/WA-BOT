/**
 * WA incoming message helpers (aligned with Baileys unwrap rules).
 */

import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { extractPhoneNumber } from './permissions.js';

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

function getContextInfo(message) {
    if (!message) {
        return null;
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return null;
    }
    return (
        c.extendedTextMessage?.contextInfo ||
        c.imageMessage?.contextInfo ||
        c.videoMessage?.contextInfo ||
        c.documentMessage?.contextInfo ||
        null
    );
}

/**
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedParticipantJid(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    return ctx?.participant || ctx?.participantPn || '';
}

/**
 * Get pushName from quoted message
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedPushName(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    // Try different possible locations for the quoted sender's name
    return ctx?.pushName || 
           ctx?.quotedMessage?.pushName || 
           ctx?.pushname || 
           ctx?.quotedMessage?.pushname ||
           '';
}

/**
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string[]}
 */
export function getMentionedJids(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    return Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : [];
}

function looksLikePhone(value) {
    return /^\d{10,15}$/.test(value);
}

/**
 * Resolve a participant JID to a phone number using group metadata when needed.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {string} jid
 * @returns {Promise<string>}
 */
export async function resolveJidToPhone(sock, chatId, jid) {
    if (!jid) {
        return '';
    }
    const direct = extractPhoneNumber(jid);
    if (looksLikePhone(direct)) {
        return direct;
    }
    if (!chatId?.endsWith('@g.us') || !sock) {
        return direct;
    }
    try {
        const meta = await sock.groupMetadata(chatId);
        const hit = meta.participants.find(
            (p) => p.id === jid || p.id?.includes(direct) || p.phoneNumber === jid
        );
        if (!hit) {
            return direct;
        }
        const fromPn = extractPhoneNumber(hit.phoneNumber || hit.pn || '');
        if (looksLikePhone(fromPn)) {
            return fromPn;
        }
        const fromId = extractPhoneNumber(hit.id);
        return looksLikePhone(fromId) ? fromId : fromId || fromPn;
    } catch {
        return direct;
    }
}

/**
 * Target user for /addadmin /removeadmin: args, @mention, or reply.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {string[]} args
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @returns {Promise<string>}
 */
export async function resolveTargetPhone(sock, chatId, args, waMessage, senderJid) {
    const fromArgs = args.join('').replace(/\D/g, '');
    if (fromArgs.length >= 10) {
        return fromArgs;
    }

    if (waMessage) {
        const quoted = getQuotedParticipantJid(waMessage);
        if (quoted && quoted !== senderJid) {
            const phone = await resolveJidToPhone(sock, chatId, quoted);
            if (phone) {
                return phone.replace(/\D/g, '');
            }
        }

        for (const jid of getMentionedJids(waMessage)) {
            if (!jid || jid === senderJid) {
                continue;
            }
            const phone = await resolveJidToPhone(sock, chatId, jid);
            if (phone && looksLikePhone(phone.replace(/\D/g, ''))) {
                return phone.replace(/\D/g, '');
            }
        }
    }

    return '';
}
