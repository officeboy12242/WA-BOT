/**
 * Find / download WhatsApp document attachments (current msg or quoted).
 */

import { downloadMediaMessage, normalizeMessageContent } from 'baileys';
import pino from 'pino';
import { buildQuotedTargetMessage } from './waMessage.js';
import { logger } from './logger.js';

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
    };
}

/**
 * @param {import('baileys').WASocket} sock
 * @param {import('baileys').proto.IWebMessageInfo} waMessage
 * @returns {Promise<{ buffer: Buffer, fileName: string, mimetype: string }>}
 */
export async function downloadWaDocument(sock, waMessage) {
    const target = resolveDocumentTarget(waMessage);
    if (!target) {
        // Diagnostic dump — this shouldn't fire if the caller already checked
        // hasWaDocument() on the same waMessage, since both call the same
        // resolveDocumentTarget(). If it ever does, this tells us why instead
        // of leaving us guessing from the generic error text alone.
        const topKeys = waMessage?.message ? Object.keys(waMessage.message) : [];
        const ctxQuoted = (() => {
            try {
                const c = normalizeMessageContent(waMessage?.message);
                for (const value of Object.values(c || {})) {
                    if (value?.contextInfo?.quotedMessage) {
                        return Object.keys(value.contextInfo.quotedMessage);
                    }
                }
            } catch {}
            return null;
        })();
        logger.warn(
            `Roast: no document resolved — msgId=${waMessage?.key?.id || '?'} topKeys=${JSON.stringify(topKeys)} quotedKeys=${JSON.stringify(ctxQuoted)}`
        );
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
    ).catch((err) => {
        logger.warn(
            `Roast: document download failed (source=${target.source}, fileName=${target.document?.fileName || target.document?.title || '?'}): ${err?.message || err}`
        );
        throw err;
    });

    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty document download');
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
