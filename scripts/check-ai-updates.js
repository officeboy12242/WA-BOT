/**
 * Self-check for /aiupdateson /aiupdatesoff (AI Updates: tools/apps,
 * India-specific AI news, model releases — one item per scheduled slot).
 *
 * Exercises the REAL AiUpdatesDatabase, AiUpdatesController, formatter, and
 * GroupManager opt-in triad with fakes only at the boundaries (Mongo
 * collections, the fetch service, WhatsApp send). Network is never touched —
 * AiUpdatesService's real RSS fetching is stubbed out here.
 *
 * Run: node scripts/check-ai-updates.js
 */
import assert from 'node:assert/strict';
import AiUpdatesDatabase from '../src/models/AiUpdatesDatabase.js';
import AiUpdatesController from '../src/controllers/AiUpdatesController.js';
import { formatAiUpdateMessage } from '../src/utils/aiUpdatesFormatter.js';
import { parsePostTimesFromConfig } from '../src/utils/aiUpdatesScheduler.js';
import GroupManager from '../src/models/GroupManager.js';
import { config } from '../src/config/config.js';

process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});

// ── in-memory Mongo shim (supports the small operator set these models use) ─
function matchesFilter(doc, filter) {
    return Object.entries(filter).every(([k, v]) => {
        if (v && typeof v === 'object' && !(v instanceof Date)) {
            if ('$ne' in v) return doc[k] !== v.$ne;
            if ('$lt' in v) return doc[k] instanceof Date ? doc[k] < v.$lt : doc[k] < v.$lt;
            return false;
        }
        return doc[k] === v;
    });
}

function makeDb(indexes = {}) {
    const collections = new Map();
    const get = (name) => {
        if (!collections.has(name)) {
            const docs = [];
            const uniques = indexes[name] || [];
            collections.set(name, {
                docs,
                async createIndex() {},
                find(filter = {}, opts = {}) {
                    const match = docs.filter((d) => matchesFilter(d, filter));
                    const toArray = async () => {
                        const out = match.map((d) => ({ ...d }));
                        if (opts.projection) {
                            for (const d of out) {
                                for (const k of Object.keys(opts.projection)) {
                                    if (opts.projection[k] === 0) delete d[k];
                                }
                            }
                        }
                        return out;
                    };
                    return { toArray, sort() { return { toArray }; } };
                },
                async findOne(filter = {}, opts = {}) {
                    const d = docs.find((x) => matchesFilter(x, filter));
                    if (!d) return null;
                    const out = { ...d };
                    if (opts.projection) {
                        for (const k of Object.keys(opts.projection)) {
                            if (opts.projection[k] === 0) delete out[k];
                        }
                    }
                    return out;
                },
                async updateOne(filter, update, opts = {}) {
                    for (const keys of uniques) {
                        const candidate = { ...filter, ...(update.$set || {}), ...(update.$setOnInsert || {}) };
                        const clashes = docs.some(
                            (d) => !matchesFilter(d, filter) && keys.every((k) => String(d[k]) === String(candidate[k]))
                        );
                        if (clashes) {
                            const err = new Error('E11000 duplicate key');
                            err.code = 11000;
                            throw err;
                        }
                    }
                    let doc = docs.find((d) => matchesFilter(d, filter));
                    let isNew = false;
                    if (!doc && opts.upsert) {
                        doc = { ...filter };
                        docs.push(doc);
                        isNew = true;
                    }
                    if (!doc) return { matchedCount: 0 };
                    // $setOnInsert only applies when the upsert actually creates the
                    // document — on an existing doc it must be a no-op, same as real
                    // Mongo. Applying it unconditionally would let e.g. setting one
                    // feature flag stomp `is_active` back to its $setOnInsert default.
                    Object.assign(doc, update.$set || {});
                    if (isNew) Object.assign(doc, update.$setOnInsert || {});
                    return { matchedCount: 1 };
                },
                async deleteMany(filter = {}) {
                    const before = docs.length;
                    for (let i = docs.length - 1; i >= 0; i--) {
                        if (matchesFilter(docs[i], filter)) docs.splice(i, 1);
                    }
                    return { deletedCount: before - docs.length };
                },
            });
        }
        return collections.get(name);
    };
    return { collection: (name) => get(name) };
}

// ── 1) config: AI_UPDATES_TIMES parses to 5 slots, no collision with GitHub/Awesome ──
{
    const slots = parsePostTimesFromConfig(config.AI_UPDATES_TIMES);
    assert.equal(slots.length, 5, 'AI_UPDATES_TIMES should give 5 daily slots');

    const githubSlots = new Set(config.GITHUB_TRENDING_TIMES);
    const awesomeSlots = new Set(config.AWESOME_LISTS_TIMES);
    for (const t of config.AI_UPDATES_TIMES) {
        assert.ok(!githubSlots.has(t), `AI updates slot ${t} collides with GitHub trending`);
        assert.ok(!awesomeSlots.has(t), `AI updates slot ${t} collides with Awesome lists`);
    }
}

// ── 2) formatter: headline + why-it-matters + link, no tags/decoration ──────
{
    const text = formatAiUpdateMessage(
        { title: 'OpenAI ships GPT-5.2', url: 'https://openai.com/index/gpt-5-2' },
        'Longer context, cheaper per token.'
    );
    assert.ok(text.includes('OpenAI ships GPT-5.2'), 'must include the headline');
    assert.ok(text.includes('Longer context, cheaper per token.'), 'must include why-it-matters line');
    assert.ok(text.includes('https://openai.com/index/gpt-5-2'), 'must include the source link');
    assert.ok(!/\[Tool\]|\[India\]|\[Model\]/.test(text), 'must not include category bracket tags');
    assert.ok(!/buzz|vibe|react 👍/i.test(text), 'must not include the rejected decoration');

    // no why-it-matters line → still valid, just skips that line
    const bare = formatAiUpdateMessage({ title: 'X', url: 'https://x.example/1' }, '');
    assert.ok(bare.includes('X') && bare.includes('https://x.example/1'));
}

// ── 3) AiUpdatesDatabase: dedup per group, partial fan-out stays fresh ──────
{
    const db = new AiUpdatesDatabase(makeDb({
        posted_ai_updates: [['hash', 'group_id']],
        ai_updates_slots: [['slot_key']],
    }));
    await db.init();

    const url = 'https://techcrunch.com/example-story';
    assert.equal(await db.isItemPosted(url, 'g1'), false);
    await db.markItemPosted(url, 'g1');
    assert.equal(await db.isItemPosted(url, 'g1'), true);
    assert.equal(await db.isItemPosted(url, 'g2'), false, 'dedup is per-group, not global');

    const items = [{ url }, { url: 'https://techcrunch.com/other-story' }];
    const fresh = await db.filterFreshForGroups(items, ['g1', 'g2']);
    assert.equal(fresh.length, 2, 'posted-to-g1-only item is still fresh for g2 (partial fan-out)');

    await db.markItemPosted(url, 'g2');
    const fresh2 = await db.filterFreshForGroups(items, ['g1', 'g2']);
    assert.equal(fresh2.length, 1, 'once posted to every target group it drops out');
    assert.equal(fresh2[0].url, 'https://techcrunch.com/other-story');

    assert.equal(await db.isSlotDone('2026-09-10T09:20'), false);
    await db.markSlotDone('2026-09-10T09:20', { posted: 1, reason: 'posted', item: 'X' });
    assert.equal(await db.isSlotDone('2026-09-10T09:20'), true);
}

// ── 4) AiUpdatesController: checkAndPostItem end-to-end with a fake service ─
{
    const mongoDb = makeDb({
        posted_ai_updates: [['hash', 'group_id']],
        ai_updates_slots: [['slot_key']],
        groups: [],
    });
    const aiUpdatesDatabase = new AiUpdatesDatabase(mongoDb);
    await aiUpdatesDatabase.init();

    const groupManager = new GroupManager(mongoDb);
    await groupManager.init();
    await groupManager.activateGroup('123@g.us', 'Test Group', '910000000000');
    await groupManager.setAiUpdatesEnabled('123@g.us', 'Test Group', true, '910000000000');

    const cfg = { ...config, AI_UPDATES_ENABLED: true };
    const controller = new AiUpdatesController(cfg, groupManager, aiUpdatesDatabase);

    const fakeItem = {
        title: 'DeepMind open-sources a small multimodal model',
        summary: 'Runs on one consumer GPU.',
        // .invalid is reserved by RFC 2606 to never resolve — keeps this check
        // hermetic (buildLinkPreview() fails DNS instantly instead of a real
        // network round-trip to a live domain).
        url: 'https://example.invalid/ai-updates-check-story',
        source: 'Google DeepMind',
        category: 'model',
        publishedAt: new Date(),
    };
    // Stub the network-touching bits — this check must never hit real feeds.
    controller.service.fetchForSlot = async () => [fakeItem];
    controller.service.fetchMixedPool = async () => [fakeItem];
    controller.service.generateWhyItMatters = async () => 'One to try before the next hackathon.';

    const sent = [];
    const fakeSock = {
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content?.text || '' });
            return { key: { id: `m${sent.length}` } };
        },
    };

    const result = await controller.checkAndPostItem(fakeSock, { }, 2);
    assert.equal(result.ok, true, 'should post successfully');
    assert.equal(result.posted, 1);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(fakeItem.title));
    assert.ok(sent[0].text.includes('One to try before the next hackathon.'));
    assert.ok(sent[0].text.includes(fakeItem.url));

    // Re-running the same slot for the same item must not re-post (per-group dedup).
    const again = await controller.checkAndPostItem(fakeSock, {}, 2);
    assert.equal(again.posted, 0, 'duplicate item for the same group must not repost');
    assert.equal(sent.length, 1, 'no second message sent');

    // Disabled feature short-circuits before touching groups/service at all.
    const disabledCtrl = new AiUpdatesController({ ...cfg, AI_UPDATES_ENABLED: false }, groupManager, aiUpdatesDatabase);
    const disabledResult = await disabledCtrl.checkAndPostItem(fakeSock, {}, 0);
    assert.equal(disabledResult.reason, 'disabled');

    // No opted-in groups → no_groups, not a crash.
    const emptyGm = new GroupManager(mongoDb.constructor ? makeDb() : mongoDb);
    await emptyGm.init();
    const noGroupsCtrl = new AiUpdatesController(cfg, emptyGm, aiUpdatesDatabase);
    noGroupsCtrl.service.fetchForSlot = async () => [fakeItem];
    const noGroupsResult = await noGroupsCtrl.checkAndPostItem(fakeSock, {}, 0);
    assert.equal(noGroupsResult.reason, 'no_groups');
}

// ── 5) GroupManager opt-in triad: default OFF, like Interview Q (not GitHub) ─
{
    const groupManager = new GroupManager(makeDb());
    await groupManager.init();
    await groupManager.activateGroup('456@g.us', 'Another Group', '910000000001');

    // activateGroup must NOT auto-enable AI updates (opt-in, unlike GitHub/Awesome).
    assert.equal(await groupManager.isAiUpdatesEnabled('456@g.us'), false);
    assert.equal((await groupManager.getAiUpdatesGroups()).length, 0);

    await groupManager.setAiUpdatesEnabled('456@g.us', 'Another Group', true, '910000000001');
    assert.equal(await groupManager.isAiUpdatesEnabled('456@g.us'), true);
    const enabled = await groupManager.getAiUpdatesGroups();
    assert.equal(enabled.length, 1);
    assert.equal(enabled[0].group_id, '456@g.us');

    await groupManager.setAiUpdatesEnabled('456@g.us', 'Another Group', false, '910000000001');
    assert.equal(await groupManager.isAiUpdatesEnabled('456@g.us'), false);
}

console.log('✅ AI updates: config slots, formatter shape, DB dedup, controller flow, opt-in triad — all ok');
process.exit(0);
