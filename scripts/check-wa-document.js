/**
 * Self-check: WhatsApp document resolve / hydrate for /roast.
 * Run: node scripts/check-wa-document.js
 */
import assert from 'node:assert/strict';
import {
    findDocumentInMessage,
    resolveDocumentTarget,
    hydrateDocumentTarget,
    hasDocumentMediaFields,
    hasWaDocument,
} from '../src/utils/waDocument.js';

// ── attached shapes ─────────────────────────────────────────────────────────
{
    const plain = { documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', url: 'https://x', mediaKey: Buffer.from('k') } };
    assert.ok(findDocumentInMessage(plain));
    assert.equal(resolveDocumentTarget({ message: plain }).source, 'attached');

    const wrapped = {
        documentWithCaptionMessage: {
            message: { documentMessage: { fileName: 'b.pdf', caption: '/roast', url: 'https://x', mediaKey: Buffer.from('k') } },
        },
    };
    assert.ok(hasWaDocument({ message: wrapped }));
}

// ── quoted stub (no media) ──────────────────────────────────────────────────
{
    const cmd = {
        key: { id: 'CMD', remoteJid: 'g@g.us' },
        message: {
            extendedTextMessage: {
                text: '/roast',
                contextInfo: {
                    stanzaId: 'DOC1',
                    remoteJid: 'g@g.us',
                    quotedMessage: {
                        documentMessage: { fileName: 'Resume.pdf', mimetype: 'application/pdf' },
                    },
                },
            },
        },
    };
    const target = resolveDocumentTarget(cmd);
    assert.equal(target.source, 'quoted');
    assert.equal(hasDocumentMediaFields(target.document), false);

    // Without cache, hydrate is a no-op
    assert.equal(hydrateDocumentTarget({}, cmd, target).source, 'quoted');

    // With cache holding the full original, hydrate upgrades media fields
    const sock = {
        __getCachedMessage: (key) => {
            if (key.id === 'DOC1' && key.remoteJid === 'g@g.us') {
                return {
                    documentMessage: {
                        fileName: 'Resume.pdf',
                        mimetype: 'application/pdf',
                        url: 'https://mmg.whatsapp.net/x',
                        mediaKey: Buffer.from('abcd'),
                        directPath: '/v/t',
                    },
                };
            }
            return undefined;
        },
    };
    const hydrated = hydrateDocumentTarget(sock, cmd, target);
    assert.equal(hydrated.source, 'quoted-hydrated');
    assert.equal(hasDocumentMediaFields(hydrated.document), true);
}

// ── nested interactive-style header ─────────────────────────────────────────
{
    const interactive = {
        interactiveMessage: {
            header: {
                documentMessage: {
                    fileName: 'c.pdf',
                    mimetype: 'application/pdf',
                    url: 'https://x',
                    mediaKey: Buffer.from('k'),
                },
            },
        },
    };
    assert.ok(findDocumentInMessage(interactive), 'deep walk finds header.documentMessage');
}

console.log('check-wa-document: ok');
