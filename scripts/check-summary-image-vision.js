/**
 * Self-check: image vision log formatting + Gemini describeImage guards.
 */
import assert from 'node:assert/strict';
import { formatImageLogText } from '../src/services/GroupChatLogService.js';
import GeminiTradeService from '../src/services/GeminiTradeService.js';

assert.equal(formatImageLogText('', ''), '[image]');
assert.equal(formatImageLogText('look', ''), 'look');
assert.equal(
    formatImageLogText('', 'Nifty chart at 24000'),
    '[image: Nifty chart at 24000]'
);
assert.equal(
    formatImageLogText('bro', 'screenshot of Banknifty PE ladder'),
    'bro — [image: screenshot of Banknifty PE ladder]'
);
assert.equal(
    formatImageLogText('', '  lots   of   spaces  '),
    '[image: lots of spaces]'
);
assert.ok(
    formatImageLogText('', 'x'.repeat(500)).length <= '[image: '.length + 280 + 1,
    'vision blurb is capped'
);

const gemini = new GeminiTradeService({ GEMINI_API_KEY: 'test' });
await assert.rejects(
    () => gemini.describeImage(Buffer.alloc(0)),
    /empty image buffer/,
    'empty buffer rejected'
);
await assert.rejects(
    () => gemini.describeImage(Buffer.alloc(5 * 1024 * 1024)),
    />4MB/,
    'oversized buffer rejected'
);

console.log('check-summary-image-vision: ok');
