/**
 * WA incoming message helpers (aligned with Baileys unwrap rules).
 */

import { normalizeMessageContent, jidNormalizedUser } from '@whiskeysockets/baileys';
import { extractPhoneNumber, isDirectMessage, normalizePhoneNumber } from './permissions.js';
import { logger } from './logger.js';

/** Strip linked-device suffix (:0) but keep user@domain intact. */
function normalizeWaJid(raw) {
    if (!raw) return '';
    const jid = String(raw).replace(/:\d+(?=@)/, '');
    return jidNormalizedUser(jid) || jid;
}

function participantToPhone(participant) {
    if (!participant) {
        return '';
    }
    const fromPn = extractPhoneNumber(participant.phoneNumber || participant.pn || '');
    if (/^\d{10,15}$/.test(fromPn)) {
        return fromPn;
    }
    const fromId = extractPhoneNumber(participant.id || '');
    if (/^\d{10,15}$/.test(fromId)) {
        return fromId;
    }
    return fromId || fromPn;
}

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
    for (const raw of [key.participantPn, key.participantLid, key.participant, key.remoteJidAlt, key.remoteJid]) {
        if (!raw) continue;
        const normalized = normalizeWaJid(raw);
        if (normalized) {
            return normalized;
        }
    }
    return key.remoteJid;
}

/**
 * All sender JIDs from an incoming group message key (LID / phone / legacy participant).
 * Order matches WhatsApp privacy fields — LID and PN are often more reliable than participant alone.
 * @param {import('@whiskeysockets/baileys').WAMessage['key']} key
 * @returns {string[]}
 */
export function collectMessageSenderDmCandidates(key) {
    if (!key) {
        return [];
    }

    const seen = new Set();
    const out = [];
    for (const raw of [key.participantPn, key.participantLid, key.participant]) {
        if (!raw) continue;
        const normalized = normalizeWaJid(raw);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

function getContextInfo(message) {
    if (!message) {
        return null;
    }
    const c = normalizeMessageContent(message);
    if (!c) {
        return null;
    }

    for (const value of Object.values(c)) {
        if (value && typeof value === 'object' && value.contextInfo?.quotedMessage) {
            return value.contextInfo;
        }
    }

    return (
        c.extendedTextMessage?.contextInfo ||
        c.imageMessage?.contextInfo ||
        c.videoMessage?.contextInfo ||
        c.documentMessage?.contextInfo ||
        c.stickerMessage?.contextInfo ||
        null
    );
}

/**
 * Build a Baileys message object for downloading quoted media (stickers, images, etc.)
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null}
 */
export function buildQuotedTargetMessage(waMessage) {
    if (!waMessage?.message) {
        return null;
    }
    const ctx = getContextInfo(waMessage.message);
    const quotedMsg = ctx?.quotedMessage;
    if (!quotedMsg) {
        return null;
    }

    const result = {
        ...waMessage,
        message: quotedMsg,
    };

    if (ctx?.stanzaId) {
        result.key = {
            ...waMessage.key,
            id: ctx.stanzaId,
            remoteJid: ctx.remoteJid || waMessage.key?.remoteJid,
            ...(ctx.participant ? { participant: ctx.participant } : {}),
            ...(ctx.participantLid ? { participantLid: ctx.participantLid } : {}),
            ...(ctx.participantPn ? { participantPn: ctx.participantPn } : {}),
        };
    }

    return result;
}

/**
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @returns {string}
 */
export function getQuotedParticipantJid(waMessage) {
    const ctx = getContextInfo(waMessage?.message);
    return ctx?.participantPn || ctx?.participantLid || ctx?.participant || '';
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
            (p) =>
                p.id === jid ||
                p.lid === jid ||
                p.phoneNumber === jid ||
                p.pn === jid ||
                p.id?.includes(direct),
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

/**
 * Target member for moderation commands: reply, @mention, or phone in args.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {string[]} args
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @returns {Promise<{ jid: string, phone: string } | null>}
 */
export async function resolveTargetParticipant(sock, chatId, args, waMessage, senderJid) {
    if (waMessage) {
        const quoted = getQuotedParticipantJid(waMessage);
        if (quoted && quoted !== senderJid) {
            const phone = (await resolveJidToPhone(sock, chatId, quoted)).replace(/\D/g, '');
            return { jid: quoted, phone };
        }

        for (const jid of getMentionedJids(waMessage)) {
            if (!jid || jid === senderJid) {
                continue;
            }
            const phone = (await resolveJidToPhone(sock, chatId, jid)).replace(/\D/g, '');
            return { jid, phone };
        }
    }

    const fromArgs = args.join('').replace(/\D/g, '');
    if (fromArgs.length >= 10 && chatId?.endsWith('@g.us') && sock) {
        try {
            const meta = await sock.groupMetadata(chatId);
            for (const p of meta.participants || []) {
                const pPhone = participantToPhone(p);
                const normalized = normalizePhoneNumber(pPhone);
                if (
                    normalized === normalizePhoneNumber(fromArgs) ||
                    p.id.includes(fromArgs) ||
                    (p.lid && p.lid.includes(fromArgs))
                ) {
                    return { jid: p.id, phone: normalized || fromArgs };
                }
            }
        } catch {
            // fall through
        }
        return { jid: `${fromArgs}@s.whatsapp.net`, phone: fromArgs };
    }

    return null;
}

/**
 * Whether the message targets someone other than the sender (reply / @tag / phone).
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null} waMessage
 * @param {string} senderJid
 * @param {string[]} [args]
 * @returns {boolean}
 */
export function hasModerationTarget(waMessage, senderJid, args = []) {
    if (args.join('').replace(/\D/g, '').length >= 10) {
        return true;
    }
    if (!waMessage) {
        return false;
    }
    const quoted = getQuotedParticipantJid(waMessage);
    if (quoted && quoted !== senderJid) {
        return true;
    }
    return getMentionedJids(waMessage).some((jid) => jid && jid !== senderJid);
}

/**
 * Normalize the conversation JID from an incoming message key.
 * @param {import('@whiskeysockets/baileys').WAMessage['key']} key
 * @returns {string}
 */
export function resolveConversationChatId(key) {
    if (!key?.remoteJid) {
        return '';
    }
    return normalizeWaJid(key.remoteJid);
}

/**
 * Ordered JIDs to try when replying in a direct chat (LID / phone / alt fields).
 * @param {import('@whiskeysockets/baileys').WAMessage['key'] | null | undefined} key
 * @param {string} chatId
 * @returns {string[]}
 */
export function collectDirectMessageSendTargets(key, chatId) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
        if (!raw) return;
        const jid = normalizeWaJid(raw);
        if (!jid || seen.has(jid)) return;
        seen.add(jid);
        out.push(jid);
    };

    add(chatId);
    if (key) {
        add(key.remoteJid);
        add(key.remoteJidAlt);
        add(key.participantPn);
        add(key.participantLid);
        add(key.participant);
    }
    return out;
}

function isLidJid(jid) {
    return Boolean(jid && (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')));
}

/**
 * Build sendMessage options, omitting quote when it can hang Baileys (LID chats/users).
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} waMessage
 * @param {object} [extra]
 * @returns {object}
 */
export function getSafeSendOptions(waMessage, extra = {}) {
    const opts = { linkPreview: false, ...extra };
    if (!waMessage?.key) {
        return opts;
    }

    const key = waMessage.key;
    const chatJid = key.remoteJid || '';
    const isGroup = chatJid.endsWith('@g.us');

    // Quoting in DMs can hang Baileys — never quote private chats.
    if (!isGroup) {
        return opts;
    }

    const senderHint =
        key.participantPn || key.participantLid || key.participant || key.remoteJidAlt || '';
    const lidInvolved =
        isLidJid(senderHint) ||
        isLidJid(key.remoteJidAlt) ||
        isLidJid(chatJid);

    if (!lidInvolved) {
        opts.quoted = waMessage;
    }
    return opts;
}

/**
 * Send a message with DM fallbacks on failure. Groups use a single direct send.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {object} content
 * @param {import('@whiskeysockets/baileys').proto.IWebMessageInfo | null | undefined} [waMessage]
 * @param {object} [extraOpts]
 * @returns {Promise<object>}
 */
export async function safeSendMessage(sock, chatId, content, waMessage = null, extraOpts = {}) {
    if (!sock?.sendMessage) {
        throw new Error('WhatsApp socket not ready');
    }

    const resolvedChatId = chatId || resolveConversationChatId(waMessage?.key);
    if (!resolvedChatId) {
        throw new Error('No chat id for reply');
    }

    const primaryOpts = getSafeSendOptions(waMessage, extraOpts);

    const trySend = async (jid, opts) => {
        const sent = await sock.sendMessage(jid, content, opts);
        if (!sent) {
            throw new Error('sendMessage returned empty result');
        }
        return sent;
    };

    try {
        return await trySend(resolvedChatId, primaryOpts);
    } catch (primaryErr) {
        logger.warn(`Send failed for ${resolvedChatId}: ${primaryErr?.message || primaryErr}`);
    }

    if (!isDirectMessage(resolvedChatId)) {
        throw new Error(`Send failed for ${resolvedChatId}`);
    }

    const fallbackOpts = { linkPreview: false, ...extraOpts };
    const alternates = collectDirectMessageSendTargets(waMessage?.key, resolvedChatId)
        .filter((jid) => jid !== resolvedChatId);

    for (const jid of alternates) {
        try {
            const sent = await trySend(jid, fallbackOpts);
            logger.info(`DM reply delivered via fallback JID ${jid}`);
            return sent;
        } catch (err) {
            logger.warn(`DM fallback send failed for ${jid}: ${err?.message || err}`);
        }
    }

    throw new Error(`Send failed for ${resolvedChatId}`);
}

/**
 * Last-resort plain send — no quotes, no fallbacks. Used for error notices.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} chatId
 * @param {object} content
 */
export async function plainSendMessage(sock, chatId, content) {
    if (!sock?.sendMessage || !chatId) return null;
    try {
        return await sock.sendMessage(chatId, content, { linkPreview: false });
    } catch (err) {
        logger.warn(`plainSendMessage failed for ${chatId}: ${err?.message || err}`);
        return null;
    }
}
