/**
 * Self-check: Mongo job outbox enqueue/claim/complete + dedupe.
 * Run: node scripts/check-job-queue.js
 */
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { MongoJobQueue } from '../src/jobs/mongoJobQueue.js';
import { startMongoJobWorker } from '../src/jobs/mongoJobWorker.js';

function fakeDb() {
    const docs = [];
    const col = {
        async createIndex() {},
        async insertOne(doc) {
            const _id = new ObjectId();
            docs.push({ ...doc, _id });
            return { insertedId: _id };
        },
        async findOne(filter) {
            return (
                docs.find((d) => {
                    if (filter.jobKey && d.jobKey !== filter.jobKey) return false;
                    if (filter.status?.$in && !filter.status.$in.includes(d.status)) return false;
                    return true;
                }) || null
            );
        },
        async findOneAndUpdate(_filter, _update, opts) {
            const now = new Date();
            const doc = docs
                .filter((d) => d.status === 'pending' && d.runAt <= now)
                .sort((a, b) => a.runAt - b.runAt)[0];
            if (!doc) return null;
            doc.status = 'running';
            doc.lockedAt = now;
            doc.attempts = (doc.attempts || 0) + 1;
            return opts?.returnDocument === 'after' ? doc : doc;
        },
        async updateOne(filter, update) {
            const id = String(filter._id);
            const doc = docs.find((d) => String(d._id) === id);
            if (!doc) return { matchedCount: 0 };
            Object.assign(doc, update.$set || {});
            return { matchedCount: 1 };
        },
        async countDocuments(filter) {
            return docs.filter((d) => d.status === filter.status).length;
        },
    };
    return {
        collection() {
            return col;
        },
    };
}

const queue = new MongoJobQueue(fakeDb());
await queue.init();

const id = await queue.enqueue('news.scrape', { n: 1 }, { jobKey: 'news.scrape' });
const again = await queue.enqueue('news.scrape', { n: 2 }, { jobKey: 'news.scrape' });
assert.equal(id, again);

let handled = 0;
const worker = startMongoJobWorker({
    queue,
    concurrency: 1,
    pollMs: 40,
    handlers: {
        'news.scrape': async () => {
            handled += 1;
        },
    },
});

await new Promise((r) => setTimeout(r, 250));
worker.stop();
assert.equal(handled, 1);

const stats = await queue.stats();
assert.equal(stats.pending, 0);
assert.equal(stats.driver, 'mongo');

console.log('OK job queue mongo outbox');
