/**
 * Self-check: per-chat queue prioritizes commands over bulk dumps,
 * and parallel enqueues from different chats don't serialize globally.
 */
import assert from 'node:assert/strict';
import { messageQueue } from '../src/utils/messageQueue.js';

const order = [];
const chat = 'concurrency-check@g.us';

await Promise.all([
    messageQueue.enqueue(chat, async () => {
        order.push('bulk');
    }, 3),
    messageQueue.enqueue(chat, async () => {
        order.push('cmd');
    }, 1),
    messageQueue.enqueue(chat, async () => {
        order.push('progress');
    }, 2),
]);

assert.deepEqual(order, ['cmd', 'progress', 'bulk'], `expected cmd→progress→bulk, got ${order}`);

let overlap = false;
let aBusy = false;
await Promise.all([
    messageQueue.enqueue('chat-a@g.us', async () => {
        aBusy = true;
        await new Promise((r) => setTimeout(r, 40));
        aBusy = false;
    }, 1),
    messageQueue.enqueue('chat-b@g.us', async () => {
        await new Promise((r) => setTimeout(r, 5));
        if (aBusy) overlap = true;
    }, 1),
]);

assert.equal(overlap, true, 'expected cross-chat sends to overlap');

messageQueue.destroy();
console.log('check-movie-concurrency: ok');
