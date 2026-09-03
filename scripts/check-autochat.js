/**
 * Self-check for the /autochat daily open/close chat feature.
 *
 * Offline only: registry wiring, handler presence, help gating, message
 * formatting, and controller defaults. Never touches WhatsApp or an LLM.
 *
 * Run: node scripts/check-autochat.js
 */
import assert from 'node:assert';
import { findCommand, helpCategoryOf, formatHelpText } from '../src/commands/registry.js';
import { COMMAND_HANDLERS } from '../src/controllers/CommandController.js';
import AutoChatController, {
    AUTOCHAT_KIND_OPEN,
    AUTOCHAT_KIND_CLOSE,
    parseClockTime,
    formatClockLabel,
    sanitizeGeneratedText,
    buildFallbackMessage,
} from '../src/controllers/AutoChatController.js';

/* ── registry & dispatch wiring ─────────────────────────────────────────── */

const def = findCommand('/autochat');
assert.ok(def, '/autochat must be in the command registry');
assert.strictEqual(def.key, 'autochat');
assert.strictEqual(def.scope, 'group_only', '/autochat is a group toggle');
assert.strictEqual(def.role, 'staff', '/autochat must be staff-only like the other group toggles');
assert.ok(def.help, '/autochat needs a /help line');
assert.ok(COMMAND_HANDLERS.autochat, 'COMMAND_HANDLERS must dispatch /autochat');
assert.strictEqual(helpCategoryOf(def), 'group', '/autochat belongs in the GROUP SETUP help section');

// /help shows it to staff in a group and hides it from regular members.
assert.ok(/autochat/.test(formatHelpText({ isStaff: true })), 'staff must see /autochat in /help');
assert.ok(!/autochat/.test(formatHelpText({ isStaff: false })), 'non-staff must not see /autochat in /help');

/* ── time parsing / labels ──────────────────────────────────────────────── */

assert.deepStrictEqual(parseClockTime('09:00'), { hour: 9, minute: 0, minutes: 540 });
assert.strictEqual(parseClockTime('not-a-time'), null);
assert.strictEqual(formatClockLabel('09:00'), '9:00 AM');
assert.strictEqual(formatClockLabel('23:55'), '11:55 PM');
assert.strictEqual(formatClockLabel('00:05'), '12:05 AM');

/* ── LLM text sanitizing ────────────────────────────────────────────────── */

assert.strictEqual(
    sanitizeGeneratedText('```text\n🌅 Good morning, GitHub Projects! ☀️\n```'),
    '🌅 Good morning, GitHub Projects! ☀️'
);
assert.strictEqual(sanitizeGeneratedText('Here is your message: 👋 hello'), '👋 hello');
assert.strictEqual(sanitizeGeneratedText('   '), '');
assert.ok(sanitizeGeneratedText('a'.repeat(700)).length <= 600, 'generated text must be length-capped');

/* ── fallback messages (no LLM configured) ─────────────────────────────── */

const meta = { subject: 'GitHub Projects', desc: 'Daily trending repos, open source talk and dev discussions.' };
const openMsg = buildFallbackMessage(AUTOCHAT_KIND_OPEN, meta, { openLabel: '9:00 AM' });
assert.ok(openMsg.includes('*OPEN*'), 'opening message announces the chat is open');
assert.ok(openMsg.includes('GitHub Projects'), 'opening message names the group');
assert.ok(openMsg.length < 400, 'opening message stays short');
const closeMsg = buildFallbackMessage(AUTOCHAT_KIND_CLOSE, meta, { openLabel: '9:00 AM' });
assert.ok(/Good night/.test(closeMsg), 'closing message says good night');
assert.ok(closeMsg.includes('9:00 AM'), 'closing message says when the chat reopens');

/* ── controller defaults with a bare config (no LLM keys, no mongo) ────── */

const ctl = new AutoChatController(
    { getAutoChatEnabledGroups: async () => [] },
    {}
);
assert.strictEqual(ctl.enabled, true, 'AUTOCHAT_ENABLED defaults to true');
assert.strictEqual(ctl.openLabel, '9:00 AM');
assert.strictEqual(ctl.closeLabel, '11:55 PM');
assert.strictEqual(ctl.openTime.minutes, 9 * 60);
assert.strictEqual(ctl.closeTime.minutes, 23 * 60 + 55);
// LLM services fall back to process.env keys when the config object lacks them,
// so availability depends on the running env — nothing to assert offline.

/* ── open/close flow with a mock sock (LLM stubbed → fallback text) ────── */
{
    const calls = [];
    const sock = {
        groupSettingUpdate: async (jid, mode) => calls.push(['mode', mode]),
        sendMessage: async (jid, content) => calls.push(['msg', content.text]),
    };
    const meta = {
        announce: true,
        subject: 'GitHub Projects',
        desc: 'Daily trending repos and open source talk.',
    };
    const flow = new AutoChatController(
        {
            getGroupMetadataCached: async () => meta,
            getAutoChatEnabledGroups: async () => [],
        },
        {}
    );
    flow._announceText = async () => ''; // keep the check fully offline

    await flow.openChat(sock, '120363000000000000@g.us');
    const openMsg = calls.find(([k]) => k === 'msg');
    assert.ok(
        calls.some(([k, m]) => k === 'mode' && m === 'not_announcement'),
        'opening a locked group must unlock it (not_announcement)'
    );
    assert.ok(openMsg && /OPEN/.test(openMsg[1]), 'opening a locked group posts the greeting');

    calls.length = 0;
    meta.announce = false; // now open — close must lock it
    await flow.closeChat(sock, '120363000000000000@g.us', { silent: true });
    assert.ok(
        calls.some(([k, m]) => k === 'mode' && m === 'announcement'),
        'closing an open group must lock it (announcement)'
    );
    assert.ok(!calls.some(([k]) => k === 'msg'), 'silent close must not post a message');

    calls.length = 0;
    meta.announce = true; // already locked — no redundant setting call, message still posts
    await flow.closeChat(sock, '120363000000000000@g.us', { silent: false });
    assert.ok(
        !calls.some(([k]) => k === 'mode'),
        'close must not re-toggle an already-locked group'
    );
    assert.ok(calls.some(([k, t]) => k === 'msg' && /Good night/.test(t)), 'close posts a good-night note');
}

console.log('autochat ok — registry, dispatch, help gating, formatting, controller defaults');
process.exit(0);
