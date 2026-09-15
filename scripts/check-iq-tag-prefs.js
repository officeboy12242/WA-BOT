/**
 * Self-check: Interview Q tagging is ON by default; /notag is the only exclusion.
 *
 * 1. Storage: setTagged/isTaggedIn/getTaggedMembers per (group, phone).
 *    Default is ON — getTaggedMembers returns all participants minus /notag.
 * 2. Pre-poll ping: tags everyone in the group except /notag users.
 * 3. Leaderboard tag pack: /notag wins — no tag only for explicit /notag users.
 * 4. Handler: /notag flips the pref off; /tagme is now a no-op legacy alias.
 *    A Mongo failure tells the user instead of dying silently.
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

// ── 1) storage: /notag persists tagged=false; default is ON for everyone else ──
await store.setTagged(GA, P1, false, { jid: J1, name: 'Riya' });
assert.equal(await store.isTaggedIn(GA, P1), false, 'notag must store tagged=false');
assert.ok(!(await store.getTaggedMembers(GA, [P1, P2, P3])).some((r) => r === P1), 'notag member must not be listed as tagged');

await store.setTagged(GA, P2, true, { jid: J2, name: 'Amit' });
assert.equal(await store.isTaggedIn(GA, P2), true, 'tagged=true still counts as not opted out');
{
    const prefOn = await store.getTagPref(GA, P2);
    assert.equal(prefOn?.tagged, true);
    assert.equal(prefOn?.name, 'Amit');
    const prefOff = await store.getTagPref(GA, P1);
    assert.equal(prefOff?.tagged, false);
    assert.equal(await store.getTagPref(GA, '919999000099'), null, 'never-set returns null');
}
console.log('✅ storage: getTagPref returns ON / OFF / null');

// default-on: member only fails to tag if they have an explicit /notag in that group
assert.equal(await store.isTaggedIn(GA, P1), false, 'explicit /notag in GA still opts Riya out in GA');
assert.equal(await store.isTaggedIn(GB, P1), true, 'default-on: Riya not opted out in GB, so tagged by default');
console.log('✅ storage: /notag is per (group, phone); default-on otherwise');

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

// ── 2) pre-poll ping: tags everyone except /notag ─────────────────────────────
{
    const sock = makeSock();
    await service.sendInterviewPing(sock, GA, q, 30 * 60_000);
    assert.equal(sock.sent.length, 1);
    const msg = sock.sent[0];
    // everyone except Riya (who ran /notag in GA) should be tagged
    assert.ok(
        msg.mentions.includes(J2) && msg.mentions.includes(J3) && !msg.mentions.includes(J1),
        'ping must tag everyone except /notag (Amit + Zed, not Riya)'
    );
    assert.ok(msg.text.includes('@100000000000002'), 'Amit gets a visible @token');
    assert.ok(msg.text.includes('@100000000000003'), 'Zed gets a visible @token');
    assert.ok(!msg.text.includes('@100000000000001'), 'notag member must not be @-tokenised');
    console.log('✅ ping: everyone tagged except /notag');
}

// /notag still excludes even under default-on; here nobody is opted out, so all tagged
{
    const sock = makeSock();
    await service.sendInterviewPing(sock, GB, q, 30 * 60_000);
    const msg = sock.sent[0];
    assert.ok(msg.mentions.includes(J1) && msg.mentions.includes(J2) && msg.mentions.includes(J3),
        'default-on: every participant gets a visible @token when nobody ran /notag');
    console.log('✅ ping: default-on tags everyone when nobody ran /notag');
}

// pure group with zero prefs → default-on still tags everyone (no /notag in that group)
{
    const GC = '120363033333333333@g.us';
    const sock = makeSock();
    await service.sendInterviewPing(sock, GC, q, 30 * 60_000);
    const msg = sock.sent[0];
    assert.ok(msg.mentions.length >= 3, 'no prefs at all → everyone still tagged by default');
    console.log('✅ ping: default-on tags everyone when group has zero prefs');
}

// ── 3) leaderboard tag pack: /notag is the only exclusion under default-on ─────
{
    const rows = [
        { name: 'Riya', phone: P1, attempted: 5, correct: 4 }, // ran /notag in GA
        { name: 'Amit', phone: P2, attempted: 3, correct: 3 }, // never opted out in GA
        { name: 'Zed', phone: P3, attempted: 9, correct: 9 },  // never opted out in GA
    ];

    const pack = await service.buildLeaderboardTagPack(GA, rows, { limit: 10, sock: makeSock() });
    assert.deepEqual(pack.mentions, [J2, J3].sort(), 'default-on tags everyone except /notag (Amit + Zed, not Riya)');

    // Riya already /notag'd above, so this is a no-op — Amit + Zed remain tagged
    await store.setTagged(GA, P1, false, { jid: J1, name: 'Riya' });
    const pack2 = await service.buildLeaderboardTagPack(GA, rows, { limit: 10, sock: makeSock() });
    assert.deepEqual(pack2.mentions, [J2, J3].sort(), '/notag is idempotent — Amit + Zed still tagged');

    // Zed never opted out, so Zed is tagged even though they never touched /tagme
    assert.ok(pack.mentions.includes(J3), 'never-opted-in member is tagged by default');

    // non-group chat → never any mentions
    const dmPack = await service.buildLeaderboardTagPack('919999000001@s.whatsapp.net', rows, { sock: makeSock() });
    assert.deepEqual(dmPack, { text: '', mentions: [] });
    console.log('✅ leaderboard/recap tags: default-on tags everyone except /notag, DMs never tagged');
}

// ── 4) handler end-to-end: /tagme (legacy no-op) and /notag opt-out ────────────
{
    const chatId = GA;
    const senderJid = '919999000004@s.whatsapp.net';
    const sock = makeSock();
    const ctx = { interviewQuestionService: service, pushName: 'Dev', originalMsg: null };

    // default is already ON, so /tagme is effectively a no-op but still persists nothing new
    await handleTagMe(sock, chatId, senderJid, [], ctx, true);
    assert.ok(await store.isTaggedIn(chatId, '919999000004'), 'default-on: member is tagged without doing anything');
    assert.match(sock.sent[0].text, /tagging is already ON by default/);
    assert.deepEqual(sock.sent[0].mentions, [senderJid], '/tagme confirmation still mentions the user');

    await handleTagMe(sock, chatId, senderJid, [], ctx, false);
    assert.equal(await store.isTaggedIn(chatId, '919999000004'), false, '/notag must persist the opt-out');
    assert.match(sock.sent[1].text, /no more tags/);
    assert.equal(sock.sent[1].mentions.length, 0, '/notag confirmation carries no mention');

    await handleTagMe(sock, '919999000004@s.whatsapp.net', senderJid, [], ctx, false);
    assert.ok(sock.sent[2].text.includes('`/notag` in a group'), 'DM usage is redirected');
    console.log('✅ handler: /notag opt-out works, /tagme is a no-op under default-on');

    // Mongo write fails → the user is told, not left guessing.
    const brokenService = {
        store: {
            async setTagged() {
                throw new Error('ECONNRESET');
            },
            async getTagPref() {
                return { tagged: true };
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

// ── 5) /checktagstatus: default-on + /notag exclusion + list + resolve ──────────
{
    const sock = makeSock();
    // Amit never opted out in GA → default ON; store now sees GA has 2 participants
    await handleCheckTagStatus(sock, GA, `${P2}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Amit',
        originalMsg: null,
    });
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /TAG STATUS/i);
    assert.match(sock.sent[0].text, /\*ON\*/);
    assert.match(sock.sent[0].text, /Mention check:.*working/i);
    assert.match(sock.sent[0].text, /Dev/);
    assert.deepEqual(sock.sent[0].mentions, [J2]);

    // Riya explicitly /notag'd in GA → OFF
    await handleCheckTagStatus(sock, GA, `${P1}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Riya',
        originalMsg: null,
    });
    assert.match(sock.sent[1].text, /\*OFF\*/);
    assert.match(sock.sent[1].text, /you will not be tagged/i);
    assert.equal(sock.sent[1].mentions.length, 0);

    await handleCheckTagStatus(sock, '919999000001@s.whatsapp.net', `${P2}@s.whatsapp.net`, [], {
        interviewQuestionService: service,
        pushName: 'Amit',
        originalMsg: null,
    });
    assert.ok(sock.sent[2].text.includes('`/checktagstatus` in a group'), 'DM usage is redirected');
    console.log('✅ handler: /checktagstatus reports default-on vs /notag, list, and resolve health');
}

console.log('\nAll tag-pref checks passed.');
