/**
 * Self-check Univest pick parse + WhatsApp format.
 * Run: node scripts/check-univest-pick.js
 */
import assert from 'node:assert/strict';
import { formatUnivestPick, normalizeUnivestPick } from '../src/utils/univestPickFormat.js';
import { parseUnivestWebhookBody } from '../src/services/UnivestPickRelay.js';

const pick = normalizeUnivestPick({
    symbol: 'reliance',
    action: 'buy',
    entry: 2450,
    target: 2520,
    stopLoss: 2420,
    segment: 'stock',
    title: 'Breakout watch',
});
assert.equal(pick.symbol, 'RELIANCE');
assert.ok(formatUnivestPick(pick).includes('RELIANCE'));
assert.ok(formatUnivestPick(pick).includes('2450'));

const batch = parseUnivestWebhookBody({
    picks: [{ symbol: 'TCS', action: 'SELL', entry: 4100, target: 4000, stopLoss: 4150 }],
});
assert.equal(batch.length, 1);

console.log('check-univest-pick: ok');
