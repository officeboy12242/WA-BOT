/**
 * Clear WhatsApp session from MongoDB (fresh QR / pairing login).
 * Usage: node scripts/clear-auth.js
 */

import { config } from '../src/config/config.js';
import { connectMongo, closeMongo } from '../src/db/mongo.js';
import AuthDatabase from '../src/models/AuthDatabase.js';
import { logger } from '../src/utils/logger.js';

async function main() {
    if (!config.MONGODB_URI) {
        console.error('MONGODB_URI is not set in .env');
        process.exit(1);
    }

    const db = await connectMongo({
        uri: config.MONGODB_URI,
        dbName: config.MONGODB_DB_NAME,
    });

    const authDb = new AuthDatabase(db);
    await authDb.init();
    const deleted = await authDb.clearAll();

    const lock = await db.collection('bot_instance_lock').deleteOne({ _id: 'singleton' });
    if (lock.deletedCount) {
        logger.info('Released bot instance lock');
    }

    authDb.close();
    await closeMongo();

    console.log(`Done — cleared ${deleted} auth record(s). Restart the bot and scan QR / pair again.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
