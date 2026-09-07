/**
 * Self-check for /birthday (daily AI birthday wishes).
 *
 * Exercises the REAL BirthdayService + scheduler + scheduler helpers with
 * fakes only at the boundaries (Mongo collections, LLM router, WhatsApp send).
 *
 * Run: node scripts/check-birthday.js
 */
import assert from 'node:assert/strict';
import BirthdayService, {
    parseBirthdayDate,
    todayDdMmIST,
    istDayKey,
    inWishWindow,
    wishWindowTarget,
    istHourMinute,
} from '../src/services/BirthdayService.js';

process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});

// ── in-memory Mongo shim with unique-index enforcement ──────────────────────
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
                    const match = docs.filter((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v)
                    );
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
                    return {
                        toArray,
                        sort() {
                            return { toArray };
                        },
                    };
                },
                async findOne(filter = {}) {
                    return (
                        docs.find((d) =>
                            Object.entries(filter).every(([k, v]) => d[k] === v)
                        ) || null
                    );
                },
                async insertOne(doc) {
                    for (const keys of uniques) {
                        if (
                            docs.some((d) =>
                                keys.every((k) => String(d[k]) === String(doc[k]))
                            )
                        ) {
                            const err = new Error('E11000 duplicate key');
                            err.code = 11000;
                            throw err;
                        }
                    }
                    docs.push({ ...doc, _id: `id-${docs.length + 1}` });
                    return { insertedId: docs.length };
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
                async deleteOne(filter = {}) {
                    const i = docs.findIndex((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v)
                    );
                    if (i === -1) return { deletedCount: 0 };
                    docs.splice(i, 1);
                    return { deletedCount: 1 };
                },
            });
        }
        return collections.get(name);
    };
    return { collection: (name) => get(name) };
}

// ── 1) date parsing ─────────────────────────────────────────────────────────
{
    assert.deepEqual(parseBirthdayDate('14-11'), { dd: 14, mm: 11 });
    assert.deepEqual(parseBirthdayDate('3/7'), { dd: 3, mm: 7 });
    assert.deepEqual(parseBirthdayDate(' 14.11.2004 '), { dd: 14, mm: 11 });
    assert.equal(parseBirthdayDate('32-13'), null);
    assert.equal(parseBirthdayDate('0-5'), null);
    assert.equal(parseBirthdayDate('tomorrow'), null);
    assert.equal(parseBirthdayDate(''), null);
    console.log('✅ parseBirthdayDate accepts DD-MM[/YYYY], rejects garbage');
}

// ── 2) wish window logic ────────────────────────────────────────────────────
{
    const t = wishWindowTarget({ BIRTHDAY_TIME: '09:07' });
    assert.deepEqual(t, { hour: 9, minute: 7 });
    assert.deepEqual(wishWindowTarget({}), { hour: 9, minute: 7 });
    assert.equal(inWishWindow(t, { hour: 9, minute: 6 }), false);
    assert.equal(inWishWindow(t, { hour: 9, minute: 7 }), true);
    assert.equal(inWishWindow(t, { hour: 23, minute: 59 }), true); // late same-day catch-up
    assert.equal(inWishWindow(t, { hour: 8, minute: 0 }), false);
    assert.equal(inWishWindow({ hour: 0, minute: 0 }, istHourMinute()), true); // always-open target
    console.log('✅ wish window: fires at/after target, late same-day catch-up allowed');
}

// ── 3) CRUD + dedupe + scheduler end-to-end ─────────────────────────────────
const db = makeDb({
    group_birthdays: [['group_id', 'phone']],
    birthday_wishes_sent: [['group_id', 'phone', 'year']],
});
const service = new BirthdayService({
    mongoDb: db,
    groupManager: {},
    cfg: { BIRTHDAY_ENABLED: true, BIRTHDAY_TIME: '00:00' }, // window always open
});
service.llm = {
    isConfigured: () => true,
    calls: 0,
    async completeChat() {
        this.calls += 1;
        return { text: 'Happy birthday — may your builds be green today! 🎂', provider: 'fake', model: 'wish-1' };
    },
};
await service.init();

const GA = '120363021111111111@g.us';
const GB = '120363022222222222@g.us';
const A1 = '919999000001@s.whatsapp.net';
const A2 = '919999000002@s.whatsapp.net';
const B1 = '919999000003@s.whatsapp.net';
const [todayDd, todayMm] = todayDdMmIST().split('-').map(Number);

// invalid add
{
    const res = await service.addBirthday({ groupId: GA, senderJid: A1, rawDate: 'someday' });
    assert.equal(res.ok, false);
    assert.match(res.message, /add 14-11/);
    console.log('✅ /birthday add with a bad date explains the format');
}

// valid adds: two in group A, one in group B, all "today"
{
    for (const [gid, jid] of [[GA, A1], [GA, A2], [GB, B1]]) {
        const res = await service.addBirthday({
            groupId: gid,
            senderJid: jid,
            rawDate: `${todayDd}-${todayMm}`,
        });
        assert.equal(res.ok, true, res.message);
    }
    // one non-today birthday — must NOT be wished
    const other = todayMm === 12 ? { dd: 1, mm: 1 } : { dd: todayDd === 28 ? 1 : todayDd + 1, mm: todayMm };
    await service.col.insertOne({ group_id: GA, phone: '919999000009', dd: other.dd, mm: other.mm });
    console.log('✅ /birthday add saves day-month per group+phone');
}

// scheduler: start() → immediate catch-up tick → wishes sent to both groups
{
    const sent = [];
    let n = 0;
    const sock = {
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content.text, mentions: content.mentions });
            return { key: { id: `k${++n}` } };
        },
    };
    const sched = new BirthdayService({
        mongoDb: db,
        groupManager: {},
        cfg: { BIRTHDAY_ENABLED: true, BIRTHDAY_TIME: '00:00', BIRTHDAY_CATCHUP_TICK_MS: 86_400_000, BIRTHDAY_SEND_GAP_MS: 0 },
    });
    sched.llm = service.llm;
    await sched.init();
    sched.start({ getSock: () => sock });
    await new Promise((r) => setTimeout(r, 400));
    sched.stop();

    // one tagged wish message per celebrant: 2 in group A + 1 in group B
    assert.equal(sent.length, 3, `expected 3 wish messages, got ${sent.length}: ${JSON.stringify(sent.map((s) => s.jid))}`);
    const inA = sent.filter((s) => s.jid === GA);
    const inB = sent.filter((s) => s.jid === GB);
    assert.equal(inA.length, 2);
    assert.equal(inB.length, 1);
    for (const s of inA) assert.match(s.text, /birthday/i);
    assert.deepEqual(
        inA.map((s) => s.mentions?.[0]).sort(),
        ['919999000001@s.whatsapp.net', '919999000002@s.whatsapp.net'].sort()
    );
    assert.deepEqual(inB[0].mentions, ['919999000003@s.whatsapp.net']);
    console.log('✅ scheduler posted tagged wishes to both groups on the startup tick');
}

// dedupe: a second run the same day must be a no-op
{
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid }); return { key: { id: 'k' } }; } };
    const res = await service.runDailyWishes({ sock });
    assert.equal(res.posted, 0, 'no double-posting on the same day');
    assert.equal(res.skipped, 3);
    assert.equal(sent.length, 0);
    console.log('✅ Mongo dedupe: same-day re-run sends nothing');
}

// LLM failure → template fallback still delivers the wish
{
    const fresh = new BirthdayService({
        mongoDb: makeDb({ birthday_wishes_sent: [['group_id', 'phone', 'year']] }),
        groupManager: {},
        cfg: { BIRTHDAY_ENABLED: true, BIRTHDAY_TIME: '00:00' },
    });
    fresh.llm = {
        isConfigured: () => true,
        async completeChat() {
            throw new Error('all providers rate-limited');
        },
    };
    await fresh.init();
    const [dd, mm] = todayDdMmIST().split('-').map(Number);
    await fresh.col.insertOne({ group_id: GB, phone: '918888777666', dd, mm });
    const sent = [];
    const sock = {
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content.text, mentions: content.mentions });
            return { key: { id: 'k' } };
        },
    };
    const res = await fresh.runDailyWishes({ sock });
    assert.equal(res.posted, 1);
    assert.match(sent[0].text, /Happy Birthday/i, 'template fallback must still be a wish');
    assert.deepEqual(sent[0].mentions, ['918888777666@s.whatsapp.net']);
    console.log('✅ LLM outage → template fallback wish still posts with the tag');
}

// remove + list
{
    const res = await service.removeBirthday(GA, '919999000001');
    assert.equal(res.ok, true);
    const rows = await service.listBirthdays(GA);
    assert.ok(!rows.some((r) => r.phone === '919999000001'));
    assert.ok(rows.length >= 1, 'other rows remain');
    const gone = await service.removeBirthday(GA, '919999000001');
    assert.equal(gone.ok, false);
    console.log('✅ /birthday remove deletes only the caller row; list stays correct');
}

// send failure rolls back the dedupe marker for retry
{
    const rollbackDb = makeDb({ birthday_wishes_sent: [['group_id', 'phone', 'year']] });
    const svc3 = new BirthdayService({ mongoDb: rollbackDb, groupManager: {}, cfg: { BIRTHDAY_ENABLED: true } });
    svc3.llm = { isConfigured: () => true, async completeChat() { return { text: 'wish', provider: 'f', model: 'm' }; } };
    await svc3.init();
    const [dd, mm] = todayDdMmIST().split('-').map(Number);
    await svc3.col.insertOne({ group_id: GB, phone: '917777666555', dd, mm });
    const failingSock = { sendMessage: async () => { throw new Error('network down'); } };
    const res = await svc3.runDailyWishes({ sock: failingSock });
    assert.equal(res.posted, 0);
    const marker = await svc3.wishesCol.findOne({ group_id: GB, phone: '917777666555' });
    assert.equal(marker, null, 'failed sends must roll back the marker so a retry can send');
    console.log('✅ failed send rolls back the dedupe marker (retry possible)');
}

console.log(`✅ check-birthday passed (day key ${istDayKey()}, today ${todayDdMmIST()})`);
process.exit(0);
