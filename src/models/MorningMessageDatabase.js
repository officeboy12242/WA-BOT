/**
 * Tracks sent morning messages to avoid repeats.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

function hashMessage(text) {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    return crypto.createHash('md5').update(normalized).digest('hex');
}

class MorningMessageDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.collection = null;
    }

    async init() {
        this.collection = this.mongoDb.collection('morning_messages_sent');
        await this.collection.createIndex({ hash: 1 }, { unique: true, name: 'morning_message_hash' });
        await this.collection.createIndex({ sent_at: 1 }, { name: 'morning_message_sent_at' });
        logger.info('Mongo morning message store ready');
    }

    hashMessage(text) {
        return hashMessage(text);
    }

    async getSentHashes() {
        return this.collection.distinct('hash');
    }

    async isSent(text) {
        const row = await this.collection.findOne(
            { hash: hashMessage(text) },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async markSent(text, source = 'unknown') {
        await this.collection.updateOne(
            { hash: hashMessage(text) },
            {
                $setOnInsert: {
                    hash: hashMessage(text),
                    text: text.slice(0, 400),
                    source,
                    sent_at: new Date(),
                },
            },
            { upsert: true }
        );
    }

    async cleanupOld(days = 90) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.collection.deleteMany({ sent_at: { $lt: cutoff } });
        return result.deletedCount || 0;
    }

    close() {
        this.collection = null;
    }
}

export default MorningMessageDatabase;
