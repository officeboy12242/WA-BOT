/**
 * Find / download WhatsApp document or image attachments (current msg or quoted).
 */

import { downloadMediaMessage, normalizeMessageContent } from 'baileys';
import pino from 'pino';
import { buildQuotedTargetMessage } from './waMessage.js';

const baileysLogger = pino({ level: 'silent' });
const DOWNLOAD_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Document download timed out')), ms)),
    ]);
}

/**
 * @param {import('baileys').proto.IMessage | null | undefined} message
 * @returns {{ document: object, wrapperMessage: object } | null}
 */
export function findDocumentInMessage(message) {
    if (!message) return null;
    const c = normalizeMessageContent(message) || message;
    const doc =
        c.documentMessage ||
        c.documentWithCaptionMessage?.message?.documentMessage ||
        null;
    if (!doc) return null;
    return { document: doc, wrapperMessage: c.documentMessage ? c : { documentMessage: doc } };
}

/**
 * @param {import('baileys').proto.IMessage | null | undefined} message
 * @returns {{ image: object, wrapperMessage: object } | null}
 */
export function findImageInMessage(message) {
    if (!message) return null;
    const c = normalizeMessageContent(message) || message;
    const img = c.imageMessage || null;
    if (!img) return null;
    return { image: img, wrapperMessage: { imageMessage: img } };
}

/**
 * Prefer attached document; else quoted document.
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 */
export function resolveDocumentTarget(waMessage) {
    if (!waMessage?.message) return null;

    const attached = findDocumentInMessage(waMessage.message);
    if (attached) {
        return {
            waMessage: { ...waMessage, message: attached.wrapperMessage },
            document: attached.document,
            source: 'attached',
            kind: 'document',
        };
    }

    const quoted = buildQuotedTargetMessage(waMessage);
    if (!quoted?.message) return null;
    const qDoc = findDocumentInMessage(quoted.message);
    if (!qDoc) return null;
    return {
        waMessage: { ...quoted, message: qDoc.wrapperMessage },
        document: qDoc.document,
        source: 'quoted',
        kind: 'document',
    };
}

/**
 * Prefer attached image; else quoted image (photo of resume).
 * @param {import('baileys').proto.IWebMessageInfo | null | undefined} waMessage
 */
export function resolveImageTarget(waMessage) {
    if (!waMessage?.message) return null;

    const attached = findImageInMessage(waMessage.message);
    if (attached) {
        return {
            waMessage: { ...waMessage, message: attached.wrapperMessage },
            image: attached.image,
            source: 'attached',
            kind: 'image',
        };
    }

    const quoted = buildQuotedTargetMessage(waMessage);
    if (!quoted?.message) return null;
    const qImg = findImageInMessage(quoted.message);
    if (!qImg) return null;
    return {
        waMessage: { ...quoted, message: qImg.wrapperMessage },
        image: qImg.image,
        source: 'quoted',
        kind: 'image',
    };
}

/** Document first, then image — used by ATS / resume flows. */
export function resolveResumeMediaTarget(waMessage) {
    return resolveDocumentTarget(waMessage) || resolveImageTarget(waMessage);
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<{ buffer: Buffer, fileName: string, mimetype: string }>}
 */
export async function downloadWaDocument(sock, waMessage) {
    const target = resolveDocumentTarget(waMessage);
    if (!target) {
        throw new Error('No document found');
    }

    const buffer = await withTimeout(
        downloadMediaMessage(
            target.waMessage,
            'buffer',
            {},
            {
                logger: baileysLogger,
                reuploadRequest: sock?.updateMediaMessage
                    ? sock.updateMediaMessage.bind(sock)
                    : undefined,
            }
        ),
        DOWNLOAD_TIMEOUT_MS
    );

    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty document download');
    }

    return {
        buffer,
        fileName: String(target.document.fileName || target.document.title || ''),
        mimetype: String(target.document.mimetype || ''),
    };
}

/**
 * Download resume media (PDF/DOC/DOCX document or photo).
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 */
export async function downloadWaResumeMedia(sock, waMessage) {
    const target = resolveResumeMediaTarget(waMessage);
    if (!target) {
        throw new Error('No document found');
    }

    const buffer = await withTimeout(
        downloadMediaMessage(
            target.waMessage,
            'buffer',
            {},
            {
                logger: baileysLogger,
                reuploadRequest: sock?.updateMediaMessage
                    ? sock.updateMediaMessage.bind(sock)
                    : undefined,
            }
        ),
        DOWNLOAD_TIMEOUT_MS
    );

    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty document download');
    }

    if (target.kind === 'image') {
        const mime = String(target.image.mimetype || 'image/jpeg');
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        return {
            buffer,
            fileName: String(target.image.caption || `resume.${ext}`).slice(0, 80),
            mimetype: mime,
        };
    }

    return {
        buffer,
        fileName: String(target.document.fileName || target.document.title || ''),
        mimetype: String(target.document.mimetype || ''),
    };
}

export function hasWaDocument(waMessage) {
    return Boolean(resolveDocumentTarget(waMessage));
}

export function hasWaResumeMedia(waMessage) {
    return Boolean(resolveResumeMediaTarget(waMessage));
}
