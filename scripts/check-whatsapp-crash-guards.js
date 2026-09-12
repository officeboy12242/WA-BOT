/**
 * Self-check for the crash guards in WhatsAppService's event handlers.
 *
 * Before this fix, a synchronous throw anywhere in the `messages.upsert`,
 * `messages.update`, or `group-participants.update` loop bodies would:
 *   1. Abort the REST of that batch (a `.catch()` on an async call does
 *      nothing for a plain synchronous throw earlier in the same iteration).
 *   2. Without a global process.on('uncaughtException') handler, kill the
 *      entire Node process — Koyeb then restarts the whole container.
 *
 * This does not touch the network — it registers the fake `sock.ev.on(...)`
 * handlers directly and fires them with a poisoned item mixed into a normal
 * batch, proving one bad item degrades gracefully instead of taking
 * everything (or the whole process) down with it.
 *
 * Run: node scripts/check-whatsapp-crash-guards.js
 */
import assert from 'node:assert/strict';
import WhatsAppService from '../src/services/WhatsAppService.js';

process.on('unhandledRejection', (e) => {
    console.error('✖ unhandled rejection:', e?.message || e);
    process.exit(1);
});

function makeFakeSock() {
    const handlers = {};
    return {
        handlers,
        ev: {
            on(event, cb) {
                handlers[event] = cb;
            },
            removeAllListeners() {},
        },
        sendMessage: async () => ({ key: { id: 'k' } }),
    };
}

// ── messages.upsert: one poisoned message must not stop the rest of the batch ──
{
    const commandController = {
        handleGroupParticipantsUpdate: async () => {},
        handleJoinStubMessage: async () => {},
    };
    const service = new WhatsAppService(commandController);
    const processed = [];
    // Stub the real pipeline out — this check is about the loop's crash
    // guard, not the full command-dispatch path.
    service.processIncomingMessage = async (msg) => {
        processed.push(msg.key.id);
    };
    service._cacheIncomingMessage = (msg) => {
        if (msg.__poison) throw new Error('boom: malformed message shape');
    };

    const sock = makeFakeSock();
    service.sock = sock;
    service.setupEventHandlers(async () => {});

    const poison = { key: { id: 'bad', remoteJid: '123@s.whatsapp.net' }, message: {}, __poison: true };
    const good = { key: { id: 'good', remoteJid: '456@s.whatsapp.net' }, message: { conversation: 'hi' } };

    assert.doesNotThrow(() => {
        sock.handlers['messages.upsert']({ messages: [poison, good], type: 'notify' });
    }, 'a poisoned message in the batch must not throw out of the handler');

    // Let the fire-and-forget processIncomingMessage promise settle.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(processed, ['good'], 'the good message after the poisoned one must still be processed');
    console.log('✅ messages.upsert: one poisoned message does not stop the rest of the batch');
}

// ── messages.update: same guarantee for the sticker-forward loop ───────────────
{
    const service = new WhatsAppService({
        handleGroupParticipantsUpdate: async () => {},
        handleJoinStubMessage: async () => {},
    });
    const forwarded = [];
    service.stickerForwarder = {
        shouldForwardFrom: () => true,
        forwardSticker: async (_sock, msg) => {
            forwarded.push(msg.key.id);
        },
    };

    const sock = makeFakeSock();
    service.sock = sock;
    service.setupEventHandlers(async () => {});

    // A malformed update (key is a getter that throws) must not stop the next one.
    const poison = {
        update: { message: {} },
        get key() {
            throw new Error('boom: malformed update.key');
        },
    };
    const good = {
        key: { remoteJid: '456@s.whatsapp.net', id: 'm1' },
        update: { message: { conversation: 'hi' } },
    };

    assert.doesNotThrow(() => {
        sock.handlers['messages.update']([poison, good]);
    }, 'a poisoned update in the batch must not throw out of the handler');
    console.log('✅ messages.update: one poisoned item does not stop the rest of the batch');
}

// ── group-participants.update: a throwing cache-invalidate must not crash ──────
{
    const groupManager = {
        invalidateGroupMeta: () => {
            throw new Error('boom: cache invalidation failed');
        },
    };
    const service = new WhatsAppService(
        { handleGroupParticipantsUpdate: async () => {}, handleJoinStubMessage: async () => {} },
        null,
        null,
        groupManager
    );
    const sock = makeFakeSock();
    service.sock = sock;
    service.setupEventHandlers(async () => {});

    assert.doesNotThrow(() => {
        sock.handlers['group-participants.update']({ id: 'g1@g.us', action: 'add' });
    }, 'a throwing groupManager.invalidateGroupMeta must not crash the handler');
    console.log('✅ group-participants.update: a throwing cache-invalidate does not crash the handler');
}

console.log('✅ check-whatsapp-crash-guards passed');
process.exit(0);
