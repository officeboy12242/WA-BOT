/**
 * Self-check for data-driven command dispatch.
 *
 * 1. Every key in COMMAND_REGISTRY must have a handler in COMMAND_HANDLERS
 *    (and vice-versa) — a registered-but-unwired command must never silently
 *    no-op.
 * 2. A live smoke test drives CommandController.handleCommand end-to-end:
 *    /help dispatches and sends, a group-only command is gated by access, and
 *    an unknown command gets suggestions.
 *
 * Run: node scripts/check-command-dispatch.js
 */
import assert from 'node:assert';
import { COMMAND_REGISTRY } from '../src/commands/registry.js';
import CommandController, { COMMAND_HANDLERS } from '../src/controllers/CommandController.js';

const registryKeys = COMMAND_REGISTRY.map((d) => d.key);

const missing = registryKeys.filter((k) => !COMMAND_HANDLERS[k]);
assert.strictEqual(
    missing.length,
    0,
    `registry keys with no handler: ${missing.join(', ')}`
);

const handlerKeys = Object.keys(COMMAND_HANDLERS);
const known = new Set(registryKeys);
const phantom = handlerKeys.filter((k) => !known.has(k));
assert.strictEqual(
    phantom.length,
    0,
    `handlers for unknown keys: ${phantom.join(', ')}`
);

/* ── live dispatch smoke test ─────────────────────────────────────────────── */

const fakeGroupManager = {
    isOwner: () => false,
    isModerator: () => false,
    isDynamicModerator: async () => false,
    isBotAdmin: async () => false,
    resolveParticipantPhoneCached: async () => '',
    isStaffAsync: async () => false,
    isPrivilegedAsync: async () => false,
    canManageBotAdminsAsync: async () => false,
    isSenderGroupAdminAsync: async () => false,
    isGroupActive: async () => true,
    isMovieEnabled: async () => false,
    isWeeklyTrendingEnabled: async () => false,
};

function makeCtx() {
    const sent = [];
    const sock = {
        sendMessage: async (jid, content) => {
            sent.push({ jid, text: content?.text || '' });
            return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
        },
    };
    return { sent, sock };
}

const ctrl = new CommandController(null, { isPaused: false }, fakeGroupManager, null, null, null, null, null, null, null, null, null, null, null);

// 1. /help in a DM dispatches and actually sends something.
{
    const { sent, sock } = makeCtx();
    await ctrl.handleCommand(sock, '919000000000@s.whatsapp.net', '/help', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(sent.length >= 1, '/help should send the command guide');
}

// 2. /dellast in a group as a non-admin is gated BEFORE dispatch (scope + role).
{
    const { sent, sock } = makeCtx();
    await ctrl.handleCommand(sock, '123@g.us', '/dellast', '919000000000@s.whatsapp.net', null, 'Tester');
    const last = sent[sent.length - 1];
    assert.ok(last && /PERMISSION DENIED/i.test(last.text), 'group-only admin command is denied for a regular member');
}

// 3. Unknown command gets the "did you mean" path, not a handler.
{
    const { sent, sock } = makeCtx();
    await ctrl.handleCommand(sock, '919000000000@s.whatsapp.net', '/zzzznope', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(sent.length >= 1, 'unknown command replies with suggestions');
}

console.log(`command dispatch ok — ${handlerKeys.length} handlers, ${registryKeys.length} registry keys, smoke tests passed`);

// The unknown-command path schedules a long auto-delete timer — exit explicitly
// so this check script never hangs on a pending timer.
process.exit(0);
