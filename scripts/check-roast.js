/**
 * Self-check for /roast (AI resume roast).
 *
 * Exercises the REAL RoastService + handler code with fakes only at the
 * boundaries (Mongo collection, LLM router, WhatsApp send).
 *
 * Run: node scripts/check-roast.js
 */
import assert from 'node:assert/strict';
process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});
import RoastService, { parseRoastOutput } from '../src/services/RoastService.js';
import { handleRoast } from '../src/controllers/handlers/roastBirthdayHandlers.js';
import { getTodayDateStrIST } from '../src/utils/dateIST.js';

// ── in-memory Mongo shim ────────────────────────────────────────────────────
function makeDb() {
    const collections = new Map();
    const get = (name) => {
        if (!collections.has(name)) {
            const docs = [];
            collections.set(name, {
                docs,
                async createIndex() {},
                async countDocuments(filter = {}) {
                    return docs.filter((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v)
                    ).length;
                },
                async insertOne(doc) {
                    docs.push({ ...doc, _id: `id-${docs.length + 1}` });
                    return { insertedId: docs.length };
                },
                async findOne(filter = {}) {
                    return (
                        docs.find((d) =>
                            Object.entries(filter).every(([k, v]) => d[k] === v)
                        ) || null
                    );
                },
            });
        }
        return collections.get(name);
    };
    return { collection: (name) => get(name) };
}

// ── fakes ───────────────────────────────────────────────────────────────────
const FAKE_ROAST = [
    '🔥 *ROAST SCORE: 42/100* — this resume needs a fire extinguisher.',
    '',
    '*What works*',
    '- It exists.',
    '',
    '*Getting roasted*',
    '- "Worked on project X" — did you? Or did X work on you?',
    '',
    '*Fix list (do these)*',
    '1. Quantify everything.',
    '2. Kill "hardworking".',
    '',
    '_Verdict:_ brutal, but fixable — go get that 42 to 80.',
].join('\n');

const llm = {
    isConfigured: () => true,
    calls: 0,
    async completeChat() {
        this.calls += 1;
        return { text: FAKE_ROAST, provider: 'fake', model: 'roast-1' };
    },
};

const service = new RoastService({ mongoDb: makeDb(), cfg: { ROAST_ENABLED: true, ROAST_DAILY_LIMIT: 2 } });
service.llm = llm;
await service.init();

const JID = '919999000001@s.whatsapp.net';

// ── 1) parseRoastOutput ─────────────────────────────────────────────────────
{
    const { score } = parseRoastOutput(FAKE_ROAST);
    assert.equal(score, 42);
    assert.equal(parseRoastOutput('no score here').score, null);
    assert.equal(parseRoastOutput('ROAST SCORE: 999/100').score, 100); // clamped
    console.log('✅ parseRoastOutput extracts + clamps score');
}

// ── 2) roastText happy path + logging ───────────────────────────────────────
{
    const out = await service.roastText({ resumeText: 'A. B. C. skills etc.', senderJid: JID, displayName: 'Test' });
    assert.match(out.text, /ROAST SCORE: 42\/100/);
    assert.equal(out.provider, 'fake');
    const usage = await service.usageToday('919999000001');
    assert.equal(usage.used, 1);
    assert.equal(usage.limit, 2);
    console.log('✅ roastText returns LLM card and logs usage');
}

// ── 3) daily limit enforced ─────────────────────────────────────────────────
{
    await service.roastText({ resumeText: 'second roast today', senderJid: JID });
    await assert.rejects(
        () => service.roastText({ resumeText: 'third roast today', senderJid: JID }),
        /Daily roast limit reached \(2\/2\)/
    );
    assert.equal(llm.calls, 2, 'LLM must not be called once the limit is hit');
    console.log('✅ daily limit enforced without burning LLM calls');

    // owner bypass: limit already exhausted, bypassLimit still roasts
    const out = await service.roastText({ resumeText: 'owner roast', senderJid: JID, bypassLimit: true });
    assert.match(out.text, /ROAST SCORE: 42\/100/);
    assert.equal(llm.calls, 3, 'bypass must reach the LLM despite a full quota');
    console.log('✅ owner bypass roasts unlimited (limit already exhausted)');
}

// ── 4) failed LLM attempts do not consume quota ─────────────────────────────
{
    const svc2 = new RoastService({ mongoDb: makeDb(), cfg: { ROAST_ENABLED: true, ROAST_DAILY_LIMIT: 1 } });
    svc2.llm = {
        isConfigured: () => true,
        async completeChat() {
            throw new Error('all providers rate-limited');
        },
    };
    await svc2.init();
    await assert.rejects(() => svc2.roastText({ resumeText: 'boom', senderJid: JID }), /rate-limited/);
    const usage = await svc2.usageToday('919999000001');
    assert.equal(usage.used, 0, 'failures must not count toward the limit');
    console.log('✅ failed roasts do not consume the daily quota');
}

// ── 5) handler: no document → usage text, no LLM call ───────────────────────
{
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: 'k1' } }; } };
    const before = llm.calls;
    await handleRoast({
        sock,
        chatId: '919999000001@s.whatsapp.net',
        senderJid: JID,
        originalMsg: { key: { id: 'm1' }, message: { conversation: '/roast' } },
        pushName: 'Tester',
        ctx: { roastService: service },
    });
    assert.equal(llm.calls, before, 'no LLM call without a document');
    assert.match(sent[0]?.text || '', /AI Resume Roast/);
    console.log('✅ /roast without a document replies with usage, no LLM call');
}

// ── 6) disabled service → offline message ───────────────────────────────────
{
    const svcOff = new RoastService({ mongoDb: makeDb(), cfg: { ROAST_ENABLED: false } });
    assert.equal(svcOff.isConfigured(), false);
    console.log('✅ ROAST_ENABLED=false switches the feature off');
}

console.log(`✅ check-roast passed (day key ${getTodayDateStrIST()})`);
process.exit(0);
