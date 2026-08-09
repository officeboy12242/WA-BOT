/**
 * Paced, resumable, opt-out-aware broadcast sender.
 *
 * The previous loop sent every 3500ms exactly, forever, with no cap and no
 * memory. Three things were wrong with that:
 *
 *  1. Perfectly uniform spacing is itself a machine signature. Nobody sends a
 *     message every 3.500 seconds for twenty minutes.
 *  2. No daily ceiling, so one command could fire hundreds of cold DMs in an
 *     hour — the exact shape bulk detection looks for.
 *  3. No persistence, so a restart mid-run either lost the remainder or, if
 *     re-issued, messaged the first half of the list twice.
 *
 * None of this is evasion. Recipient reports and blocks are what actually get
 * an account limited, so the levers that matter are sending FEWER messages, to
 * people who have not opted out, at a pace a person could plausibly type at.
 */

import { logger } from '../utils/logger.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';

/** Conservative defaults — roughly 150 DMs/day. */
export const BROADCAST_DEFAULTS = {
    minGapMs: 8_000,
    maxGapMs: 25_000,
    batchSize: 20,
    batchPauseMinMs: 2 * 60_000,
    batchPauseMaxMs: 5 * 60_000,
    dailyCap: 150,
    /** Abort if this share of a meaningful sample fails — usually means throttling. */
    failureRateAbort: 0.15,
    failureSampleMin: 12,
};

export const BROADCAST_STATUS = {
    RUNNING: 'RUNNING',
    PAUSED_CAP: 'PAUSED_CAP',
    DONE: 'DONE',
    ABORTED: 'ABORTED',
    FAILED: 'FAILED',
};

function jitter(min, max) {
    return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Appended so every recipient has a one-tap way out. */
export function withOptOutFooter(message, footer = '_Reply STOP to never receive these._') {
    const body = String(message || '').trimEnd();
    if (/\bstop\b/i.test(body.slice(-120))) return body; // already says it
    return `${body}\n\n${footer}`;
}

class BroadcastService {
    /**
     * @param {object|null} mongoDb
     * @param {import('../models/BroadcastOptOutStore.js').default|null} optOutStore
     * @param {object} config
     */
    constructor(mongoDb = null, optOutStore = null, config = {}) {
        this.jobs = mongoDb ? mongoDb.collection('broadcast_jobs') : null;
        this.optOut = optOutStore;
        this.opts = {
            ...BROADCAST_DEFAULTS,
            minGapMs: Number(config.BROADCAST_MIN_GAP_MS) || BROADCAST_DEFAULTS.minGapMs,
            maxGapMs: Number(config.BROADCAST_MAX_GAP_MS) || BROADCAST_DEFAULTS.maxGapMs,
            batchSize: Number(config.BROADCAST_BATCH_SIZE) || BROADCAST_DEFAULTS.batchSize,
            dailyCap: Number(config.BROADCAST_DAILY_CAP) || BROADCAST_DEFAULTS.dailyCap,
        };
        this._aborting = new Set();
    }

    async init() {
        if (!this.jobs) return;
        await this.jobs.createIndex({ status: 1 }, { name: 'broadcast_jobs_status' });
        await this.jobs.createIndex({ created_at: -1 }, { name: 'broadcast_jobs_created' });
    }

    /** DMs already sent today, across every job. The cap is per account, not per job. */
    async sentToday() {
        if (!this.jobs) return 0;
        const rows = await this.jobs
            .find({ 'daily.date': getTodayDateStrIST() }, { projection: { daily: 1 } })
            .toArray();
        return rows.reduce((sum, r) => sum + (r.daily?.count || 0), 0);
    }

    async remainingToday() {
        return Math.max(0, this.opts.dailyCap - (await this.sentToday()));
    }

    /**
     * Persist a job so a restart resumes instead of re-sending from the top.
     * @returns {Promise<string>} job id
     */
    async createJob({ label, message, targets, chatId }) {
        const id = `bc_${Date.now().toString(36)}`;
        if (this.jobs) {
            await this.jobs.insertOne({
                _id: id,
                label,
                message,
                chat_id: chatId,
                targets,
                cursor: 0,
                sent: 0,
                failed: 0,
                skipped_opt_out: 0,
                status: BROADCAST_STATUS.RUNNING,
                daily: { date: getTodayDateStrIST(), count: 0 },
                created_at: new Date(),
                updated_at: new Date(),
            });
        }
        return id;
    }

    async getJob(id) {
        return this.jobs ? this.jobs.findOne({ _id: id }) : null;
    }

    /** Jobs interrupted by a restart. */
    async findResumable() {
        if (!this.jobs) return [];
        return this.jobs
            .find({ status: { $in: [BROADCAST_STATUS.RUNNING, BROADCAST_STATUS.PAUSED_CAP] } })
            .toArray();
    }

    abort(id) {
        this._aborting.add(id);
    }

    isAborting(id) {
        return this._aborting.has(id);
    }

    async _patch(id, patch) {
        if (!this.jobs) return;
        await this.jobs.updateOne({ _id: id }, { $set: { ...patch, updated_at: new Date() } });
    }

    /**
     * Send one DM. Retries ONLY on a real failure.
     *
     * The old version pre-guessed whether a privacy token existed and, if it
     * thought not, sent the message a second time six seconds later. That
     * guess is inferred from auth-store keys and is often wrong, so a large
     * share of recipients got the same DM twice — which is the fastest way to
     * collect spam reports.
     */
    async _sendOnce(sock, jid, message) {
        try {
            await sock.sendMessage(jid, { text: message });
            return { ok: true, retried: false };
        } catch (err) {
            const msg = String(err?.message || err);
            // 463 = missing privacy token; Baileys issues one in the background.
            const recoverable = /463|tctoken|privacy.?token|no.?session/i.test(msg);
            if (!recoverable) return { ok: false, retried: false, error: msg };

            await sleep(6_000);
            try {
                await sock.sendMessage(jid, { text: message });
                return { ok: true, retried: true };
            } catch (err2) {
                return { ok: false, retried: true, error: String(err2?.message || err2) };
            }
        }
    }

    /**
     * Run (or resume) a broadcast.
     *
     * @param {object} o
     * @param {() => object|null} o.getSock
     * @param {string} o.jobId
     * @param {(update: object) => void} [o.onProgress]
     * @returns {Promise<object>} final job state
     */
    async run({ getSock, jobId, onProgress = null }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Broadcast job ${jobId} not found`);

        const { targets, message } = job;
        let { cursor, sent, failed } = job;
        let skippedOptOut = job.skipped_opt_out || 0;
        let daily = job.daily?.date === getTodayDateStrIST() ? job.daily : { date: getTodayDateStrIST(), count: 0 };
        let consecutiveFailures = 0;
        let attempted = 0;

        const finish = async (status, note = null) => {
            this._aborting.delete(jobId);
            await this._patch(jobId, { status, cursor, sent, failed, skipped_opt_out: skippedOptOut, daily, note });
            logger.info(`📤 Broadcast ${jobId} ${status}: sent=${sent} failed=${failed} optOut=${skippedOptOut} of ${targets.length}`);
            return { ...job, status, cursor, sent, failed, skipped_opt_out: skippedOptOut, note };
        };

        while (cursor < targets.length) {
            if (this.isAborting(jobId)) return finish(BROADCAST_STATUS.ABORTED, 'stopped by owner');

            // Account-wide daily ceiling — resume tomorrow rather than push through.
            if (daily.date !== getTodayDateStrIST()) daily = { date: getTodayDateStrIST(), count: 0 };
            const alreadyToday = await this.sentToday();
            if (alreadyToday >= this.opts.dailyCap) {
                return finish(BROADCAST_STATUS.PAUSED_CAP, `daily cap ${this.opts.dailyCap} reached`);
            }

            const sock = getSock?.();
            if (!sock) return finish(BROADCAST_STATUS.PAUSED_CAP, 'WhatsApp disconnected — will resume');

            const jid = targets[cursor];

            if (this.optOut?.isOptedOut(jid)) {
                skippedOptOut += 1;
                cursor += 1;
                await this._patch(jobId, { cursor, skipped_opt_out: skippedOptOut });
                continue;
            }

            const res = await this._sendOnce(sock, jid, message);
            attempted += 1;
            if (res.ok) {
                sent += 1;
                daily.count += 1;
                consecutiveFailures = 0;
            } else {
                failed += 1;
                consecutiveFailures += 1;
                logger.warn(`Broadcast ${jobId} failed for ${jid}: ${res.error}`);
            }

            cursor += 1;
            await this._patch(jobId, { cursor, sent, failed, daily });
            onProgress?.({ sent, failed, skippedOptOut, cursor, total: targets.length });

            // A failure spike almost always means we are already being throttled.
            // Pushing on from here is how a limit becomes a ban.
            if (
                attempted >= this.opts.failureSampleMin &&
                failed / attempted > this.opts.failureRateAbort
            ) {
                return finish(
                    BROADCAST_STATUS.FAILED,
                    `stopped: ${Math.round((failed / attempted) * 100)}% of sends failing — likely rate limited`
                );
            }
            if (consecutiveFailures >= 5) {
                return finish(BROADCAST_STATUS.FAILED, '5 consecutive failures — stopped');
            }

            if (cursor >= targets.length) break;

            // Pause between batches, then jittered gaps within one.
            if (sent > 0 && sent % this.opts.batchSize === 0) {
                const pause = jitter(this.opts.batchPauseMinMs, this.opts.batchPauseMaxMs);
                logger.info(`📤 Broadcast ${jobId}: batch of ${this.opts.batchSize} done, pausing ${Math.round(pause / 1000)}s`);
                await sleep(pause);
            } else {
                await sleep(jitter(this.opts.minGapMs, this.opts.maxGapMs));
            }
        }

        return finish(BROADCAST_STATUS.DONE);
    }

    /** Human summary for the owner. */
    formatJobSummary(job, { label = null } = {}) {
        const total = job.targets?.length ?? 0;
        const lines = [
            `📤 *Broadcast ${job.status}*${label ? ` — ${label}` : ''}`,
            '',
            `✅ Sent: *${job.sent}*`,
            `❌ Failed: *${job.failed}*`,
        ];
        if (job.skipped_opt_out) lines.push(`🚫 Skipped (opted out): *${job.skipped_opt_out}*`);
        const left = total - (job.cursor ?? 0);
        if (left > 0) lines.push(`⏳ Remaining: *${left}*`);
        if (job.note) lines.push('', `_${job.note}_`);
        if (job.status === BROADCAST_STATUS.PAUSED_CAP) {
            lines.push('_Resumes automatically — run `/broadcast resume` or wait for tomorrow._');
        }
        return lines.join('\n');
    }
}

export function createBroadcastService(mongoDb, optOutStore, config) {
    return new BroadcastService(mongoDb, optOutStore, config);
}

export default BroadcastService;
