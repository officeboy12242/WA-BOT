/**
 * Self-check: past-due + grace catch-up helpers used by Interview Q.
 * Run: node scripts/check-schedule-catchup.js
 */
import assert from 'assert';
import {
    formatSlotKey,
    getPastDueSlotsToday,
    getCatchUpSlotsToday,
    getExpiredSlotsToday,
    parsePostTimesFromConfig,
} from '../src/utils/newsScheduler.js';

const times = parsePostTimesFromConfig(['13:00', '18:00']);
assert.equal(times.length, 2);

// 2026-07-24 09:00 UTC ≈ 14:30 IST
const afternoon = new Date('2026-07-24T09:00:00.000Z');
const past = getPastDueSlotsToday(['13:00', '18:00'], 'Asia/Kolkata', afternoon);
assert.ok(past.some((s) => s.hour === 13 && s.minute === 0), '13:00 should be past-due at 14:30 IST');
assert.ok(!past.some((s) => s.hour === 18), '18:00 should not be past-due at 14:30 IST');

const catchUpAfternoon = getCatchUpSlotsToday(
    ['13:00', '18:00'],
    'Asia/Kolkata',
    afternoon,
    90 * 60 * 1000
);
assert.ok(
    catchUpAfternoon.some((s) => s.hour === 13),
    '13:00 still in 90m grace at 14:30'
);
assert.ok(!catchUpAfternoon.some((s) => s.hour === 18), '18:00 not catch-up at 14:30');

// 2026-07-24 12:35 UTC ≈ 18:05 IST — missed 13:00 must NOT dump with 18:00
const evening = new Date('2026-07-24T12:35:00.000Z');
const catchUpEvening = getCatchUpSlotsToday(
    ['13:00', '18:00'],
    'Asia/Kolkata',
    evening,
    90 * 60 * 1000
);
assert.ok(!catchUpEvening.some((s) => s.hour === 13), '13:00 outside grace at 18:05 — no dump');
assert.ok(catchUpEvening.some((s) => s.hour === 18), '18:00 due at 18:05');

const expired = getExpiredSlotsToday(['13:00', '18:00'], 'Asia/Kolkata', evening, 90 * 60 * 1000);
assert.ok(expired.some((s) => s.hour === 13), '13:00 marked expired at 18:05');

const key = formatSlotKey(afternoon, 'Asia/Kolkata', 13, 0);
assert.match(key, /T13:00$/);

console.log('OK schedule catch-up helpers', {
    catchUpAfternoon: catchUpAfternoon.map((s) => `${s.hour}:${s.minute}`),
    catchUpEvening: catchUpEvening.map((s) => `${s.hour}:${s.minute}`),
    expired: expired.map((s) => `${s.hour}:${s.minute}`),
    key,
});
