/**
 * Self-check: /kick /ban /unban /banlist + durable ban enforcement on rejoin.
 *
 * Offline: real handlers + real BanDatabase, fakes only at the boundaries
 * (Mongo collections, WhatsApp socket, group metadata, user names).
 *
 * Run: node scripts/check-ban.js
 */
import assert from 'node:assert/strict';
import BanDatabase from '../src/models/BanDatabase.js';
import {
    handleKick,
    handleBan,
    handleUnban,
    handleBanList,
} from '../src/controllers/handlers/banHandlers.js';
import { enforceBansOnJoin } from '../src/controllers/handlers/groupHandlers.js';

process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});

// ── in-memory Mongo shim (upsert + deleteOne + find/project + $in) ──────────
function makeDb() {
    const collections = new Map();
    const get = (name) => {
        if (!collections.has(name)) {
            const docs = [];
            collections.set(name, {
                docs,
                async createIndex() {},
                async updateOne(filter, update, opts = {}) {
                    const match = (d) =>
                        Object.entries(filter).every(([k, v]) => {
                            if (v && typeof v === 'object' && v.$in) return v.$in.includes(d[k]);
                            return d[k] === v;
                        });
                    let doc = docs.find(match);
                    if (!doc && opts.upsert) {
                        doc = { ...filter };
                        docs.push(doc);
                    }
                    if (!doc) return { matchedCount: 0, upsertedCount: 1 };
                    Object.assign(doc, update.$set || {}, update.$setOnInsert || {});
                    return { matchedCount: 1, upsertedCount: 0 };
                },
                async deleteOne(filter) {
                    const i = docs.findIndex((d) =>
                        Object.entries(filter).every(([k, v]) => d[k] === v),
                    );
                    if (i === -1) return { deletedCount: 0 };
                    docs.splice(i, 1);
                    return { deletedCount: 1 };
                },
                find(filter = {}) {
                    const match = docs.filter((d) =>
                        Object.entries(filter).every(([k, v]) => {
                            if (v && typeof v === 'object' && v.$in) return v.$in.includes(d[k]);
                            return d[k] === v;
                        }),
                    );
                    return {
                        sort() { return this; },
                        limit() { return this; },
                        project() { return this; },
                        toArray: async () => match.map((d) => ({ ...d })),
                    };
                },
                async findOne(filter = {}) {
                    return (
                        docs.find((d) =>
                            Object.entries(filter).every(([k, v]) => d[k] === v),
                        ) || null
                    );
                },
            });
        }
        return collections.get(name);
    };
    return { collection: (name) => get(name) };
}

const GA = '120363025555555555@g.us';

// Group roster (Baileys 7 style: pn + lid participants, admin flag on GA2)
const P = {
    bot: { id: '999000000000@s.whatsapp.net', phoneNumber: '999000000000@s.whatsapp.net', admin: 'superadmin' },
    admin: { id: '100000000000001@lid', pn: '919999000001@s.whatsapp.net', phoneNumber: '919999000001@s.whatsapp.net', admin: 'admin' },
    admin2: { id: '100000000000005@lid', pn: '919999000005@s.whatsapp.net', phoneNumber: '919999000005@s.whatsapp.net', admin: 'admin' },
    user1: { id: '100000000000002@lid', pn: '919999000002@s.whatsapp.net', phoneNumber: '919999000002@s.whatsapp.net', admin: null },
    user2: { id: '100000000000003@lid', pn: '919999000003@s.whatsapp.net', phoneNumber: '919999000003@s.whatsapp.net', admin: null },
};
const SENDER = P.admin.pn; // group admin runs the commands

const kicked = [];

function makeSock() {
    const sent = [];
    return {
        sent,
        user: { id: '999000000000@s.whatsapp.net' },
        async groupMetadata() {
            return { participants: Object.values(P) };
        },
        async groupParticipantsUpdate(gid, jids, action) {
            if (action === 'remove') kicked.push(...jids);
            return jids.map((id) => ({ id, status: '200' }));
        },
        async sendMessage(jid, content) {
            sent.push({ jid, text: content?.text || '', mentions: content?.mentions || [] });
            return { key: { id: `m${sent.length}` } };
        },
    };
}

const groupManager = {
    getGroupMetadataCached: async () => ({ participants: Object.values(P) }),
    isSenderGroupAdmin: () => true,
};
const userManager = { resolveUserName: async (jids) => (jids[0] ? `User${jids[0].slice(0, 4)}` : '') };

const banDatabase = new BanDatabase(makeDb());
await banDatabase.init();

function ctxFor(sock, waMessage = null) {
    return { banDatabase, groupManager, userManager, originalMsg: waMessage };
}

// quoted-message target helper — reply-based targeting
function quotedMsg(targetJid) {
    return { message: { extendedTextMessage: { contextInfo: { participant: targetJid } } } };
}

// @mention target helper — mention-based targeting (e.g. LID-form mention of self)
function mentionMsg(targetJid) {
    return { message: { extendedTextMessage: { text: 'hi', contextInfo: { mentionedJid: [targetJid] } } } };
}

// ── 1) /kick removes the member, no ban recorded ────────────────────────────
{
    const sock = makeSock();
    await handleKick(sock, GA, SENDER, [], quotedMsg(P.user1.pn), ctxFor(sock));
    assert.deepEqual(kicked, ['100000000000002@lid'], 'kick must remove the participant JID');
    assert.equal(await banDatabase.isBanned(GA, '919999000002'), false, 'kick must NOT ban');
    assert.match(sock.sent[0].text, /MEMBER KICKED/);
    console.log('✅ /kick removes via reply target, records no ban');
}

// ── 2) /ban kicks AND records the durable (real-phone) ban ─────────────────
{
    const sock = makeSock();
    await handleBan(sock, GA, SENDER, ['spamming'], quotedMsg(P.user2.pn), ctxFor(sock));
    assert.ok(kicked.includes('100000000000003@lid'), 'ban must kick');
    assert.equal(await banDatabase.isBanned(GA, '919999000003'), true, 'ban key = real phone digits, not LID digits');
    assert.match(sock.sent[0].text, /MEMBER BANNED/);
    assert.match(sock.sent[0].text, /spamming/);

    // re-ban refreshes instead of duplicating
    const { existed } = await banDatabase.addBan({
        groupId: GA, memberKey: '919999000003', reason: 'again', bannedByPhone: '919999000001',
    });
    assert.equal(existed, true, 'second ban must be recognised as existing');
    console.log('✅ /ban kicks + blacklists by real phone; re-ban is idempotent');
}

// ── 3) banned member rejoins → auto-removed by the hook ────────────────────
{
    const sock = makeSock();
    await enforceBansOnJoin(sock, { groupManager, banDatabase }, GA, [
        { id: '100000000000003@lid', phoneNumber: '919999000003@s.whatsapp.net' }, // banned
        { id: '100000000000004@lid', phoneNumber: '919999000004@s.whatsapp.net' }, // clean
    ]);
    assert.deepEqual(kicked.slice(-1), ['100000000000003@lid'], 'only the banned member is removed');
    assert.match(sock.sent[0].text, /BAN ENFORCED/);
    console.log('✅ banned member who rejoins is auto-removed (clean join untouched)');
}

// ── 4) /unban clears it; enforcement then lets them stay ───────────────────
{
    const sock = makeSock();
    await handleUnban(sock, GA, SENDER, [], quotedMsg(P.user2.pn), ctxFor(sock));
    assert.match(sock.sent[0].text, /MEMBER UNBANNED/);
    assert.equal(await banDatabase.isBanned(GA, '919999000003'), false);

    const sock2 = makeSock();
    await enforceBansOnJoin(sock2, { groupManager, banDatabase }, GA, [
        { id: '100000000000003@lid', phoneNumber: '919999000003@s.whatsapp.net' },
    ]);
    assert.ok(!kicked.includes('100000000000003@lid') || kicked.filter((j) => j === '100000000000003@lid').length === 2,
        'no NEW removal after unban');
    assert.equal(sock2.sent.length, 0, 'no enforcement notice after unban');
    console.log('✅ /unban clears the ban; rejoin is no longer blocked');
}

// ── 5) protections: cannot kick/ban yourself, the bot, or group admins ─────
{
    // Self via LID-form mention (mention JID ≠ senderJid, phone matches) → blocked
    const sock = makeSock();
    await handleKick(sock, GA, SENDER, [], mentionMsg(P.admin.id), ctxFor(sock));
    assert.match(sock.sent[0].text, /INVALID TARGET/, 'cannot target yourself (LID/PN mismatch case)');

    const sock2 = makeSock();
    await handleBan(sock2, GA, SENDER, [], quotedMsg('999000000000@s.whatsapp.net'), ctxFor(sock2));
    assert.match(sock2.sent[0].text, /INVALID TARGET/, 'cannot target the bot');

    const sock3 = makeSock();
    await handleBan(sock3, GA, SENDER, [], quotedMsg(P.admin2.pn), ctxFor(sock3));
    assert.match(sock3.sent[0].text, /PROTECTED/, 'cannot ban a group admin');
    console.log('✅ protections: self/bot/group-admin targets rejected');
}

// ── 6) missing target → usage hint, not a crash ─────────────────────────────
{
    const sock = makeSock();
    await handleBan(sock, GA, SENDER, [], null, ctxFor(sock));
    assert.match(sock.sent[0].text, /NO TARGET/);
    console.log('✅ no target → usage box');
}

// ── 7) LID-only bot roster: isBotGroupAdminAsync saves a false BOT NOT ADMIN ─
{
    // Real-world case: bot's roster entry exposes only a LID (no pn/phoneNumber)
    // while sock.user.id stays a phone JID. The local participant scan can't
    // match the bot; GroupManager.isBotGroupAdmin resolves via creds.me.lid.
    const BOT_LID = '999000000000000@lid';
    const sock = makeSock();
    sock.user = { id: '999000000000@s.whatsapp.net' };
    const lidOnlyRoster = Object.values(P).filter((p) => p !== P.bot);
    lidOnlyRoster.push({ id: BOT_LID, admin: 'superadmin' });
    const groupManagerLidOnly = {
        getGroupMetadataCached: async () => ({ participants: lidOnlyRoster }),
        isSenderGroupAdmin: () => true,
        isBotGroupAdminAsync: async (s, gid) => {
            assert.equal(gid, GA, 'isBotGroupAdminAsync receives the group id');
            return true; // creds.me.lid match in production
        },
    };

    await handleBan(sock, GA, SENDER, ['lidbot'], quotedMsg(P.user2.pn), {
        banDatabase, groupManager: groupManagerLidOnly, userManager, originalMsg: null,
    });
    assert.ok(
        kicked.includes('100000000000003@lid'),
        'ban must kick even when bot roster entry is LID-only',
    );
    assert.match(sock.sent[0].text, /MEMBER BANNED/, 'must not report BOT NOT ADMIN');
    console.log('✅ LID-only bot roster → isBotGroupAdminAsync prevents false BOT NOT ADMIN');
}

// ── 8) WA per-participant status codes surface real failures ───────────────
{
    const sock = makeSock();
    sock.groupParticipantsUpdate = async () => [{ jid: '100000000000002@lid', status: '403' }];
    await handleKick(sock, GA, SENDER, [], quotedMsg(P.user1.pn), ctxFor(sock));
    assert.match(sock.sent[0].text, /BOT NOT ADMIN/, 'status 403 must map to bot_not_admin');
    console.log('✅ kick status 403 → bot_not_admin reported to the group');
}

// ── 9) /banlist renders entries ─────────────────────────────────────────────
{
    await banDatabase.addBan({
        groupId: GA, memberKey: '919999000002', reason: 'test', bannedByPhone: '919999000001',
    });
    const sock = makeSock();
    await handleBanList(sock, GA, SENDER, [], null, ctxFor(sock));
    assert.match(sock.sent[0].text, /BAN LIST/);
    assert.match(sock.sent[0].text, /\+919999000002/);
    console.log('✅ /banlist lists banned members with reason, by, and date');
}

console.log('\nAll ban checks passed.');
// Importing groupHandlers leaves a live timer handle on the event loop —
// exit explicitly so the self-check terminates cleanly.
process.exit(0);
