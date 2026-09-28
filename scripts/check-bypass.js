/**
 * Self-check: /bypass flow — limits, progress edits, result formatting.
 * Uses a mocked WhatsApp socket + real Mongo (bypass_limits collection).
 * Network is only hit for the bypass resolution itself.
 *
 * Run: node scripts/check-bypass.js
 */
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const { connectMongo, closeMongo } = await import('../src/db/mongo.js');
const { config } = await import('../src/config/config.js');
const { bypassController } = await import('../src/controllers/BypassController.js');
const { shortLinkService } = await import('../src/services/ShortLinkService.js');

const db = await connectMongo({ uri: config.MONGODB_URI, dbName: config.MONGODB_DB_NAME });
await shortLinkService.init(db);
bypassController.mongoDb = db;
bypassController.groupManager = null; // no premium/staff → free-user limits apply
await bypassController.init();

// test user starts clean
const TEST_USER = '999111222333';
await bypassController.bypassLimits.deleteMany({ user_id: TEST_USER });

let sendCount = 0;
const sent = [];
const sock = {
    async sendMessage(jid, content) {
        sendCount += 1;
        sent.push({ jid, content });
        return { key: { id: `fake${sendCount}`, remoteJid: jid, fromMe: true } };
    },
};

const CHAT = '999000000000@g.us';
const SENDER = `${TEST_USER}@s.whatsapp.net`;
const LINK = 'https://hubcdn.wiki/file/1EQ9EwtzCY4v4WaKSzwNy3b3N'; // R2 chain (single link, fast)

// 1) usage message when no args
sent.length = 0;
await bypassController.handleBypass(sock, CHAT, SENDER, [], null, 'Tester');
assert.ok(sent.length === 1 && /LINK BYPASSER/.test(sent[0].content.text), 'usage message expected');

// 2) three successful bypasses (free limit = 3)
for (let i = 1; i <= 3; i++) {
    sent.length = 0;
    await bypassController.handleBypass(sock, CHAT, SENDER, [LINK], null, 'Tester');
    const texts = sent.map((s) => s.content.text || '');
    const edited = texts.find((t) => /BYPASS SUCCESSFUL|BYPASS FAILED/.test(t));
    assert.ok(edited, `attempt ${i}: result edit expected`);
    assert.ok(sent.length >= 2, `attempt ${i}: progress + edit messages expected`);
    if (/BYPASS SUCCESSFUL/.test(edited)) {
        assert.match(edited, /Bypasses left today/, 'footer must show remaining count');
        const remaining = Number((edited.match(/Bypasses left today: \*(\d+)\*/) || [])[1]);
        assert.equal(remaining, 3 - i, `attempt ${i}: remaining should be ${3 - i}`);
    }
}

// 3) fourth attempt hits the paywall
sent.length = 0;
await bypassController.handleBypass(sock, CHAT, SENDER, [LINK], null, 'Tester');
const limitText = sent.map((s) => s.content.text || '').find((t) => /DAILY LIMIT REACHED/.test(t));
assert.ok(limitText, 'limit-reached message expected on 4th attempt');
assert.match(limitText, /Want unlimited bypasses/, 'upsell expected in limit message');

// 4) unsupported link is rejected without consuming a credit
sent.length = 0;
const before = await bypassController.getUserBypassCount(TEST_USER);
await bypassController.handleBypass(sock, CHAT, SENDER, ['https://example.com/not-supported'], null, 'Tester');
assert.ok(/LINK BYPASSER|not a supported bypass target/.test(sent[0]?.content?.text || ''), 'unsupported/usage reply expected');
assert.equal(await bypassController.getUserBypassCount(TEST_USER), before, 'unsupported link must not consume credit');

// 5) multi-link: two links in one command resolve in parallel (credits consumed = successes)
await bypassController.bypassLimits.deleteMany({ user_id: TEST_USER });
sent.length = 0;
await bypassController.handleBypass(sock, CHAT, SENDER, [
    'https://hubcdn.wiki/file/1EQ9EwtzCY4v4WaKSzwNy3b3N',
    'https://hubcloud.ist/drive/elc6e7ce2x1yffr',
], null, 'Tester');
const multiText = sent.map((x) => x.content.text || '').find((t) => /BYPASS SUCCESSFUL|BYPASS FAILED/.test(t));
assert.ok(multiText, 'multi-link result expected');
if (/BYPASS SUCCESSFUL/.test(multiText)) {
    const used = await bypassController.getUserBypassCount(TEST_USER);
    assert.ok(used >= 1 && used <= 2, `credits consumed should be 1 or 2, got ${used}`);
    // summary line only exists when BOTH links resolved (controller prints it
    // for results.length > 1); live target may be down, so 1-of-2 is acceptable
    if (used === 2) {
        assert.match(multiText, /link\(s\) · \d+ direct links/, 'multi-link summary line expected');
    }
    assert.match(multiText, new RegExp('Bypasses left today: \\*' + (3 - used) + '\\*'), 'remaining reflects successes');
}

// cleanup test data
await bypassController.bypassLimits.deleteMany({ user_id: TEST_USER });

console.log('check-bypass: ok');
console.log('  free daily limit: 3 (MOVIE_BYPASS_DAILY_LIMIT)');
await closeMongo();
process.exit(0);

