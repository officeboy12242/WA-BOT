/**
 * Self-check: normalizeQuestion + formatAnswerMessage + poll helpers.
 * Run: node scripts/check-interview-q.js
 */

import {
    normalizeQuestion,
    formatAnswerMessage,
    formatPollName,
    pollValues,
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

console.log('interview q check ok');
