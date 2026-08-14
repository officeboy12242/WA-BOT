/**
 * Unit checks for the recap INPUT pipeline — the layer that decides what the
 * summary LLM actually sees and how much it is allowed to write.
 *
 * Guards the two regressions that made recaps come out "half and not to the
 * points":
 *   1. Sampling too thin — a 150-message day used to hand the model ~60 lines,
 *      and the call layer then sliced the prompt at 5000 chars, so the model
 *      saw less than half the day's conversation.
 *   2. Token starvation — the requested JSON (about + vibe + 3-5 topics +
 *      notable + wrap_up + verdict) is cut off around ~700 tokens, so the
 *      model emitted half a JSON object and the controller fell back to
 *      heuristic "Members talked about..." filler topics.
 *
 * Run: node scripts/check-summary-input.js
 */
import GroupChatLogService from '../src/services/GroupChatLogService.js';
import NvidiaDeepSeekService from '../src/services/NvidiaDeepSeekService.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };

// ------------------------------------------------------- sampling coverage
const log = new GroupChatLogService(null, null, {});

ok(log.getLlmSampleLimit(60) === 60, 'small day: every message reaches the LLM');
ok(log.getLlmSampleLimit(150) === 120, '150-msg day samples 120 (was 60)');
ok(log.getLlmSampleLimit(200) === 90, '200-msg day samples 90 (was 50)');
ok(log.getLlmSampleLimit(300) === 70, 'very busy day caps at 70');

const makeRows = (n) =>
    Array.from({ length: n }, (_, i) => ({
        ts: new Date(Date.UTC(2026, 7, 12, i % 12, (i * 7) % 60)),
        sender_name: `User${(i % 5) + 1}`,
        text: `message number ${i + 1} about the daily discussion`,
    }));

const smallPrompt = log.buildPrompt(makeRows(60), 'Test Group', 'Wed, 12 Aug');
const smallLines = smallPrompt.split('\n').filter((l) => /^\[\d/.test(l)).length;
ok(smallLines === 60, `60-msg day: all 60 lines in the prompt (got ${smallLines})`);
ok(!smallPrompt.includes('sampled for recap'), 'small day carries no sampling note');

const midPrompt = log.buildPrompt(makeRows(150), 'Test Group', 'Wed, 12 Aug');
const midLines = midPrompt.split('\n').filter((l) => /^\[\d/.test(l)).length;
ok(midLines >= 100, `150-msg day: at least 100 lines reach the LLM (got ${midLines})`);
ok(midPrompt.length <= 14_000, `150-msg prompt fits the first-attempt cap (${midPrompt.length} chars)`);

const bigPrompt = log.buildPrompt(makeRows(200), 'Test Group', 'Wed, 12 Aug');
const bigLines = bigPrompt.split('\n').filter((l) => /^\[\d/.test(l)).length;
ok(bigLines >= 70, `200-msg day: at least 70 lines reach the LLM (got ${bigLines})`);
ok(bigPrompt.length <= 14_000, `200-msg prompt fits the first-attempt cap (${bigPrompt.length} chars)`);

ok(log.shouldUseChunkedSummary(makeRows(150)) === false, '150-msg day uses the single-shot path');
ok(log.shouldUseChunkedSummary(makeRows(220)) === true, '220-msg day maps to chunked summary');

// ------------------------------------------------------- LLM call behavior
const nv = new NvidiaDeepSeekService({});

// 1. First attempt must NOT slice the prompt below 14k, and must ask for 1400 tokens.
{
    const big = 'x'.repeat(12_000);
    let captured = null;
    nv.complete = async (_sys, prompt, opts) => { captured = { prompt, opts }; return '{"topics":[{"title":"a","detail":"b"}]}'; };
    await nv.completeWithSummaryRetry('sys', big, {});
    ok(captured.prompt.length === 12_000, `first attempt keeps the full prompt (${captured.prompt.length} chars)`);
    ok(captured.opts.maxTokens === 1400, `first attempt allows 1400 tokens (was 700), got ${captured.opts.maxTokens}`);
}

// 2. On a real timeout the retry ladder shrinks the prompt, but only then.
{
    const calls = [];
    nv.complete = async (_sys, prompt, opts) => {
        calls.push({ prompt, opts });
        if (calls.length < 3) throw new Error('timeout while summarizing');
        return '{"topics":[{"title":"a","detail":"b"}]}';
    };
    await nv.completeWithSummaryRetry('sys', 'y'.repeat(12_000), {});
    ok(calls.length === 3, `timeout shrinks across the retry ladder (${calls.length} attempts)`);
    ok(calls[0].prompt.length === 12_000, 'retry ladder still starts with the full prompt');
    ok(calls[1].prompt.length <= 9100, `timeout retry 1 shrinks to <=9k (${calls[1].prompt.length})`);
    ok(calls[2].prompt.length <= 5100, `timeout retry 2 shrinks to <=5k (${calls[2].prompt.length})`);
    ok(calls[0].opts.maxTokens === 1400 && calls[2].opts.maxTokens === 1000, 'retries keep sane token budgets');
}

// 3. summarizeGroupChat explicitly asks for 1400 tokens (the JSON is ~1200+).
{
    let capturedOpts = null;
    nv.complete = async (_sys, _prompt, opts) => { capturedOpts = opts; return '{"topics":[{"title":"a","detail":"b"}]}'; };
    await nv.summarizeGroupChat('small prompt');
    ok(capturedOpts.maxTokens === 1400, `summarizeGroupChat requests 1400 tokens (got ${capturedOpts?.maxTokens})`);
}

console.log(`\ncheck-summary-input: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
