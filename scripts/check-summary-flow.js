/**
 * Integration smoke test for the group recap pipeline.
 *
 * Exercises the REAL postSummaryForGroup -> _summarizeDay path with a stubbed
 * chat log, LLM, and socket. Guards the two regression classes that silently
 * degraded recaps before:
 *   1. _summarizeDay is called with the recap style and must not throw
 *      (a missing parameter previously forced every recap to heuristic filler).
 *   2. Self-heal receives a well-formed context object on LLM failure, so it
 *      can actually diagnose the problem.
 *
 * Run: node scripts/check-summary-flow.js
 */
import assert from 'node:assert';
import GroupSummaryController from '../src/controllers/GroupSummaryController.js';

const days = [
    { ts: new Date('2026-08-12T10:15:00+05:30'), sender_name: 'Amit', text: 'Nifty broke 24000 today' },
    { ts: new Date('2026-08-12T10:20:00+05:30'), sender_name: 'Priya', text: 'Banknifty 52000 PE looks strong' },
    { ts: new Date('2026-08-12T14:05:00+05:30'), sender_name: 'Rahul', text: 'Any expiry plans for tomorrow?' },
    { ts: new Date('2026-08-12T14:10:00+05:30'), sender_name: 'Amit', text: 'Selling 52000 PE spreads worked well' },
    { ts: new Date('2026-08-12T19:40:00+05:30'), sender_name: 'Sneha', text: 'Good day, see you all tomorrow' },
];

const goodSummary = {
    about: 'a group for F&O traders discussing Nifty and Banknifty',
    vibe: 'bullish and chatty',
    topics: [
        { title: 'Nifty 24000 breakout', detail: 'Members debated whether the 24000 CE wall would hold through expiry and what it means for tomorrow.' },
        { title: 'Banknifty PE spreads', detail: 'Amit and Priya discussed selling 52000 PE spreads and the day trade worked out as planned.' },
        { title: 'Expiry plans', detail: 'Rahul asked about tomorrow plans and the group settled on watching the opening range.' },
    ],
    notable: ['Amit shared the 52000 PE spread trade that paid off'],
    wrap_up: 'A solid trading day with real conviction behind the 24000 Nifty thesis and a winning PE spread trade.',
    verdict: 'The group read the market well today; the opening range tomorrow will decide the follow-through.',
};

function makeSock() {
    const sent = [];
    return {
        sent,
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content?.text || '' });
            return { key: { remoteJid: jid } };
        },
    };
}

function makeController({ llmThrows = false, selfHealSpy = null } = {}) {
    const ctrl = new GroupSummaryController({}, {}, {}, null);
    ctrl.chatLog = {
        getMessagesForDay: async () => days,
        shouldUseChunkedSummary: () => false,
        buildPrompt: () => 'BASE PROMPT',
        computeStats: (msgs) => ({
            totalMessages: msgs.length,
            uniqueMembers: 4,
            busiestHourLabel: '2 PM – 3 PM',
            topSender: { name: 'Amit', count: 2 },
        }),
        buildHeuristicSummary: () => ({ topics: [], notable: [], wrap_up: 'heuristic fallback' }),
        purgeDay: async () => {},
    };
    ctrl.groupManager = { getSummaryEnabledGroups: async () => [] };
    ctrl.nvidia = {
        isConfigured: () => true,
        summarizeGroupChat: async () => {
            if (llmThrows) throw new Error('NVIDIA API 503 — service unavailable');
            return goodSummary;
        },
        parseSummaryJson: (raw) => raw,
        mergePartialsLocally: (partials) => partials[0],
        summarizeGroupChatChunks: async (chunks) => goodSummary,
    };
    ctrl.openrouter = { isConfigured: () => false, models: [] };
    if (selfHealSpy) {
        ctrl.selfHeal = selfHealSpy;
    }
    return ctrl;
}

/* ── happy path: full recap posted with real LLM content ──────────────────── */

const group = { group_id: 'g@g.us', group_name: 'Test Group' };
const sock = makeSock();
const ctrl = makeController();
const ok = await ctrl.postSummaryForGroup(sock, group, '2026-08-12', 'Wednesday, 12 Aug', '23:30', { force: true });

assert.strictEqual(ok, true, 'recap should succeed');
assert.strictEqual(sock.sent.length, 1, 'exactly one recap message is posted');
const text = sock.sent[0].text;
assert.ok(text.includes('Nifty 24000 breakout'), 'real topic title appears in the recap');
assert.ok(text.includes('Banknifty PE spreads'), 'second topic appears');
assert.ok(text.includes('bullish and chatty'), 'the vibe line is present');
assert.ok(text.includes('The group read the market well today'), 'the verdict is present');
assert.ok(!/Members talked about/i.test(text), 'no heuristic filler when the LLM worked');

/* ── failure path: self-heal gets a well-formed context object ─────────────── */

let healCtx = null;
const spy = {
    setSock: () => {},
    triggerFromSummaryFailure: (ctx) => { healCtx = ctx; },
};
const sock2 = makeSock();
const ctrl2 = makeController({ llmThrows: true, selfHealSpy: spy });
await ctrl2.postSummaryForGroup(sock2, group, '2026-08-12', 'Wednesday, 12 Aug', '23:30', { force: true });

assert.ok(healCtx && typeof healCtx === 'object', 'self-heal receives an object, not a bare string');
assert.strictEqual(healCtx.groupName, 'Test Group', 'self-heal knows which group failed');
assert.ok(/503/.test(healCtx.errorMessage || ''), 'self-heal gets the real error message');
assert.ok(Number.isFinite(healCtx.messageCount) && healCtx.messageCount > 0, 'self-heal gets the message count');
assert.strictEqual(typeof healCtx.useChunks, 'boolean', 'self-heal knows whether chunks were used');
assert.strictEqual(sock2.sent.length, 1, 'a failed LLM recap still posts a fallback recap');

console.log('summary flow check ok');
