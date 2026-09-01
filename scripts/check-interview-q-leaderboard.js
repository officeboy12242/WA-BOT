/**
 * Self-check: Interview Q poll vote scoring + weekly leaderboard formatting.
 * Run: node scripts/check-interview-q-leaderboard.js
 */
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import {
    buildOptionLetterMap,
    selectedOptionLetter,
    buildWeeklyLeaderboard,
    formatWeeklyLeaderboard,
    computeStreak,
    sha256Hex,
} from '../src/interviewQuestion/interviewQuestion.pollVotes.js';
import { formatWeeklySummary } from '../src/interviewQuestion/interviewQuestion.service.js';
import { withHiddenMentions } from '../src/utils/hiddenMentionAll.js';

const options = [
    'A. O(n)',
    'B. O(log n)',
    'C. O(n log n)',
    'D. O(1)',
];
const map = buildOptionLetterMap(options);
assert.equal(map.size, 4);
assert.equal(map.get(sha256Hex(options[1])), 'B');

// Match Baileys Buffer#toString() of raw sha256 digest
const rawHash = createHash('sha256').update(Buffer.from(options[1])).digest();
assert.equal(selectedOptionLetter({ selectedOptions: [rawHash] }, options), 'B');

const docs = [
    {
        type: 'DSA',
        correct_option: 'B',
        question_posted_at: new Date('2026-08-28T10:00:00+05:30'),
        votes: [
            { voter_jid: 'a@s.whatsapp.net', voter_phone: '91a', voter_name: 'Priya', option: 'B' },
            { voter_jid: 'b@s.whatsapp.net', voter_phone: '91b', voter_name: 'Amit', option: 'A' },
        ],
    },
    {
        type: 'SQL',
        correct_option: 'A',
        question_posted_at: new Date('2026-08-29T10:00:00+05:30'),
        votes: [
            { voter_jid: 'a@s.whatsapp.net', voter_phone: '91a', voter_name: 'Priya', option: 'A' },
            { voter_jid: 'b@s.whatsapp.net', voter_phone: '91b', voter_name: 'Amit', option: 'A' },
            { voter_jid: 'c@s.whatsapp.net', voter_phone: '91c', voter_name: 'Rahul', option: 'C' },
        ],
    },
    {
        type: 'Weekly Summary',
        correct_option: 'A',
        votes: [{ voter_jid: 'x', voter_phone: 'x', voter_name: 'X', option: 'A' }],
    },
];

const board = buildWeeklyLeaderboard(docs, {
    nowMs: new Date('2026-08-29T20:00:00+05:30').getTime(),
    timezone: 'Asia/Kolkata',
});
assert.equal(board[0].name, 'Priya');
assert.equal(board[0].correct, 2);
assert.equal(board[0].attempted, 2);
assert.equal(board[1].name, 'Amit');
assert.equal(board[1].correct, 1);
assert.equal(board[1].attempted, 2);
assert.ok(!board.some((r) => r.name === 'X'), 'weekly summary votes ignored');

const text = formatWeeklyLeaderboard(board, { weekLabel: 'Week of 28 Aug' });
assert.match(text, /WEEKLY INTERVIEW LEADERBOARD/);
assert.match(text, /🥇 \*Priya\*/);
assert.match(text, /🥈 \*Amit\*/);

const combined = formatWeeklySummary(docs.filter((d) => d.type !== 'Weekly Summary'), {
    weekLabel: 'Week of 28 Aug',
    leaderboardText: text,
});
assert.match(combined, /LEADERBOARD/);
assert.match(combined, /WEEKEND INTERVIEW Q RECAP/);

const ping = withHiddenMentions('🧠 Interview Q', {
    mentions: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
    tagText: '\n\n@ @', // ignored — must not leak into visible text
});
assert.equal(ping.text, '🧠 Interview Q', 'no visible @ wall');
assert.deepEqual(ping.mentions, ['111@s.whatsapp.net', '222@s.whatsapp.net']);
assert.equal(
    withHiddenMentions('hi', { mentions: [], tagText: '@ @' }).text,
    'hi',
    'empty mentions → plain text'
);

const streak = computeStreak(
    new Set(['2026-08-28', '2026-08-29']),
    new Date('2026-08-29T20:00:00+05:30').getTime(),
    'Asia/Kolkata'
);
assert.equal(streak, 2);

console.log('check-interview-q-leaderboard: ok');
console.log('\n── sample board ──\n' + text);
