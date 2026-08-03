/**
 * Self-check: view-once quote extraction (wrappers + viewOnce flag).
 * Run: node scripts/check-viewonce.js
 */
import assert from 'assert';
import { extractViewOnceMedia } from '../src/controllers/handlers/viewOnceHandler.js';

// Legacy wrapper
{
    const r = extractViewOnceMedia({
        viewOnceMessageV2: {
            message: {
                imageMessage: { url: 'x', mediaKey: Buffer.from('a'), caption: 'hi' },
            },
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'image');
    assert.equal(r.caption, 'hi');
}

// Modern: plain media with viewOnce flag (what WA often puts in quotedMessage)
{
    const r = extractViewOnceMedia({
        imageMessage: {
            viewOnce: true,
            url: 'x',
            mediaKey: Buffer.from('a'),
            caption: 'secret',
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'image');
    assert.equal(r.caption, 'secret');
}

// Ephemeral + V2
{
    const r = extractViewOnceMedia({
        ephemeralMessage: {
            message: {
                viewOnceMessageV2: {
                    message: {
                        videoMessage: { viewOnce: true, url: 'v', mediaKey: Buffer.from('b') },
                    },
                },
            },
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'video');
}

// Normal image reply — reject
{
    const r = extractViewOnceMedia({
        imageMessage: { url: 'x', mediaKey: Buffer.from('a'), caption: 'normal' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_view_once');
}

// Empty / opened stub
{
    const r = extractViewOnceMedia({ conversation: 'View once photo' });
    assert.equal(r.ok, false);
}

console.log('OK viewonce extract');
