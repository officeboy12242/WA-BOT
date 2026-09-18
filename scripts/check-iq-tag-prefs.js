/**
 * Self-check: /tagme–/notag prefs must gate every visible @mention.
 *
 * 1. Storage: setTagged/isTaggedIn/getTaggedMembers per (group, phone).
 * 2. Pre-poll ping: tags ONLY /tagme opt-ins; no opt-ins means no mentions.
 * 3. Leaderboard tag pack: /notag wins — no tag without an explicit opt-in,
 *    including players who scored high but never ran /tagme.
 * 4. Handler: /tagme + /notag flip the stored pref, and a Mongo failure tells
 *    the user instead of dying silently.
 *
 * Run: node scripts/check-iq-tag-prefs.js
 */
import assert from 'node:assert/strict';
import InterviewQuestionStore from '../src/interviewQuestion/interviewQuestion.storage.js';
import InterviewQuestionService from '../src/interviewQuestion/interviewQuestion.service.js';
import { handleTagMe, handleCheckTagStatus } from '../src/interviewQuestion/interviewQuestion.commands.js';

process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});

// ── in-memory Mongo shim (updateOne + upsert, find + sort + toArray) ────────
function makeDb() {
    const collections = new Map();
    const get = (name) => {
        if (!collections.has(name)) {
            const docs = [];
            collections.set(name, {
                docs,
                async createIndex() {},
                find(filter = {}) {
                    const match = docs.filter((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v)
                    );
                    return {
                        sort(spec = {}) {
                            const keys = Object.entries(spec);
                            const sorted = [...match].sort((a, b) => {
                                for (const [k, dir] of keys) {
                                    const av = a[k]?.getTime?.() ?? a[k];
                                    const bv = b[k]?.getTime?.() ?? b[k];
                                    if (av === bv) continue;
                                    return (av > bv ? 1 : -1) * (dir >= 0 ? 1 : -1);
                                }
                                return 0;
                            });
                            return { toArray: async () => sorted.map((d) => ({ ...d })) };
                        },
                        toArray: async () => match.map((d) => ({ ...d })),
                    };
                },
                async findOne(filter = {}) {
                    return (
                        docs.find((d) =>
                            Object.entries(filter).every(([k, v]) => d[k] === v)
                        ) || null
                    );
                },
                async updateOne(filter, update, opts = {}) {
                    let doc = docs.find((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v)
                    );
                    if (!doc && opts.upsert) {
                        doc = { ...filter };
                        docs.push(doc);
                    }
                    if (!doc) return { matchedCount: 0 };
                    Object.assign(doc, update.$set || {}, update.$setOnInsert || {});
                    return { matchedCount: 1 };
                },
            });
        }
        return collections.get(name);
    };
    return { collection: (name) => get(name) };
}

const GA = '120363021111111111@g.us';
const GB = '120363022222222222@g.us';
const P1 = '919999000001';
const P2 = '919999000002';
const P3 = '919999000003';
const J1 = '100000000000001@lid';
const J2 = '100000000000002@lid';
const J3 = '100000000000003@lid';

const store = new InterviewQuestionStore(makeDb());
await store.init();

// ── 1) storage: opt-in / opt-out per (group, phone) ─────────────────────────
await store.setTagged(GA, P1, false, { jid: J1, name: 'Riya' });
assert.equal(await store.isTaggedIn(GA, P1), false, 'notag must store tagged=false');
assert.ok(!(await store.getTaggedMembers(GA)).some((r) => r.phone === P1), 'notag member must not be listed as tagged');

await store.setTagged(GA, P2, true, { jid: J2, name: 'Amit' });
assert.equal(await store.isTaggedIn(GA, P2), true, 'tagme must store tagged=true');
{
    const prefOn = await store.getTagPref(GA, P2);
    assert.equal(prefOn?.tagged, true);
    assert.equal(prefOn?.name, 'Amit');
    const prefOff = await store.getTagPref(GA, P1);
    assert.equal(prefOff?.tagged, false);
    assert.equal(await store.getTagPref(GA, '919999000099'), null, 'never-set returns null');
}
console.log('✅ storage: getTagPref returns ON / OFF / null');

// per-group isolation: opted-in in GB says nothing about GA
await store.setTagged(GB, P1, true, { jid: J1, name: 'Riya' });
assert.equal(await store.isTaggedIn(GA, P1), false, 'GB opt-in must not leak into GA');

// opt-out after opt-in removes them
await store.setTagged(GB, P1, false, { jid: J1, name: 'Riya' });
assert.equal(await store.isTaggedIn(GB, P1), false, 'notag after tagme must clear the pref');
console.log('✅ storage: /tagme + /notag are per (group, phone) and mutually exclusive');

// ── shared fakes ─────────────────────────────────────────────────────────────
const groupManager = {};
const service = new InterviewQuestionService({ store, groupManager, cfg: {} });

const makeSock = () => {
    const sent = [];
    return {
        sent,
        async groupMetadata(gid) {
            return {
                participants: [
                    { id: J1, phoneNumber: `+${P1}` },
                    { id: J2, phoneNumber: `+${P2}` },
                    { id: J3, phoneNumber: `+${P3}` },
                ],
            };
        },
        async sendMessage(jid, content) {
            sent.push({ jid, text: content?.text || '', mentions: content?.mentions || [] });
            return { key: { id: `m${sent.length}` } };
        },
    };
};

const q = { type: 'DSA', difficulty: 'Hard', topic: 'Arrays' };

// ── 2) pre-poll ping: tags only opt-ins ─────────────────────────────────────
{
    const sock = makeSock();
    await service.sendInterviewPing(sock, GA, q, 30 * 60_000);
    assert.equal(sock.sent.length, 1);
    const msg = sock.sent[0];
    assert.ok(
        msg.mentions.includes(J2) && !msg.mentions.includes(J1) && !msg.mentions.includes(J3),
        'ping must mention only the /tagme opt-in (Amit)'
    );
    assert.ok(msg.text.includes('@100000000000002'), 'opt-in gets a visible @token');
    assert.ok(!msg.text.includes('@100000000000001'), 'notag member must not be @-tokenised');
    assert.ok(!msg.text.includes('@100000000000003'), 'never-opted-in member must not be tagged');
    console.log('✅ ping: only /tagme opt-ins are tagged, /notag respected');
}

// No opt-ins means the context message is sent without notifying anyone.
{
    const sock = makeSock();
    await service.sendInterviewPing(sock, GB, q, 30 * 60_000);
    const msg = sock.sent[0];
    assert.deepEqual(msg.mentions, [], '/notag and never-opted-in members must not be mentioned');
    assert.ok(!/@\d{6,}/.test(msg.text), 'no visible @tokens');
    console.log('✅ ping: no opt-ins means no mentions');
}

// A group with no saved prefs also receives no mentions.
{
    const GC = '120363033333333333@g.us';
    const sock = makeSock();
    await service.sendInterviewPing(sock, GC, q, 30 * 60_000);
    const msg = sock.sent[0];
    assert.deepEqual(msg.mentions, [], 'no prefs at all → no mentions');
    console.log('✅ ping: never-opted-in members are not tagged');
}

// ── 3) leaderboard tag pack: /notag wins ────────────────────────────────────
{
    const rows = [
        { name: 'Riya', phone: P1, attempted: 5, correct: 4 }, // ran /notag in GA
        { name: 'Amit', phone: P2, attempted: 3, correct: 3 }, // ran /tagme in GA
        { name: 'Zed', phone: P3, attempted: 9, correct: 9 },  // top scorer, never opted in
    ];

    const pack = await service.buildLeaderboardTagPack(GA, rows, { limit: 10, sock: makeSock() });
    assert.deepEqual(pack.mentions, [J2], 'only the explicit opt-in may be tagged, despite Zed ranking #1');

    // after Riya runs /tagme in GA both opt-ins appear; Zed still never tagged
    await store.setTagged(GA, P1, true, { jid: J1, name: 'Riya' });
    const pack2 = await service.buildLeaderboardTagPack(GA, rows, { limit: 10, sock: makeSock() });
    assert.deepEqual([...pack2.mentions].sort(), [J1, J2].sort(), 'new /tagme opt-in starts getting tagged');

    // /notag again → removed from the very next board
    await store.setTagged(GA, P1, false, { jid: J1, name: 'Riya' });
    const pack3 = await service.buildLeaderboardTagPack(GA, rows, { limit: 10, sock: makeSock() });
    assert.deepEqual(pack3.mentions, [J2], '/notag removes the tag immediately');

    // non-group chat → never any mentions
    const dmPack = await service.buildLeaderboardTagPack('919999000001@s.whatsapp.net', rows, { sock: makeSock() });
    assert.deepEqual(dmPack, { text: '', mentions: [] });
    console.log('✅ leaderboard/recap tags: /notag wins, opt-in required, DMs never tagged');
}

// ── 4) handler end-to-end: /tagme, /notag, and failure feedback ─────────────
{
    const chatId = GA;
    const senderJid = '919999000004@s.whatsapp.net';
    const sock = makeSock();
    const ctx = { interviewQuestionService: service, pushName: 'Dev', originalMsg: null };

    await handleTagMe(sock, chatId, senderJid, [], ctx, true);
    assert.ok(await store.isTaggedIn(chatId, '919999000004'), '/tagme must persist the opt-in');
    assert.match(sock.sent[0].text, /You'll be tagged/);
    assert.deepEqual(sock.sent[0].mentions, [senderJid], '/tagme confirmation mentions the user');

    await handleTagMe(sock, chatId, senderJid, [], ctx, false);
    assert.equal(await store.isTaggedIn(chatId, '919999000004'), false, '/notag must persist the opt-out');
    assert.match(sock.sent[1].text, /no more tags/);
    assert.equal(sock.sent[1].mentions.length, 0, '/notag confirmation carries no mention');

    await handleTagMe(sock, '919999000004@s.whatsapp.net', senderJid, [], ctx, false);
    assert.ok(sock.sent[2].text.includes('`/notag` in a group'), 'DM usage is redirected');
    console.log('✅ handler: /tagme + /notag flip the stored pref and confirm');

    // Mongo write fails → the user is told, not left guessing.
    const brokenService = {
        store: {
            async setTagged() {
                throw new Error('ECONNRESET');
            },
        },
    };
    const brokenSock = makeSock();
    await handleTagMe(brokenSock, chatId, senderJid, [],
        { interviewQuestionService: brokenService, pushName: 'Dev', originalMsg: null }, true);
    assert.match(
        brokenSock.sent[0].text,
        /Could not save your tag preference/,
        'storage failure must produce a user-facing error reply'
    );
    console.log('✅ handler: a failed pref save replies with a warning instead of silence');
}

// ── 5) /checktagstatus: your pref + opted-in list + mention resolve ──────────
{
    const sock = makeSock();
    // Amit is ON in GA; Riya is OFF in GA
    await handleCheckTagStatus(sock, GA, `${P2}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Amit',
        originalMsg: null,
    });
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /TAG STATUS/i);
    assert.match(sock.sent[0].text, /\*ON\*/);
    assert.match(sock.sent[0].text, /Mention check:.*working/i);
    assert.match(sock.sent[0].text, /Opted in \(1\)/);
    assert.match(sock.sent[0].text, /Amit/);
    assert.match(sock.sent[0].text, /1\/1 mention JIDs/);
    assert.deepEqual(sock.sent[0].mentions, [J2]);

    await handleCheckTagStatus(sock, GA, `${P1}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Riya',
        originalMsg: null,
    });
    assert.match(sock.sent[1].text, /\*OFF\*/);
    assert.match(sock.sent[1].text, /number resolves in group/i);
    assert.equal(sock.sent[1].mentions.length, 0);

    await handleCheckTagStatus(sock, '919999000001@s.whatsapp.net', `${P2}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Amit',
        originalMsg: null,
    });
    assert.ok(sock.sent[2].text.includes('`/checktagstatus` in a group'), 'DM usage is redirected');
    console.log('✅ handler: /checktagstatus reports ON/OFF, list, and resolve health');
}

console.log('\nAll tag-pref checks passed.');
