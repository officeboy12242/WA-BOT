/**
 * Self-check: premium vs spot must not false-trigger "past T1".
 * Run: node scripts/check-trade-entry-state.js
 */
import assert from 'assert';
import { computeEntryState, ENTRY_STATES, levelsLookLikeOptionPremiums } from '../src/utils/tradeEntryState.js';

assert.ok(levelsLookLikeOptionPremiums(2500, 40, 55, 70));
assert.ok(!levelsLookLikeOptionPremiums(100, 98, 102, 110));

const fno = computeEntryState({
    marketMode: 'OPEN',
    quote: { price: 2450 },
    entryLow: 35,
    entryHigh: 42,
    target1: 55,
});
assert.strictEqual(fno.state, ENTRY_STATES.VALID_ENTRY, 'F&O premiums must not be past-T1 vs spot');

const spotMiss = computeEntryState({
    marketMode: 'OPEN',
    quote: { price: 120 },
    entryLow: 100,
    entryHigh: 105,
    target1: 112,
});
assert.strictEqual(spotMiss.state, ENTRY_STATES.ENTRY_MISSED, 'spot plan past T1 still missed');

const chasing = computeEntryState({
    marketMode: 'OPEN',
    quote: { price: 150 },
    entryLow: 100,
    entryHigh: 110,
    target1: 200,
});
assert.strictEqual(chasing.state, ENTRY_STATES.ENTRY_MISSED, 'spot chase still missed');

console.log('trade entry state self-check ok');
