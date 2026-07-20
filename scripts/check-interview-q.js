/**
 * Self-check: normalizeQuestion + formatAnswerMessage + poll helpers + JSON repair.
 * Run: node scripts/check-interview-q.js
 */

import {
    normalizeQuestion,
    formatAnswerMessage,
    formatPollName,
    pollValues,
    buildPollQuote,
    extractJsonObject,
    repairLlmJson,
} from '../src/interviewQuestion/interviewQuestion.service.js';

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
if (pollValues(q).length !== 4) throw new Error('poll values');
if (!formatPollName(q).includes('binary search')) throw new Error('poll name');

const answer = formatAnswerMessage(q);
if (!answer.includes('Correct:') || !answer.includes('O(log n)')) {
    throw new Error('answer format');
}

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

// Broken LLM JSON: unescaped " inside explanation (same class as "expected \" after property value")
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
JSON.parse(repaired); // must not throw
const fromBroken = normalizeQuestion(extractJsonObject(broken));
if (fromBroken.correctOption !== 'B') throw new Error('repaired correctOption');
if (!fromBroken.explanation.includes('compare')) throw new Error('repaired explanation');

console.log('interview q check ok');
