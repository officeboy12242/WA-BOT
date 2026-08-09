/**
 * Self-check: broadcast targeting, opt-out matching and send retry. No network.
 *
 * Run: node scripts/check-broadcast.js
 */
import assert from 'assert';
import { dmTargetForMember, resolveLidToPhoneJid } from '../src/controllers/MemberScrapeController.js';
import MemberScrapeController from '../src/controllers/MemberScrapeController.js';
import { classifyOptMessage, optOutKey } from '../src/models/BroadcastOptOutStore.js';
import BroadcastService, { withOptOutFooter, BROADCAST_STATUS } from '../src/services/BroadcastService.js';

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

/* ── pacing config ───────────────────────────────────────────────────────── */

ok(svc.opts.minGapMs >= 3000, 'the minimum gap is never sub-second');
ok(svc.opts.maxGapMs > svc.opts.minGapMs, 'gaps are a range, so the cadence varies');
ok(svc.opts.dailyCap > 0 && svc.opts.dailyCap <= 500, `daily cap is bounded (${svc.opts.dailyCap})`);
ok(svc.opts.failureRateAbort > 0 && svc.opts.failureRateAbort < 1, 'there is a failure circuit breaker');
ok(BROADCAST_STATUS.PAUSED_CAP && BROADCAST_STATUS.ABORTED, 'paused and aborted are distinct outcomes');

// Overrides must still be sane.
const fast = new BroadcastService(null, null, { BROADCAST_MIN_GAP_MS: 1000, BROADCAST_MAX_GAP_MS: 2000 });
ok(fast.opts.minGapMs === 1000, 'gaps are configurable');

console.log(`OK broadcast — ${checks} checks passed`);
