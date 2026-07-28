/**
 * Self-check: weak group-summary detection + OpenRouter summary model filtering.
 */
import assert from 'node:assert/strict';
import { isUsableGroupSummary } from '../src/controllers/GroupSummaryController.js';
import OpenRouterLlmService from '../src/services/OpenRouterLlmService.js';

assert.equal(
    isUsableGroupSummary({
        topics: [
            { title: 'General discussion', detail: 'Members talked about various topics today.' },
            { title: 'Casual chat', detail: 'Random chat throughout the day.' },
        ],
        wrap_up: 'People chatted.',
    }),
    false,
    'vague topics should be rejected',
);

assert.equal(
    isUsableGroupSummary({
        topics: [
            {
                title: 'Weekend trek plan',
                detail: 'Riya and Aman debated Lonavala vs Igatpuri for Saturday morning.',
            },
            {
                title: 'Office Wi‑Fi outage',
                detail: 'Priya said VPN kept dropping; Dev suggested switching DNS.',
            },
            {
                title: 'IPL banter',
                detail: 'Group roasted the umpire call after the last over.',
            },
        ],
        wrap_up: 'Travel plans, tech gripes, and cricket jokes filled the day.',
    }),
    true,
    'concrete topics should pass',
);

assert.equal(
    isUsableGroupSummary({ topics: [{ title: 'Hi', detail: 'hey' }], wrap_up: '' }),
    false,
    'thin single topic should fail',
);

const svc = new OpenRouterLlmService({
    OPENROUTER_API_KEY: 'test',
    OPENROUTER_MODELS: 'meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-coder:free,google/gemma-4-31b-it:free',
    OPENROUTER_SUMMARY_MODELS: [],
    OPENROUTER_FALLBACK_MODELS: [],
    OPENROUTER_MODEL: '',
});

assert.ok(!svc.summaryModels.some((m) => /coder/i.test(m)), 'coder models must be skipped for summary');
assert.ok(svc.summaryModels.includes('meta-llama/llama-3.3-70b-instruct:free'));
assert.ok(svc.summaryModels.includes('google/gemma-4-31b-it:free'));

console.log('check-summary-fallback: ok');
