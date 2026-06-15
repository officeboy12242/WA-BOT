/**
 * Queue Service using BullMQ + Redis
 * Falls back to in-memory queue if Redis is not available
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';

class QueueService {
    constructor() {
        this.redisConnection = null;
        this.queues = new Map();
        this.workers = new Map();
        this.isRedisAvailable = false;
        this.inMemoryQueues = new Map();
        this.inMemoryProcessors = new Map();
    }

    async initialize() {
        const redisUrl = process.env.REDIS_URL;
        
        if (!redisUrl) {
            logger.warn('⚠️ REDIS_URL not set - using in-memory queues (jobs lost on restart)');
            return false;
        }

        try {
            this.redisConnection = new IORedis(redisUrl, {
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
                retryStrategy: (times) => {
                    if (times > 3) return null;
                    return Math.min(times * 200, 1000);
                },
            });

            await new Promise((resolve, reject) => {
                this.redisConnection.on('ready', () => {
                    this.isRedisAvailable = true;
                    logger.info('✅ Redis connected - persistent queues enabled');
                    resolve();
                });
                this.redisConnection.on('error', (err) => {
                    logger.error(`Redis error: ${err.message}`);
                    reject(err);
                });
                setTimeout(() => reject(new Error('Redis connection timeout')), 5000);
            });

            return true;
        } catch (err) {
            logger.warn(`⚠️ Redis unavailable: ${err.message} - using in-memory queues`);
            this.isRedisAvailable = false;
            if (this.redisConnection) {
                this.redisConnection.disconnect();
                this.redisConnection = null;
            }
            return false;
        }
    }

    /**
     * Create a queue with a processor
     * @param {string} name - Queue name
     * @param {Function} processor - async function(job) to process jobs
     * @param {object} options - Queue options
     */
    createQueue(name, processor, options = {}) {
        const defaultOpts = {
            concurrency: 1,
            limiter: { max: 5, duration: 1000 }, // Rate limit: 5 jobs per second
            ...options,
        };

        if (this.isRedisAvailable) {
            const queue = new Queue(name, { connection: this.redisConnection });
            this.queues.set(name, queue);

            const worker = new Worker(name, processor, {
                connection: this.redisConnection,
                concurrency: defaultOpts.concurrency,
                limiter: defaultOpts.limiter,
            });

            worker.on('completed', (job) => {
                logger.debug(`✅ Job ${job.id} completed in queue ${name}`);
            });

            worker.on('failed', (job, err) => {
                logger.error(`❌ Job ${job?.id} failed in queue ${name}: ${err.message}`);
            });

            this.workers.set(name, worker);
            logger.info(`📦 BullMQ queue "${name}" created (Redis-backed)`);
        } else {
            // In-memory fallback
            this.inMemoryQueues.set(name, []);
            this.inMemoryProcessors.set(name, { processor, options: defaultOpts, processing: false });
            logger.info(`📦 In-memory queue "${name}" created`);
        }
    }

    /**
     * Add a job to the queue
     * @param {string} queueName - Queue name
     * @param {object} data - Job data
     * @param {object} opts - Job options (delay, attempts, etc)
     */
    async addJob(queueName, data, opts = {}) {
        const defaultJobOpts = {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: 50,
            ...opts,
        };

        if (this.isRedisAvailable) {
            const queue = this.queues.get(queueName);
            if (!queue) throw new Error(`Queue ${queueName} not found`);
            return await queue.add(queueName, data, defaultJobOpts);
        } else {
            // In-memory fallback
            const queueData = this.inMemoryQueues.get(queueName);
            const config = this.inMemoryProcessors.get(queueName);
            if (!queueData || !config) throw new Error(`Queue ${queueName} not found`);

            const job = { id: Date.now().toString(), data, opts: defaultJobOpts, addedAt: Date.now() };
            
            if (opts.delay) {
                // Schedule for later
                setTimeout(() => {
                    queueData.push(job);
                    this._processInMemoryQueue(queueName);
                }, opts.delay);
            } else {
                queueData.push(job);
                this._processInMemoryQueue(queueName);
            }
            
            return job;
        }
    }

    /**
     * Process in-memory queue (fallback)
     */
    async _processInMemoryQueue(queueName) {
        const queueData = this.inMemoryQueues.get(queueName);
        const config = this.inMemoryProcessors.get(queueName);
        if (!queueData || !config || config.processing) return;

        config.processing = true;

        while (queueData.length > 0) {
            const job = queueData.shift();
            try {
                await config.processor({ id: job.id, data: job.data });
            } catch (err) {
                logger.error(`❌ In-memory job ${job.id} failed: ${err.message}`);
                // Simple retry
                if ((job.attempts || 0) < (job.opts?.attempts || 3)) {
                    job.attempts = (job.attempts || 0) + 1;
                    queueData.push(job);
                }
            }
            // Rate limiting
            await new Promise(r => setTimeout(r, 200));
        }

        config.processing = false;
    }

    /**
     * Get queue stats
     */
    async getStats(queueName) {
        if (this.isRedisAvailable) {
            const queue = this.queues.get(queueName);
            if (!queue) return null;
            const [waiting, active, completed, failed] = await Promise.all([
                queue.getWaitingCount(),
                queue.getActiveCount(),
                queue.getCompletedCount(),
                queue.getFailedCount(),
            ]);
            return { waiting, active, completed, failed, redis: true };
        } else {
            const queueData = this.inMemoryQueues.get(queueName);
            return {
                waiting: queueData?.length || 0,
                active: 0,
                completed: 0,
                failed: 0,
                redis: false,
            };
        }
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        for (const [name, worker] of this.workers) {
            await worker.close();
            logger.info(`📦 Worker "${name}" closed`);
        }
        for (const [name, queue] of this.queues) {
            await queue.close();
            logger.info(`📦 Queue "${name}" closed`);
        }
        if (this.redisConnection) {
            this.redisConnection.disconnect();
            logger.info('📦 Redis disconnected');
        }
    }
}

// Singleton instance
const queueService = new QueueService();
export default queueService;
