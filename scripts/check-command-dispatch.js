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
const sock0 = makeCtx().sock;

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

// 3. /tgstk is admin-gated: a regular member is denied before the handler runs.
{
    const def = COMMAND_REGISTRY.find((d) => d.key === 'tgstickers');
    assert.strictEqual(def.role, 'admins', '/tgstickers must stay admin-only');
    assert.strictEqual(
        COMMAND_REGISTRY.find((d) => d.key === 'tgstop').role,
        'admins',
        '/tgstop must stay admin-only — if you cannot start an import you cannot cancel one'
    );

    for (const cmd of ['/tgstk', '/tgstickers', '/tgsticker']) {
        const { sent, sock } = makeCtx();
        await ctrl.handleCommand(sock, '123@g.us', `${cmd} SomePack`, '919000000000@s.whatsapp.net', null, 'Tester');
        const last = sent[sent.length - 1];
        assert.ok(
            last && /PERMISSION DENIED/i.test(last.text),
            `${cmd} must be denied for a non-admin (got: ${last?.text?.slice(0, 60)})`
        );
    }

    // ...and an owner/bot-admin gets through the gate (no denial message).
    const privileged = { ...fakeGroupManager, isPrivilegedAsync: async () => true };
    const owner = new CommandController(null, { isPaused: false }, privileged, null, null, null, null, null, null, null, null, null, null, null);
    const { sent, sock } = makeCtx();
    // No token configured in checks, so this stops at the config notice — the
    // point is only that it got past the permission gate.
    await owner.handleCommand(sock, '123@g.us', '/tgstk SomePack', '919000000000@s.whatsapp.net', null, 'Owner');
    assert.ok(
        !sent.some((m) => /PERMISSION DENIED/i.test(m.text)),
        'a privileged user must pass the /tgstk gate'
    );

    // /help lists by the same role field — don't advertise what they can't run.
    const { formatHelpText } = await import('../src/commands/registry.js');
    assert.ok(
        !/tgstickers/.test(formatHelpText({ isPrivileged: false })),
        '/help must hide /tgstickers from non-admins'
    );
    assert.ok(
        /tgstickers/.test(formatHelpText({ isPrivileged: true })),
        '/help must still show /tgstickers to admins'
    );
}

// 4. Unknown command gets the "did you mean" path, not a handler.
{
    const { sent, sock } = makeCtx();
    await ctrl.handleCommand(sock, '919000000000@s.whatsapp.net', '/zzzznope', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(sent.length >= 1, 'unknown command replies with suggestions');
}

// 5. /tagme & /notag: group-only for anyone — DM is denied, group gets dispatched
//    (handler replies "not available" because the fake controller has no IQ service).
{
    const tagme = COMMAND_REGISTRY.find((d) => d.key === 'tagme');
    const notag = COMMAND_REGISTRY.find((d) => d.key === 'notag');
    assert.ok(tagme && notag, '/tagme and /notag must exist in the registry');
    assert.strictEqual(tagme.scope, 'group_only', '/tagme must be group-only');
    assert.strictEqual(tagme.role, 'anyone', '/tagme must be open to all members');

    // DM → GROUPS ONLY gate, no handler run.
    const { sent: dmSent, sock: dmSock } = makeCtx();
    await ctrl.handleCommand(dmSock, '919000000000@s.whatsapp.net', '/tagme', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(
        dmSent.some((m) => /GROUPS ONLY/i.test(m.text)),
        '/tagme in a DM must be denied by the group-only gate'
    );

    // Group → reaches the handler (which answers with the no-service notice).
    const { sent: grpSent, sock: grpSock } = makeCtx();
    await ctrl.handleCommand(grpSock, '123@g.us', '/tagme', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(
        grpSent.length >= 1 && !grpSent.some((m) => /GROUPS ONLY|PERMISSION DENIED/i.test(m.text)),
        '/tagme in a group must pass the gate and dispatch'
    );

    // /notag same gate behaviour.
    const { sent: offSent, sock: offSock } = makeCtx();
    await ctrl.handleCommand(offSock, '919000000000@s.whatsapp.net', '/notag', '919000000000@s.whatsapp.net', null, 'Tester');
    assert.ok(
        offSent.some((m) => /GROUPS ONLY/i.test(m.text)),
        '/notag in a DM must be denied by the group-only gate'
    );
}

// 6. Interview Q Sunday-off default is on (scheduler skips Sun slots unless env says otherwise).
{
    const { config } = await import('../src/config/config.js');
    assert.strictEqual(
        config.INTERVIEW_Q_SKIP_SUNDAY,
        true,
        'INTERVIEW_Q_SKIP_SUNDAY must default to true (no polls on Sunday)'
    );
}

// 7. /cmdlog is owner-only: a regular member is denied before the handler runs.
{
    const def = COMMAND_REGISTRY.find((d) => d.key === 'cmdlog');
    assert.ok(def, '/cmdlog must exist in the registry');
    assert.strictEqual(def.role, 'owner', '/cmdlog must be owner-only');

    const { sent, sock } = makeCtx();
    await ctrl.handleCommand(sock, '919000000000@s.whatsapp.net', '/cmdlog', '919000000000@s.whatsapp.net', null, 'Tester');
    const last = sent[sent.length - 1];
    assert.ok(
        last && /PERMISSION DENIED|OWNER ONLY/i.test(last.text),
        '/cmdlog must be denied for a non-owner (got: ' + (last?.text?.slice(0, 60) || 'no reply') + ')'
    );
}

// 6. Command telemetry records WHO ran WHAT and WHERE.
{
    const { botTelemetry } = await import('../src/utils/botTelemetry.js');
    const before = botTelemetry.recent(50).filter((e) => e.type === 'command' && e.cmd === 'facts').length;
    await ctrl.handleCommand(sock0, '999000000000@g.us', '/facts', '919999999999@s.whatsapp.net', null, 'FactsUser');
    const ev = botTelemetry.recent(50).find((e) => e.type === 'command' && e.cmd === 'facts' && e.senderJid === '919999999999@s.whatsapp.net');
    assert.ok(ev, 'telemetry must record the command event');
    assert.strictEqual(ev.senderJid, '919999999999@s.whatsapp.net', 'telemetry must store the sender');
    assert.strictEqual(ev.pushName, 'FactsUser', 'telemetry must store the sender pushName');
    assert.strictEqual(ev.chatId, '999000000000@g.us', 'telemetry must store the chat where it ran');
    assert.strictEqual(botTelemetry.recent(50).filter((e) => e.type === 'command' && e.cmd === 'facts').length, before + 1, 'event count must increase');
}

console.log(`command dispatch ok — ${handlerKeys.length} handlers, ${registryKeys.length} registry keys, smoke tests passed`);

// The unknown-command path schedules a long auto-delete timer — exit explicitly
// so this check script never hangs on a pending timer.
process.exit(0);
