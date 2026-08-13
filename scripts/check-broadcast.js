/**
 * Self-check: broadcast targeting, opt-out matching and send retry. No network.
 *
 * Run: node scripts/check-broadcast.js
 */
import assert from 'assert';
import { dmTargetForMember, resolveLidToPhoneJid } from '../src/controllers/MemberScrapeController.js';
import MemberScrapeController from '../src/controllers/MemberScrapeController.js';
import { classifyOptMessage, optOutKey } from '../src/models/BroadcastOptOutStore.js';
import BroadcastService, { withOptOutFooter, BROADCAST_STATUS, resolveAccountJid } from '../src/services/BroadcastService.js';
import { SendPacingService, resolvePacingConfig } from '../src/services/SendPacingService.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); checks += 1; };

/* ── target shape ────────────────────────────────────────────────────────── */

eq(dmTargetForMember({ phone: '919876543210' }), { jid: '919876543210@s.whatsapp.net', via: 'phone' },
    'a plain phone becomes a sendable JID');
eq(dmTargetForMember({ jid: '919876543210@s.whatsapp.net' }), { jid: '919876543210@s.whatsapp.net', via: 'phone' },
    'a phone JID is used directly');

// The core bug: a LID must NOT come back as something to send to. It is a
// group-scoped identifier and sendMessage to it cannot deliver a DM.
const lidTarget = dmTargetForMember({ lid: '12345678901234@lid' });
eq(lidTarget.via, 'lid', 'a LID member is flagged as needing resolution');
ok(!lidTarget.jid, 'a LID is never handed back as a ready-to-send jid');
ok(lidTarget.lid.endsWith('@lid'), 'the raw LID is preserved for resolution');
eq(dmTargetForMember({}), null, 'a member with neither phone nor LID is not a target');

/* ── LID resolution ──────────────────────────────────────────────────────── */

const sockWithMapping = {
    signalRepository: {
        lidMapping: { getPNForLID: async (lid) => (lid.startsWith('111') ? '919999888877@s.whatsapp.net' : null) },
    },
};
eq(await resolveLidToPhoneJid(sockWithMapping, '111222@lid'), '919999888877@s.whatsapp.net',
    'a known LID resolves to its phone JID');
eq(await resolveLidToPhoneJid(sockWithMapping, '999@lid'), null, 'an unknown LID resolves to null');
eq(await resolveLidToPhoneJid({}, '111222@lid'), null, 'no mapping store resolves to null, not a throw');
eq(await resolveLidToPhoneJid(null, '111222@lid'), null, 'no socket resolves to null');

/* ── reachability accounting ─────────────────────────────────────────────── */

const members = [
    { phone: '919876543210' },                       // reachable
    { lid: '111aaa@lid' },                           // resolvable -> 919999888877
    { lid: '222bbb@lid' },                           // unresolvable
    { phone: '919876543210' },                       // duplicate of the first
    {},                                              // no identity at all
];
const ctrl = new MemberScrapeController({
    getMembersForGroup: async () => members,
    getScrapedGroups: async () => [],
    getMemberCount: async () => members.length,
});

const res = await ctrl.resolveDmTargets('g@g.us', sockWithMapping);
eq(res.targets.length, 2, 'only genuinely deliverable, deduped targets are returned');
eq(res.lidResolved, 1, 'the resolvable LID is counted as resolved');
eq(res.unreachable, 2, 'the unresolvable LID and the empty member are counted unreachable');
ok(res.targets.every((t) => t.endsWith('@s.whatsapp.net')), 'every target is a phone JID');

const stats = await ctrl.getDmTargetStats('g@g.us', sockWithMapping);
eq(stats.dm_count, 2, 'the advertised DM count matches what can actually be sent');
eq(stats.unreachable_count, 2, 'unreachable members are reported, not hidden in the total');

// Without a socket there is nothing to resolve LIDs against.
const noSock = await ctrl.resolveDmTargets('g@g.us', null);
eq(noSock.targets.length, 1, 'without a socket only phone members are targeted');
eq(noSock.unreachable, 3, 'unresolvable LIDs are reported rather than silently attempted');

/* ── opt-out matching ────────────────────────────────────────────────────── */

for (const t of ['STOP', 'stop', ' Stop ', 'unsubscribe', 'OPT OUT', 'opt-out', 'remove me', 'band karo']) {
    eq(classifyOptMessage(t), 'out', `"${t}" opts out`);
}
for (const t of ['START', 'subscribe', 'resume']) {
    eq(classifyOptMessage(t), 'in', `"${t}" opts back in`);
}
// A sentence that merely contains the word must not unsubscribe someone.
for (const t of ['please stop sending me these at 3am, it is really annoying', 'non-stop', 'hello', '']) {
    eq(classifyOptMessage(t), null, `"${t.slice(0, 30)}" is not an opt-out command`);
}

eq(optOutKey('919876543210@s.whatsapp.net'), '919876543210', 'opt-out key drops the JID suffix');
eq(optOutKey('919876543210:12@s.whatsapp.net'), '919876543210', 'opt-out key drops the device suffix');
eq(optOutKey('garbage'), '', 'a non-phone yields no key');

/* ── opt-out footer ──────────────────────────────────────────────────────── */

ok(/STOP/i.test(withOptOutFooter('Hello there')), 'the footer tells people how to leave');
const already = 'Sale today!\n\nReply STOP to opt out.';
eq(withOptOutFooter(already), already, 'an existing opt-out line is not duplicated');

/* ── send retry ──────────────────────────────────────────────────────────── */

const svc = new BroadcastService(null, null, {});

// The old code sent, then sent AGAIN whenever a pre-check guessed there was no
// privacy token — so a correct first send became a duplicate DM.
let sends = 0;
const happy = { sendMessage: async () => { sends += 1; } };
eq((await svc._sendOnce(happy, 'x@s.whatsapp.net', 'hi')).ok, true, 'a good send succeeds');
eq(sends, 1, 'a successful send happens exactly once — no duplicate');

let attempts = 0;
const flaky = {
    sendMessage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('failed to send: 463 missing tctoken');
    },
};
const retried = await svc._sendOnce(flaky, 'x@s.whatsapp.net', 'hi');
eq(retried.ok, true, 'a 463 is retried and then succeeds');
eq(retried.retried, true, 'the retry is reported');
eq(attempts, 2, 'the retry happens only after a real failure');

let hardAttempts = 0;
const broken = { sendMessage: async () => { hardAttempts += 1; throw new Error('not-on-whatsapp'); } };
const hard = await svc._sendOnce(broken, 'x@s.whatsapp.net', 'hi');
eq(hard.ok, false, 'a non-recoverable error fails');
eq(hardAttempts, 1, 'a non-recoverable error is NOT retried');

// A send the SERVER drops (463 privacy-token error arrives async, AFTER
// sendMessage resolved) must be retried. sendMessage resolving does not mean
// the recipient got it — the old code counted these as sent and never retried.
let droppedSends = 0;
const droppedByServer = {
    sendMessage: async () => { droppedSends += 1; return { key: { id: `m${droppedSends}` } }; },
};
const dropOnce = { wait: async (msgId) => (msgId === 'm1' ? 'ERROR' : 'OK') };
// First send dropped; token issued; the retry is accepted.
const dropped = await svc._sendOnce(droppedByServer, 'x@s.whatsapp.net', 'hi', dropOnce);
eq(dropped.ok, true, 'an async server drop is retried and counts as ok');
eq(dropped.retried, true, 'the async retry is reported');
eq(droppedSends, 2, 'an async server drop triggers exactly one retry');

// A recipient who STILL drops after the token must be reported as unreachable,
// never as "sent" — and must not be retried again (spam-report risk).
let blockedSends = 0;
const blocksDms = {
    sendMessage: async () => { blockedSends += 1; return { key: { id: `b${blockedSends}` } }; },
};
const blocked = await svc._sendOnce(blocksDms, 'x@s.whatsapp.net', 'hi', { wait: async () => 'ERROR' });
eq(blocked.ok, false, 'a recipient who blocks DMs is counted as not sent');
eq(blocked.permanent, true, 'a persistent drop is flagged permanent/unreachable');
eq(blockedSends, 2, 'a persistent drop is attempted exactly twice, never more');

// A send the server accepts (ack observed) must NOT be resent.
let ackSends = 0;
const acked = {
    sendMessage: async () => { ackSends += 1; return { key: { id: 'm2' } }; },
};
const goodAck = await svc._sendOnce(acked, 'x@s.whatsapp.net', 'hi', { wait: async () => 'OK' });
eq(goodAck.ok, true, 'an acked send succeeds');
eq(goodAck.retried, false, 'an acked send is not retried');
eq(ackSends, 1, 'an acked send happens exactly once');

// ── pre-flight readiness sampling ────────────────────────────────────────────

const readinessSock = {
    signalRepository: {
        lidMapping: { getLIDForPN: async () => '999@lid' },
    },
    authState: {
        keys: {
            get: async (ns, jids) => {
                // Token cached only for 'a@...' (present) — the shared LID must
                // NOT make every target look token-ready.
                const out = {};
                for (const j of jids) {
                    if (j === 'a@s.whatsapp.net') out[j] = { token: Buffer.from('tok') };
                }
                return out;
            },
        },
    },
};
const readiness = await svc.sampleDmReadiness(
    readinessSock,
    ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net'],
    10
);
eq(readiness.sampled, 3, 'readiness sample covers the requested targets');
eq(readiness.withToken, 1, 'targets with a cached token are counted');
eq(readiness.noToken, 2, 'targets without a token are counted as needing issuance');
eq(readiness.unreadable, 0, 'no unreadable targets when the store responds');

/* ── pacing config ───────────────────────────────────────────────────────── */

ok(svc.opts.minGapMs >= 3000, 'the minimum gap is never sub-second');
ok(svc.opts.maxGapMs > svc.opts.minGapMs, 'gaps are a range, so the cadence varies');
ok(svc.opts.dailyCap > 0 && svc.opts.dailyCap <= 500, `daily cap is bounded (${svc.opts.dailyCap})`);
ok(svc.opts.failureRateAbort > 0 && svc.opts.failureRateAbort < 1, 'there is a failure circuit breaker');
ok(BROADCAST_STATUS.PAUSED_CAP && BROADCAST_STATUS.ABORTED, 'paused and aborted are distinct outcomes');

// Overrides must still be sane.
const fast = new BroadcastService(null, null, { BROADCAST_MIN_GAP_MS: 1000, BROADCAST_MAX_GAP_MS: 2000 });
ok(fast.opts.minGapMs === 1000, 'gaps are configurable');

/* ── stale-member pruning ────────────────────────────────────────────────── */

// upsertMembers only ever added rows, so people who LEFT a group stayed in the
// store forever and kept receiving broadcasts.
let deleted = null;
const fakeDb = {
    members: {
        bulkWrite: async () => ({ upsertedCount: 2, modifiedCount: 1 }),
        deleteMany: async (q) => { deleted = q; return { deletedCount: 3 }; },
        countDocuments: async () => 7,
    },
    scrapes: { updateOne: async () => {}, deleteOne: async () => {}, deleteMany: async () => ({ deletedCount: 2 }) },
};
const { default: GroupMemberDatabase } = await import('../src/models/GroupMemberDatabase.js');
const gdb = new GroupMemberDatabase({ collection: () => null });
gdb.members = fakeDb.members;
gdb.scrapes = fakeDb.scrapes;

const up = await gdb.upsertMembers('g@g.us', 'Test', [
    { id: '919876543210@s.whatsapp.net', phoneNumber: '919876543210' },
    { id: '919876543211@s.whatsapp.net', phoneNumber: '919876543211' },
]);
eq(up.removed, 3, 're-scraping removes members who left the group');
ok(deleted && deleted.group_id === 'g@g.us', 'the prune is scoped to the group just scraped');
ok(deleted.updated_at && deleted.updated_at.$lt instanceof Date, 'the prune targets rows older than this scrape');

// An empty participant list must not wipe the group — that would be a scrape
// failure silently deleting real data.
deleted = null;
const empty = await gdb.upsertMembers('g@g.us', 'Test', []);
eq(empty.removed, 0, 'an empty scrape removes nothing');
eq(deleted, null, 'an empty scrape issues no delete at all');

const cleared = await gdb.clearGroup('g@g.us');
eq(cleared.removed, 3, 'clearGroup deletes that group\'s members');
const clearedAll = await gdb.clearAllGroups();
eq(clearedAll.removed, 3, 'clearAllGroups deletes every member');
eq(clearedAll.groups, 2, 'clearAllGroups deletes the scrape records too');

/* ── send-pacing governor (OpenWA-style warm-up + cold cap + breaker) ──── */

// Config parsing — pure and offline.
const defCfg = resolvePacingConfig({});
eq(defCfg.warmupSchedule[0], 20, 'default warm-up starts at 20/day');
eq(defCfg.coldSchedule[0], 5, 'default cold cap starts at 5/day');
const customCfg = resolvePacingConfig({
    PACING_WARMUP_SCHEDULE: '10,50',
    PACING_COLD_DAILY_CAP: '2,4',
    PACING_BREAKER_THRESHOLD: '3',
    PACING_BREAKER_COOLDOWN_MS: '60000',
});
eq(customCfg.warmupSchedule, [10, 50], 'custom warm-up schedule parses');
eq(customCfg.coldSchedule, [2, 4], 'custom cold schedule parses');
eq(customCfg.breakerThreshold, 3, 'custom breaker threshold parses');
eq(customCfg.breakerCooldownMs, 60000, 'custom breaker cooldown parses');
const badCfg = resolvePacingConfig({ PACING_WARMUP_SCHEDULE: 'abc,10' });
eq(badCfg.warmupSchedule, defCfg.warmupSchedule, 'a malformed schedule falls back to defaults');
ok(resolvePacingConfig({ PACING_ENABLED: false }).enabled === false, 'pacing can be switched off');

// In-memory Mongo stand-in: enough of findOne/insertOne/updateOne for the
// governor's persistence paths.
function pickProjection(doc, projection) {
    if (!projection || typeof projection !== 'object') return { ...doc };
    const out = {};
    for (const key of Object.keys(projection)) {
        if (projection[key] === 1 && doc[key] !== undefined) out[key] = doc[key];
    }
    return out;
}

function fakeMongoDb() {
    const collections = new Map();
    const coll = (name) => {
        if (!collections.has(name)) collections.set(name, new Map());
        const map = collections.get(name);
        return {
            findOne: async (q = {}) => {
                for (const doc of map.values()) {
                    if (Object.entries(q).every(([k, v]) => doc[k] === v)) return doc;
                }
                return null;
            },
            find: (q = {}, proj = {}) => ({
                toArray: async () => {
                    const out = [];
                    for (const doc of map.values()) {
                        if (Object.entries(q).every(([k, v]) => doc[k] === v)) {
                            out.push(proj && proj.projection ? pickProjection(doc, proj.projection) : { ...doc });
                        }
                    }
                    return out;
                },
                sort: () => ({ toArray: async () => [] }),
            }),
            countDocuments: async (q = {}) => {
                let n = 0;
                for (const doc of map.values()) {
                    if (Object.entries(q).every(([k, v]) => doc[k] === v)) n += 1;
                }
                return n;
            },
            insertOne: async (doc) => { map.set(JSON.stringify({ _id: doc._id ?? doc.account }), { ...doc }); return {}; },
            updateOne: async (q = {}, update = {}) => {
                const key = JSON.stringify(q);
                let doc = null;
                for (const d of map.values()) {
                    if (Object.entries(q).every(([k, v]) => d[k] === v)) { doc = d; break; }
                }
                if (!doc) { doc = { account: q.account }; map.set(key, doc); }
                if (update.$set) Object.assign(doc, update.$set);
                if (update.$setOnInsert) {
                    for (const [k, v] of Object.entries(update.$setOnInsert)) {
                        if (doc[k] === undefined) doc[k] = v;
                    }
                }
                for (const [k, v] of Object.entries(update.$inc || {})) {
                    const parts = k.split('.');
                    let cur = doc;
                    for (let i = 0; i < parts.length - 1; i += 1) {
                        cur[parts[i]] = cur[parts[i]] || {};
                        cur = cur[parts[i]];
                    }
                    cur[parts[parts.length - 1]] = (cur[parts[parts.length - 1]] || 0) + v;
                }
                return {};
            },
            createIndex: async () => {},
        };
    };
    return { collection: coll };
}

const pacing = new SendPacingService(fakeMongoDb(), {});
const ACC = 'account1';
eq(await pacing.accountAgeDays(ACC), 0, 'a fresh account is day 0');
const day0 = await pacing.accountDayInfo(ACC);
eq(day0.warmupAllowance, 20, 'day-0 warm-up allowance is 20');
eq(day0.coldAllowance, 5, 'day-0 cold allowance is 5');
ok(await pacing.isCold(ACC, 'x@s.whatsapp.net'), 'a never-messaged recipient is cold');

let gate = await pacing.check(ACC, 'x@s.whatsapp.net', { sentToday: 20 });
eq(gate.allowed, false, 'the warm-up cap refuses once today\'s sends hit the allowance');
ok(gate.reason.includes('warm-up'), 'the refusal names the warm-up ramp');
gate = await pacing.check(ACC, 'x@s.whatsapp.net', { sentToday: 10 });
eq(gate.allowed, true, 'sends under the allowance are allowed');

// Cold budget: five strangers, then the sixth is refused — even though the
// warm-up allowance (20) has plenty of room left.
for (const r of ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net', 'd@s.whatsapp.net', 'e@s.whatsapp.net']) {
    await pacing.recordSend(ACC, r, true);
}
gate = await pacing.check(ACC, 'f@s.whatsapp.net', { sentToday: 5 });
eq(gate.allowed, false, 'the cold cap refuses once today\'s new-people budget is spent');
ok(gate.reason.includes('cold'), 'the refusal names the cold-reachout budget');
ok(!(await pacing.isCold(ACC, 'a@s.whatsapp.net')), 'a messaged recipient is no longer cold');
gate = await pacing.check(ACC, 'a@s.whatsapp.net', { sentToday: 6 });
eq(gate.allowed, true, 'a known recipient ignores the cold budget');

// Breaker: N consecutive failures pause everything, a success reopens it.
for (let i = 0; i < 5; i += 1) pacing.recordFailure(ACC);
ok(pacing.breakerRemainingMs(ACC) > 0, '5 consecutive failures open the breaker');
gate = await pacing.check(ACC, 'a@s.whatsapp.net', { sentToday: 0 });
eq(gate.allowed, false, 'an open breaker refuses all sends');
ok(gate.reason.includes('cooling down'), 'the refusal names the cooldown');
pacing.recordSuccess(ACC);
eq(pacing.breakerRemainingMs(ACC), 0, 'a success closes the breaker');

// Custom threshold trips earlier.
const tight = new SendPacingService(fakeMongoDb(), { PACING_BREAKER_THRESHOLD: '2' });
tight.recordFailure(ACC);
eq(tight.breakerRemainingMs(ACC), 0, 'below the custom threshold the breaker stays closed');
tight.recordFailure(ACC);
ok(tight.breakerRemainingMs(ACC) > 0, 'the custom threshold trips the breaker');

// No database = inert, so an unpersisted governor can never block sends.
const inert = new SendPacingService(null, {});
eq(inert.enabled, false, 'pacing without persistence is inert');
eq((await inert.check(ACC, 'x@s.whatsapp.net')).allowed, true, 'inert pacing always allows');

// lastMessagedAt — the basis for "skip people I already messaged".
eq(await pacing.lastMessagedAt(ACC, 'fresh@s.whatsapp.net'), null, 'a never-messaged recipient has no last_dm');
const known2 = new SendPacingService(fakeMongoDb(), {});
await known2.recordSend(ACC, 'z@s.whatsapp.net', true);
ok((await known2.lastMessagedAt(ACC, 'z@s.whatsapp.net')) instanceof Date, 'a messaged recipient has a last_dm timestamp');
eq(await known2.lastMessagedAt(ACC, 'nope@s.whatsapp.net'), null, 'an unknown recipient stays null');

/* ── skip-already-messaged + personalization + delivery-rate guard ───────── */

// The run() loop skips recipients this account already DM'd (re-DMing the same
// people is how a broadcast becomes a report generator).
const skipDb = fakeMongoDb();
const skipPacing = new SendPacingService(skipDb, {});
const skipSvc = new BroadcastService(skipDb, null, {}, skipPacing);
await skipSvc.init();
const skipJobId = await skipSvc.createJob({
    label: 'skip test', message: 'hello', chatId: 'c',
    targets: ['m1@s.whatsapp.net', 'm2@s.whatsapp.net', 'm3@s.whatsapp.net'],
});
// m2 was already messaged by this account — must be skipped, not re-DM'd.
await skipPacing.recordSend(resolveAccountJid({ user: { id: '999:s@w' } }), 'm2@s.whatsapp.net', true);
const skipSent = [];
const skipFinal = await skipSvc.run({
    getSock: () => ({ user: { id: '999:s@w' }, sendMessage: async () => { skipSent.push('x'); return { key: { id: 'k' } }; } }),
    jobId: skipJobId,
});
eq(skipFinal.skipped_messaged, 1, 'a recipient already messaged is skipped, not re-DM\'d');
eq(skipFinal.sent, 2, 'the other two targets still get the message');
eq(skipSent.length, 2, 'exactly two DMs went out');

// Personalization: known first name is prefixed, unknown stays plain.
const pSvc = new BroadcastService(null, null, {});
eq(pSvc.personalizeFor('Sale today!', 'Ravi Kumar'), 'Hi Ravi,\n\nSale today!', 'a known name personalizes the opener');
eq(pSvc.personalizeFor('Sale today!', '  '), 'Sale today!', 'a blank name sends the plain message');
eq(pSvc.personalizeFor('Sale today!', '12345'), 'Sale today!', 'a numeric name is not used');
const pOff = new BroadcastService(null, null, { BROADCAST_PERSONALIZE: false });
eq(pOff.personalizeFor('Sale today!', 'Ravi'), 'Sale today!', 'personalization can be switched off');

// Delivery-rate soft-ban guard: a sustained run of drops pauses the job with a
// cooldown instead of burning the rest of the daily cap. Failures are hard
// (immediate throws) so the test is fast and deterministic.
const guardDb = fakeMongoDb();
const guardSvc = new BroadcastService(guardDb, null, {
    BROADCAST_DELIVERY_FLOOR: 0.5,
    BROADCAST_DELIVERY_WINDOW: 4,
    BROADCAST_MIN_GAP_MS: 1,
    BROADCAST_MAX_GAP_MS: 1,
    BROADCAST_SKIP_MESSAGED: false,
}, new SendPacingService(guardDb, {}));
await guardSvc.init();
const guardJobId = await guardSvc.createJob({
    label: 'guard test', message: 'hi', chatId: 'c',
    targets: ['a1@s.whatsapp.net', 'a2@s.whatsapp.net', 'a3@s.whatsapp.net', 'a4@s.whatsapp.net', 'a5@s.whatsapp.net'],
});
const guardSock = {
    user: { id: '999:s@w' },
    sendMessage: async () => { throw new Error('server: not-on-whatsapp'); },
};
const guardFinal = await guardSvc.run({ getSock: () => guardSock, jobId: guardJobId });
eq(guardFinal.status, BROADCAST_STATUS.PAUSED_CAP, 'a collapsed delivery rate pauses the run');
ok(/delivery rate/.test(guardFinal.note || ''), 'the pause names the delivery-rate guard');
ok(guardFinal.sent === 0, 'nothing counts as sent when every send fails');
const guardJob = await guardSvc.getJob(guardJobId);
ok(guardJob.delivery_paused_until instanceof Date, 'the cooldown is persisted on the job');
// While the cooldown is active, resuming must not re-fire sends.
const resumeFinal = await guardSvc.run({ getSock: () => guardSock, jobId: guardJobId });
eq(resumeFinal.status, BROADCAST_STATUS.PAUSED_CAP, 'resume during the cooldown stays paused');
ok(/cooldown/.test(resumeFinal.note || ''), 'the resume pause names the cooldown');

/* ── account key resolution ──────────────────────────────────────────────── */

eq(resolveAccountJid({ user: { id: '917887499710:7@s.whatsapp.net' } }),
    '917887499710', 'the account key drops the device suffix');
eq(resolveAccountJid({ authState: { creds: { me: { id: '919999888877:3@s.whatsapp.net' } } } }),
    '919999888877', 'the account key falls back to auth creds');
eq(resolveAccountJid({}), 'default', 'no identity yields the default key');

console.log(`OK broadcast — ${checks} checks passed`);

// Importing BroadcastService pulls in the shared message queue, whose 5-minute
// cleanup interval keeps the event loop alive — exit explicitly so this check
// script terminates under the test runner.
process.exit(0);
