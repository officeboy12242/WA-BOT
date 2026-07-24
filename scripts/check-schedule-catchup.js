/**
 * Self-check: past-due slot helper used by GitHub + Interview Q catch-up.
 * Run: node scripts/check-schedule-catchup.js
 */
import assert from 'assert';
import {
    formatSlotKey,
    getPastDueSlotsToday,
    parsePostTimesFromConfig,
} from '../src/utils/newsScheduler.js';

const times = parsePostTimesFromConfig(['13:00', '18:00']);
assert.equal(times.length, 2);

// Fake "now" = 14:30 IST on a fixed UTC instant that maps to afternoon IST
// 2026-07-24 09:00 UTC ≈ 14:30 IST
const now = new Date('2026-07-24T09:00:00.000Z');
const past = getPastDueSlotsToday(['13:00', '18:00'], 'Asia/Kolkata', now);
assert.ok(past.some((s) => s.hour === 13 && s.minute === 0), '13:00 should be past-due at 14:30 IST');
assert.ok(!past.some((s) => s.hour === 18), '18:00 should not be past-due at 14:30 IST');

const key = formatSlotKey(now, 'Asia/Kolkata', 13, 0);
assert.match(key, /T13:00$/);

console.log('OK schedule catch-up helpers', { past: past.map((s) => `${s.hour}:${s.minute}`), key });
