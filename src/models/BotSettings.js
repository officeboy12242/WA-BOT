/**
 * Persistent bot settings (survives redeploy/restart)
 */

import { logger } from '../utils/logger.js';

class BotSettings {
    constructor(mongoDb) {
        this.collection = mongoDb.collection('bot_settings');
    }

    async init() {
        await this.collection.createIndex({ key: 1 }, { unique: true, name: 'bot_settings_key' });
        logger.info('Mongo bot settings store ready');
    }

    async getCoursesPaused() {
        const doc = await this.collection.findOne({ key: 'courses_paused' });
        return Boolean(doc?.value);
    }

    async setCoursesPaused(paused) {
        await this.collection.updateOne(
            { key: 'courses_paused' },
            {
                $set: {
                    key: 'courses_paused',
                    value: Boolean(paused),
                    updated_at: new Date(),
                },
            },
            { upsert: true }
        );
    }
}

export default BotSettings;
