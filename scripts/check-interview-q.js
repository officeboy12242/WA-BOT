/**
 * Self-check: normalizeQuestion + formatAnswerMessage + poll helpers + JSON repair + dedup + summary.
 * Run: node scripts/check-interview-q.js
 */

import {
    normalizeQuestion,
    formatAnswerMessage,
    formatPollName,
    formatWeeklySummary,
    pollValues,
    buildPollQuote,
    extractJsonObject,
    repairLlmJson,
    questionFingerprint,
    pickDifficulty,
    normalizeDifficulty,
} from '../src/interviewQuestion/interviewQuestion.service.js';
import {
    msUntilNextSaturday,
    saturdaySummaryKey,
} from '../src/interviewQuestion/interviewQuestion.scheduler.js';

const sample = {
    type: 'DSA',
    difficulty: 'Medium',
    topic: 'Arrays',
    question: 'What is the time complexity of binary search on a sorted array?',
    options: {
        A: 'O(n)',
        B: 'O(log n)',
        C: 'O(n log n)',
        D: 'O(1)',
    },
    correctOption: 'B',
    properAnswer: 'Binary search runs in O(log n) time.',
    explanation: 'Each step halves the search space.',
    hint: 'Think divide and conquer.',
    approach: 'Compare mid, discard half.',
    timeComplexity: 'O(log n)',
    spaceComplexity: 'O(1)',
    commonMistake: 'Using linear scan instead.',
};

const q = normalizeQuestion(sample);
if (q.correctOption !== 'B') throw new Error('correctOption');
if (q.difficulty !== 'Medium') throw new Error('difficulty');
if (!q.questionFp) throw new Error('fingerprint missing');
if (pollValues(q).length !== 4) throw new Error('poll values');
if (!formatPollName(q).includes('binary search')) throw new Error('poll name');

const answer = formatAnswerMessage(q);
if (!answer.includes('Correct:') || !answer.includes('O(log n)')) {
    throw new Error('answer format');
}

// reject Easy
let easyThrew = false;
try {
    normalizeQuestion({ ...sample, difficulty: 'Easy' });
} catch {
    easyThrew = true;
}
if (!easyThrew) throw new Error('should reject Easy');

// reject bad input
let threw = false;
try {
    normalizeQuestion({ ...sample, options: { A: 'x' } });
} catch {
    threw = true;
}
if (!threw) throw new Error('should reject incomplete options');

const quote = buildPollQuote(
    {
        jid: '120363@g.us',
        poll_message_id: 'ABC123',
        poll_message_key: { remoteJid: '120363@g.us', id: 'ABC123', fromMe: true },
    },
    q
);
if (!quote?.key?.id || quote.key.id !== 'ABC123') throw new Error('poll quote key');

// Fingerprints stable + near-dup collapse
const fp1 = questionFingerprint('What is Binary Search?');
const fp2 = questionFingerprint('what is binary search?');
const fp3 = questionFingerprint('What is  Binary   Search ?');
if (fp1 !== fp2 || fp1 !== fp3) throw new Error('fingerprint should normalize');
if (normalizeDifficulty('difficult') !== 'Hard') throw new Error('difficult→Hard');
if (!['Medium', 'Hard'].includes(pickDifficulty(0))) throw new Error('pickDifficulty');

const summary = formatWeeklySummary(
    [
        {
            type: 'DSA',
            difficulty: 'Hard',
            topic: 'Graphs',
            question: 'Which traversal uses a queue?',
            correct_option: 'A',
            options: { A: 'BFS', B: 'DFS', C: 'Dijkstra', D: 'Prim' },
            explanation: 'BFS explores level by level with a queue.',
        },
    ],
    { weekLabel: 'Week of 20 Jul' }
);
if (!summary.includes('WEEKEND INTERVIEW Q RECAP') || !summary.includes('BFS')) {
    throw new Error('weekly summary format');
}

// Broken LLM JSON: unescaped " inside explanation
const broken = `{
  "type": "DSA",
  "difficulty": "Medium",
  "topic": "Arrays",
  "question": "What does Array.sort() return in JS?",
  "options": {
    "A": "A new sorted array",
    "B": "The same array, sorted in place",
    "C": "A boolean",
    "D": "undefined"
  },
  "correctOption": "B",
  "properAnswer": "It sorts in place and returns the same array.",
  "explanation": "In JS, Array.sort() mutates the array (uses "compare" fn) and returns it.",
  "hint": "Check MDN",
  "approach": "Read the docs",
  "timeComplexity": "O(n log n)",
  "spaceComplexity": "O(1)",
  "commonMistake": "Assuming it returns a copy"
}`;

let parseThrew = false;
try {
    JSON.parse(broken);
} catch {
    parseThrew = true;
}
if (!parseThrew) throw new Error('fixture should be invalid JSON');

const repaired = repairLlmJson(broken);
JSON.parse(repaired);
const fromBroken = normalizeQuestion(extractJsonObject(broken));
if (fromBroken.correctOption !== 'B') throw new Error('repaired correctOption');
if (!fromBroken.explanation.includes('compare')) throw new Error('repaired explanation');

// Saturday helper exports
if (typeof msUntilNextSaturday !== 'function' || typeof saturdaySummaryKey !== 'function') {
    throw new Error('saturday helpers missing');
}
const delay = msUntilNextSaturday(22, 0, 'Asia/Kolkata');
if (!(delay > 0 && delay <= 8 * 24 * 60 * 60 * 1000)) throw new Error('msUntilNextSaturday range');
if (!/^summary-\d{4}-\d{2}-\d{2}$/.test(saturdaySummaryKey('Asia/Kolkata'))) {
    throw new Error('summary key format');
}

console.log('interview q check ok');
