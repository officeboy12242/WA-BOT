/**
 * Optional job worker entry — Redis/BullMQ or Mongo outbox without WhatsApp.
 * Handles scrape-only jobs. Trade daily alerts need the main bot process (sock).
 *
 *   REDIS_URL=... node worker.js
 *   node worker.js   # Mongo outbox
 */
import { config } from './src/config/config.js';
import { connectMongo, closeMongo } from './src/db/mongo.js';
import { logger } from './src/utils/logger.js';
import { createJobQueue, startJobRuntime } from './src/jobs/index.js';
import NewsDatabase from './src/models/NewsDatabase.js';
import InshortsScraper from './src/services/InshortsScraper.js';
import NewsController from './src/controllers/NewsController.js';
import GroupManager from './src/models/GroupManager.js';

async function main() {
    logger.info('🧰 Starting job worker…');
    const mongoDb = await connectMongo({
        uri: config.MONGODB_URI,
        dbName: config.MONGODB_DB_NAME,
    });

    const newsDatabase = new NewsDatabase(mongoDb);
    const groupManager = new GroupManager(mongoDb);
    await Promise.all([newsDatabase.init(), groupManager.init()]);

    const newsController = new NewsController(
        newsDatabase,
        new InshortsScraper(newsDatabase),
        config,
        groupManager
    );

    const queue = await createJobQueue(mongoDb);
    const runtime = startJobRuntime({
        queue,
        concurrency: config.JOB_WORKER_CONCURRENCY,
        handlers: {
            'news.scrape': async () => {
                await newsController.scrapeAndQueueOnly();
            },
            'trade.daily_alerts': async () => {
                throw new Error(
                    'trade.daily_alerts requires WhatsApp sock — run in bot-new.js, not worker.js'
                );
            },
        },
    });

    const shutdown = async (signal) => {
        logger.info(`Worker stopping (${signal})…`);
        if (runtime?.stop) await Promise.resolve(runtime.stop()).catch(() => {});
        if (queue?.close) await queue.close().catch(() => {});
        await closeMongo().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    logger.info(
        `Worker ready · driver=${queue.kind} · concurrency=${config.JOB_WORKER_CONCURRENCY}`
    );
}

main().catch((err) => {
    logger.error(`Worker failed: ${err.message}`);
    process.exit(1);
});
