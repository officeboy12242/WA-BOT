/**
 * Self-check: durable scheduler slots survive "redeploy" (fresh botState).
 * Run: node scripts/check-durable-slots.js
 */
import assert from 'assert';
import { createDurableSlotStore } from '../src/utils/durableSlots.js';
import { formatDayKey, formatSlotKey } from '../src/utils/newsScheduler.js';

const store = new Map();
const botSettings = {
    async getJson(key, fallback) {
        return store.has(key) ? store.get(key) : fallback;
    },
    async setJson(key, value) {
        store.set(key, value);
    },
};

const slots = createDurableSlotStore(botSettings, 'news');
const botState = {};
const key = formatSlotKey(new Date('2026-07-24T09:00:00.000Z'), 'Asia/Kolkata', 10, 0);

assert.equal(await slots.isDone(botState, key, 'lastNewsPostSlot'), false);
await slots.markDone(botState, key, 'lastNewsPostSlot');
assert.equal(botState.lastNewsPostSlot, key);
assert.equal(await slots.isDone(botState, key, 'lastNewsPostSlot'), true);

// Redeploy: empty memory, same Mongo
const afterReset = {};
assert.equal(await slots.isDone(afterReset, key, 'lastNewsPostSlot'), true);
assert.equal(afterReset.lastNewsPostSlot, key);

const awesome = createDurableSlotStore(botSettings, 'awesome');
const aState = {};
const aKey = '2026-07-24T13:00';
await awesome.markDone(aState, aKey, 'lastAwesomePostSlots');
assert.equal(aState.lastAwesomePostSlots[aKey], true);
const aReset = {};
assert.equal(await awesome.isDone(aReset, aKey, 'lastAwesomePostSlots'), true);

const day = formatDayKey(new Date('2026-07-24T09:00:00.000Z'), 'Asia/Kolkata');
assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(!day.includes('T'));

console.log('OK durable slots', { key, day, keys: [...store.keys()] });
