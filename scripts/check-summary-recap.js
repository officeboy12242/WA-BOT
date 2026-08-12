/**
 * Checks for the assist LLM router (rate-limit routing) and the group recap card.
 * Pure functions only — no network, no DB.
 * Run: node scripts/check-summary-recap.js
 */
import AssistLlmRouter, { isQuotaExhaustedError, isAssistLlmFallbackError } from '../src/services/AssistLlmRouter.js';
import { SUMMARY_SYSTEM_PROMPT } from '../src/services/NvidiaDeepSeekService.js';
import { config } from '../src/config/config.js';
import { formatRecapMessage } from '../src/controllers/GroupSummaryController.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };

const errOf = (status, message) => ({ response: { status, data: { error: { message } } }, message });

// ------------------------------------------------- quota vs transient rate limit
// A daily quota does not recover in 1.5s. Treating it as transient made every
// call re-walk 4 dead Gemini models first — one generation took 163s.
ok(isQuotaExhaustedError(errOf(429, 'You exceeded your current quota, please check your plan and billing details')),
    'daily quota is detected as exhausted');
ok(isQuotaExhaustedError(errOf(429, 'RESOURCE_EXHAUSTED')), 'RESOURCE_EXHAUSTED detected');
ok(isQuotaExhaustedError(errOf(429, 'insufficient_quota')), 'insufficient_quota detected');
ok(!isQuotaExhaustedError(errOf(429, 'Too many requests, retry shortly — per minute cap')),
    'a BURST 429 is not treated as exhausted (it recovers on retry)');
ok(!isQuotaExhaustedError(errOf(404, 'model not found')), '404 dead model is not a quota error');
ok(!isQuotaExhaustedError({ message: 'timeout of 45000ms exceeded' }), 'timeout is not a quota error');
ok(!isQuotaExhaustedError(null), 'null error safe');
// both classes must still be fallback-worthy, so the router moves on either way
ok(isAssistLlmFallbackError(errOf(429, 'exceeded your current quota')), 'quota is still a fallback error');
ok(isAssistLlmFallbackError(errOf(404, 'not found')) === false || true, 'fallback detector runs on 404 without throwing');

// ------------------------------------------------------------ provider cooling
const router = new AssistLlmRouter(config);
ok(router.cooldownMs >= 60_000, 'cooldown is at least a minute');
ok(router.cooldownMs <= 60 * 60_000, 'cooldown is capped at an hour');
const before = router._orderedProviders();
ok(before.length > 0, 'router has available providers');
ok(!router.isCooled(before[0]), 'nothing is cooled initially');
router._coolProvider(before[0], 'test');
ok(router.isCooled(before[0]), 'provider reports cooled after cooling');
const after = router._orderedProviders();
ok(after.length === before.length, 'a cooled provider is NOT dropped — still better than total failure');
if (after.length > 1) {
    ok(after[after.length - 1] === before[0], 'the cooled provider is moved to LAST, not removed');
    ok(after[0] !== before[0], 'a live provider is now tried first');
}
// nvidia default must not be the dead deepseek model that broke this
ok(!router.nvidiaModels.includes('deepseek-ai/deepseek-v4-flash'),
    'nvidia chain no longer defaults to the 404 deepseek-v4-flash');
ok(router.nvidiaModels.length > 0, 'nvidia chain is non-empty');

// --------------------------------------------------------- retired model names
// gemini-2.0-flash returns 404 "no longer available"; it must be gone from every
// configured chain or it burns an attempt on each call.
for (const [name, chain] of [
    ['GEMINI_TRADE_MODELS', config.GEMINI_TRADE_MODELS],
    ['ASSIST_GEMINI_MODELS', config.ASSIST_GEMINI_MODELS],
    ['GEMINI_HEAL_MODELS', config.GEMINI_HEAL_MODELS],
]) {
    ok(!String(chain).split(',').map((s) => s.trim()).includes('gemini-2.0-flash'),
        `${name} no longer lists the retired gemini-2.0-flash`);
}
ok(!String(config.NVIDIA_MODEL).includes('deepseek-v4-flash'), 'NVIDIA_MODEL is not the dead deepseek model');
ok(!String(config.NVIDIA_TRADE_MODEL).includes('glm-5.2'), 'NVIDIA_TRADE_MODEL is not the unresponsive glm-5.2');
ok(!String(config.OPENROUTER_MODEL).includes('llama-3.3-70b-instruct:free'),
    'OPENROUTER_MODEL is not the withdrawn free llama slug');

// ------------------------------------------------------------- recap prompt
ok(/about/.test(SUMMARY_SYSTEM_PROMPT), 'recap prompt asks what the group is about');
ok(/verdict/.test(SUMMARY_SYSTEM_PROMPT), 'recap prompt asks for a verdict');
ok(/vibe/.test(SUMMARY_SYSTEM_PROMPT), 'recap prompt asks for a vibe tag');
ok(/Do not guess from the group name/i.test(SUMMARY_SYSTEM_PROMPT),
    'prompt tells it to infer purpose from the chat, not the group name');
ok(/never invent events/i.test(SUMMARY_SYSTEM_PROMPT), 'prompt forbids inventing events');
ok(/never mention bots, AI/i.test(SUMMARY_SYSTEM_PROMPT), 'prompt still forbids mentioning AI');

// ---------------------------------------------------------------- recap card
const fullSummary = {
    about: 'A dev crowd that trades links and argues about tooling',
    vibe: 'caffeinated and slightly unhinged',
    topics: [
        { title: 'Rust vs Go, again', detail: 'Rahul reopened it; Aditi pointed at compile times and it ran 20 messages deep.' },
        { title: 'That Postgres outage', detail: 'Sameer shared the postmortem; the group landed on connection pooling.' },
    ],
    notable: ['Aditi shipped her CLI tool and got 14 stars overnight'],
    wrap_up: 'Busy evening, mostly tooling talk with a real outage debrief in the middle.',
    verdict: 'Nobody needed to relitigate Rust versus Go at 9pm, and yet. Credit to Sameer for dragging it back to something real.',
};
const stats = { totalMessages: 87, uniqueMembers: 9, busiestHourLabel: '9 PM – 10 PM', topSender: { name: 'Rahul', count: 24 } };
const card = formatRecapMessage({ groupName: 'Tech Group', dateLabel: 'Tue, 12 Aug 2026', timeLabel: '12:00 AM', stats, summary: fullSummary });

ok(card.includes('A dev crowd that trades links'), 'card renders the inferred "about" line');
ok(card.includes("Today's vibe"), 'card renders the vibe tag');
ok(card.includes('caffeinated and slightly unhinged'), 'vibe text present');
ok(card.includes('My two cents'), 'card renders the verdict section');
ok(card.includes('relitigate Rust versus Go'), 'verdict text present');
ok(card.indexOf('My two cents') > card.indexOf('In short'), 'verdict comes AFTER the wrap-up — it is the closing word');
ok(card.indexOf('A dev crowd') < card.indexOf('Day at a glance'), 'about sits at the top, before the stats');
ok(card.includes('Rust vs Go'), 'topics still render');
ok(card.includes('Most active'), 'existing stats still render');

// every new field is optional — an older/partial summary must not break the card
const bare = formatRecapMessage({
    groupName: 'Tech Group', dateLabel: 'Tue, 12 Aug 2026', timeLabel: '12:00 AM', stats,
    summary: { topics: fullSummary.topics, wrap_up: 'Quiet one.' },
});
ok(!bare.includes("Today's vibe"), 'no vibe field -> no vibe line');
ok(!bare.includes('My two cents'), 'no verdict field -> no verdict section');
ok(bare.includes('Rust vs Go'), 'bare summary still renders topics');
ok(bare.includes('In short'), 'bare summary still renders the wrap-up');

// blank strings must be treated as absent, not printed as empty headings
const blank = formatRecapMessage({
    groupName: 'Tech Group', dateLabel: 'Tue, 12 Aug 2026', timeLabel: '12:00 AM', stats,
    summary: { about: '   ', vibe: '', verdict: '  ', topics: fullSummary.topics },
});
ok(!blank.includes("Today's vibe"), 'whitespace-only vibe is skipped');
ok(!blank.includes('My two cents'), 'whitespace-only verdict is skipped');

ok(formatRecapMessage({ groupName: 'G', dateLabel: 'D', timeLabel: 'T', stats, summary: null }).length > 0,
    'null summary does not throw');

console.log(`\ncheck-summary-recap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
