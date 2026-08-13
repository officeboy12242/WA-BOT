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

import { deliverMessage, createDeliveryVerifier } from '../utils/waMessage.js';
import { logger } from '../utils/logger.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';
import SendPacingService from './SendPacingService.js';

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
    /** Skip recipients this account already DM'd (0 = ever, else within N days). */
    skipMessaged: true,
    remessageDays: 0,
    /** Prefix broadcasts with the recipient's first name when we know it. */
    personalize: true,
    /** Delivery-rate soft-ban guard: pause when deliveries fall below this over a window. */
    deliveryFloor: 0.6,
    deliveryWindow: 20,
    deliveryCooldownMs: 15 * 60 * 1000,
    /** WhatsApp Business-style broadcast byline shown in every DM footer. */
    byline: 'Sassy Bot',
};

export const BROADCAST_STATUS = {
    RUNNING: 'RUNNING',
    PAUSED_CAP: 'PAUSED_CAP',
    DONE: 'DONE',
    ABORTED: 'ABORTED',
    FAILED: 'FAILED',
};

/**
 * Window to observe the server's verdict on a send. sendMessage resolves on
 * socket write; failures like the 463 privacy-token drop arrive afterwards as
 * an async messages.update with status ERROR, usually within a second or two.
 */
const SEND_VERIFY_MS = 4_000;
/** Give Baileys time to issue the recipient's privacy token after a 463 drop. */
const TOKEN_ISSUE_WAIT_MS = 6_000;

function jitter(min, max) {
    return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stable per-number key for pacing state. The bot's own JID (e.g.
 * 917887499710:7@s.whatsapp.net) becomes 917887499710; swapping the number
 * yields a new key, which is exactly what a fresh warm-up ramp needs.
 */
export function resolveAccountJid(sock) {
    const id = sock?.user?.id || sock?.authState?.creds?.me?.id;
    if (!id) return 'default';
    return String(id).split(':')[0];
}

/**
 * Appended so every recipient has a one-tap way out. The default footer is a
 * WhatsApp Business-style broadcast byline styled like the /ping terminal card
 * ("\> "-prefixed rows, bold value) — "This is a broadcast message by <bot>"
 * followed by the opt-out line. Pass an explicit `footer` to override both
 * lines entirely.
 */
export function withOptOutFooter(message, footer = null, byline = BROADCAST_DEFAULTS.byline) {
    const body = String(message || '').trimEnd();
    if (/\bstop\b/i.test(body.slice(-120))) return body; // already says it
    if (footer === null) {
        footer = `> 📣 This is a broadcast message by *${byline}*\n> 🚫 Reply STOP to never receive these`;
    }
    return `${body}\n\n${footer}`;
}

class BroadcastService {
    /**
     * @param {object|null} mongoDb
     * @param {import('../models/BroadcastOptOutStore.js').default|null} optOutStore
     * @param {object} config
     */
    constructor(mongoDb = null, optOutStore = null, config = {}, pacing = null) {
        this.jobs = mongoDb ? mongoDb.collection('broadcast_jobs') : null;
        this.optOut = optOutStore;
        this.pacing = pacing;
        this.opts = {
            ...BROADCAST_DEFAULTS,
            minGapMs: Number(config.BROADCAST_MIN_GAP_MS) || BROADCAST_DEFAULTS.minGapMs,
            maxGapMs: Number(config.BROADCAST_MAX_GAP_MS) || BROADCAST_DEFAULTS.maxGapMs,
            batchSize: Number(config.BROADCAST_BATCH_SIZE) || BROADCAST_DEFAULTS.batchSize,
            dailyCap: Number(config.BROADCAST_DAILY_CAP) || BROADCAST_DEFAULTS.dailyCap,
            skipMessaged: config.BROADCAST_SKIP_MESSAGED !== false && String(config.BROADCAST_SKIP_MESSAGED ?? 'true') !== 'false',
            remessageDays: Math.max(0, parseInt(config.BROADCAST_REMESSAGE_DAYS, 10) || 0),
            personalize: config.BROADCAST_PERSONALIZE !== false && String(config.BROADCAST_PERSONALIZE ?? 'true') !== 'false',
            deliveryFloor: Math.max(0, Math.min(1, Number(config.BROADCAST_DELIVERY_FLOOR) || BROADCAST_DEFAULTS.deliveryFloor)),
            deliveryWindow: Math.max(5, parseInt(config.BROADCAST_DELIVERY_WINDOW, 10) || BROADCAST_DEFAULTS.deliveryWindow),
            deliveryCooldownMs: Math.max(60_000, parseInt(config.BROADCAST_DELIVERY_COOLDOWN_MS, 10) || BROADCAST_DEFAULTS.deliveryCooldownMs),
            byline: String(config.BROADCAST_BYLINE || '').trim() || BROADCAST_DEFAULTS.byline,
        };
        this._aborting = new Set();
    }

    async init() {
        if (!this.jobs) return;
        await this.jobs.createIndex({ status: 1 }, { name: 'broadcast_jobs_status' });
        await this.jobs.createIndex({ created_at: -1 }, { name: 'broadcast_jobs_created' });
        await this.pacing?.init?.();
    }

    /** DMs already sent today, across every job. The cap is per account, not per job. */
    async sentToday() {
        if (!this.jobs) return 0;
        const rows = await this.jobs
            .find({ 'daily.date': getTodayDateStrIST() }, { projection: { daily: 1 } })
            .toArray();
        return rows.reduce((sum, r) => sum + (r.daily?.count || 0), 0);
    }

    /**
     * Sends left today — the smaller of the hard BROADCAST_DAILY_CAP and the
     * warm-up ramp's allowance for the account's age. Pass the account JID to
     * include the ramp; without it only the hard cap applies.
     */
    async remainingToday(accountJid = null) {
        const sent = await this.sentToday();
        const hardLeft = Math.max(0, this.opts.dailyCap - sent);
        if (!this.pacing?.enabled || !accountJid) return hardLeft;
        try {
            const info = await this.pacing.accountDayInfo(accountJid);
            return Math.max(0, Math.min(hardLeft, info.warmupAllowance - sent));
        } catch {
            return hardLeft;
        }
    }

    /**
     * Persist a job so a restart resumes instead of re-sending from the top.
     * @param {object} o
     * @param {object|null} [o.names] jid -> first name for personalization
     * @returns {Promise<string>} job id
     */
    async createJob({ label, message, targets, chatId, names = null }) {
        const id = `bc_${Date.now().toString(36)}`;
        if (this.jobs) {
            await this.jobs.insertOne({
                _id: id,
                label,
                message,
                chat_id: chatId,
                targets,
                names,
                cursor: 0,
                sent: 0,
                failed: 0,
                skipped_opt_out: 0,
                skipped_unreachable: 0,
                skipped_messaged: 0,
                delivery_paused_until: null,
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
     * 'present' | 'absent' | null (null = auth store unreadable).
     * The privacy token (tctoken) is cached under the recipient's LID (or
     * phone JID) in the auth store; Baileys issues it after a 463 drop.
     */
    async _privacyTokenState(sock, jid) {
        try {
            const mapping = sock?.signalRepository?.lidMapping;
            const lid = mapping?.getLIDForPN ? await mapping.getLIDForPN(jid) : null;
            const keys = [jid, lid].filter(Boolean);
            const data = await sock?.authState?.keys?.get?.('tctoken', keys);
            if (!data) return 'absent';
            return keys.some((k) => data[k]?.token?.length > 0) ? 'present' : 'absent';
        } catch {
            return null;
        }
    }

    /**
     * Pre-flight sample: how many of these JIDs already carry a cached privacy
     * token (tctoken). Recipients without one are still deliverable — the
     * token is issued on the first attempt — but knowing the split up front
     * turns "will they get it?" into a number before the daily cap is spent.
     * @returns {Promise<{ sampled: number, withToken: number, noToken: number, unreadable: number }>}
     */
    async sampleDmReadiness(sock, jids = [], limit = 10) {
        const sample = (jids || []).slice(0, limit);
        const out = { sampled: sample.length, withToken: 0, noToken: 0, unreadable: 0 };
        for (const jid of sample) {
            const state = await this._privacyTokenState(sock, jid);
            if (state === 'present') out.withToken += 1;
            else if (state === 'absent') out.noToken += 1;
            else out.unreadable += 1;
        }
        return out;
    }

    /**
     * Wait for the 463-triggered token issuance to land in the auth store so
     * the retry actually carries the token. Falls back to a blind grace wait
     * when the store can't be inspected.
     */
    async _waitForPrivacyToken(sock, jid) {
        const deadline = Date.now() + TOKEN_ISSUE_WAIT_MS;
        let readable = true;
        while (Date.now() < deadline) {
            const state = await this._privacyTokenState(sock, jid);
            if (state === 'present') return true;
            if (state === null) {
                readable = false;
                break;
            }
            await sleep(1000);
        }
        if (!readable) await sleep(TOKEN_ISSUE_WAIT_MS);
        return false;
    }

    /**
     * Personalize a broadcast message with the recipient's first name, keeping
     * the opt-out footer last. Unknown/short names send the plain message.
     */
    personalizeFor(message, name = null) {
        const first = String(name || '').trim().split(/\s+/)[0];
        if (!this.opts.personalize || !first || first.length < 2 || /^\d+$/.test(first)) return message;
        return `Hi ${first},\n\n${message}`;
    }

    /**
     * Send one DM. Retries ONLY on a real failure.
     *
     * sendMessage resolves once the stanza is written to the socket — it does
     * NOT mean the recipient got it. Cold DMs to people who never messaged the
     * bot are often dropped by the server with error 463 (missing privacy
     * token), which arrives ASYNC as a messages.update status ERROR after the
     * promise already resolved — so the old code counted those as sent and its
     * catch-block retry never fired. `verifier` (from createDeliveryVerifier)
     * bridges that gap:
     *
     *  - server reports ERROR on the first send → wait for the token to be
     *    issued, retry ONCE, and verify the retry too;
     *  - retry also dropped → { ok: false, permanent: true } — the recipient
     *    blocks DMs entirely; counted separately, never as "sent".
     *
     * Sends flow through the shared deliverMessage pipeline (queue, timeout,
     * quote policy).
     */
    async _sendOnce(sock, jid, message, verifier = null) {
        try {
            const { outcome } = await deliverMessage(sock, jid, { text: message }, {
                verifier,
                verifyWaitMs: SEND_VERIFY_MS,
                typing: true,
            });
            if (verifier && outcome === 'ERROR') {
                logger.info(`Broadcast: ${jid} dropped by server (missing privacy token) — waiting for token, retrying`);
                await this._waitForPrivacyToken(sock, jid);
                try {
                    const retry = await deliverMessage(sock, jid, { text: message }, {
                        verifier,
                        verifyWaitMs: SEND_VERIFY_MS,
                        typing: true,
                    });
                    if (retry.outcome === 'ERROR') {
                        return {
                            ok: false,
                            retried: true,
                            permanent: true,
                            error: 'still dropped after privacy token — recipient blocks DMs',
                        };
                    }
                    return { ok: true, retried: true };
                } catch (err2) {
                    return { ok: false, retried: true, error: String(err2?.message || err2) };
                }
            }
            return { ok: true, retried: false };
        } catch (err) {
            const msg = String(err?.message || err);
            // 463 = missing privacy token; Baileys issues one in the background.
            const recoverable = /463|tctoken|privacy.?token|no.?session/i.test(msg);
            if (!recoverable) return { ok: false, retried: false, error: msg };

            await sleep(TOKEN_ISSUE_WAIT_MS);
            try {
                await deliverMessage(sock, jid, { text: message }, {
                    verifier,
                    verifyWaitMs: SEND_VERIFY_MS,
                    typing: true,
                });
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
     * @param {{ wait: Function, detach?: Function }} [o.verifier] inject a delivery
     *   verifier (default: one built from the sock) — mainly for tests
     * @returns {Promise<object>} final job state
     */
    async run({ getSock, jobId, onProgress = null, verifier: injectedVerifier = null }) {
        const job = await this.getJob(jobId);
        if (!job) throw new Error(`Broadcast job ${jobId} not found`);

        const { targets, message } = job;
        const names = job.names || null;
        let { cursor, sent, failed } = job;
        let skippedOptOut = job.skipped_opt_out || 0;
        let skippedUnreachable = job.skipped_unreachable || 0;
        let skippedMessaged = job.skipped_messaged || 0;
        let daily = job.daily?.date === getTodayDateStrIST() ? job.daily : { date: getTodayDateStrIST(), count: 0 };
        let consecutiveFailures = 0;
        let attempted = 0;
        // Rolling delivery outcomes (1 = delivered, 0 = failed) for the soft-ban
        // guard: a sustained low delivery rate means the server is throttling us.
        const deliveryOutcomes = [];
        const deliveryPausedUntil = job.delivery_paused_until ? new Date(job.delivery_paused_until).getTime() : 0;

        // Async delivery verdicts for messages we sent — shared pipeline verifier
        // (one listener for the whole run, reused across every send).
        let verifier = null;

        const finish = async (status, note = null, extra = {}) => {
            verifier?.detach?.();
            this._aborting.delete(jobId);
            await this._patch(jobId, {
                status, cursor, sent, failed,
                skipped_opt_out: skippedOptOut, skipped_unreachable: skippedUnreachable,
                skipped_messaged: skippedMessaged, daily, note, ...extra,
            });
            logger.info(
                `📤 Broadcast ${jobId} ${status}: sent=${sent} failed=${failed} optOut=${skippedOptOut} ` +
                    `unreachable=${skippedUnreachable} messaged=${skippedMessaged} of ${targets.length}`
            );
            return { ...job, status, cursor, sent, failed, skipped_opt_out: skippedOptOut, skipped_unreachable: skippedUnreachable, skipped_messaged: skippedMessaged, note };
        };

        if (deliveryPausedUntil > Date.now()) {
            const mins = Math.max(1, Math.round((deliveryPausedUntil - Date.now()) / 60000));
            return finish(BROADCAST_STATUS.PAUSED_CAP, `delivery-rate cooldown — try again in ~${mins} min`);
        }

        while (cursor < targets.length) {
            if (this.isAborting(jobId)) return finish(BROADCAST_STATUS.ABORTED, 'stopped by owner');

            // Account-wide daily ceiling — resume tomorrow rather than push through.
            if (daily.date !== getTodayDateStrIST()) daily = { date: getTodayDateStrIST(), count: 0 };

            const sock = getSock?.();
            if (!sock) return finish(BROADCAST_STATUS.PAUSED_CAP, 'WhatsApp disconnected — will resume');
            verifier = verifier || injectedVerifier || createDeliveryVerifier(sock);

            const jid = targets[cursor];
            const accountJid = resolveAccountJid(sock);
            const alreadyToday = await this.sentToday();

            // Skip people this account already messaged — re-DMing them is how
            // a broadcast becomes a report generator, not a campaign.
            if (this.opts.skipMessaged && this.pacing?.enabled) {
                const last = await this.pacing.lastMessagedAt(accountJid, jid).catch(() => null);
                const withinWindow =
                    last != null &&
                    (this.opts.remessageDays === 0 || Date.now() - last.getTime() < this.opts.remessageDays * 86400_000);
                if (withinWindow) {
                    skippedMessaged += 1;
                    cursor += 1;
                    await this._patch(jobId, { cursor, skipped_messaged: skippedMessaged });
                    continue;
                }
            }

            // Send-pacing governor: warm-up ramp, cold-reachout budget, breaker.
            if (this.pacing?.enabled) {
                const gate = await this.pacing.check(accountJid, jid, { sentToday: alreadyToday });
                if (!gate.allowed) {
                    return finish(
                        BROADCAST_STATUS.PAUSED_CAP,
                        `${gate.reason} — ${gate.retryLabel}; run /broadcast resume after that`
                    );
                }
            }
            // Hard ceiling — the absolute cap, independent of the warm-up ramp.
            if (alreadyToday >= this.opts.dailyCap) {
                return finish(BROADCAST_STATUS.PAUSED_CAP, `daily cap ${this.opts.dailyCap} reached`);
            }

            if (this.optOut?.isOptedOut(jid)) {
                skippedOptOut += 1;
                cursor += 1;
                await this._patch(jobId, { cursor, skipped_opt_out: skippedOptOut });
                continue;
            }

            const wasCold = this.pacing?.enabled ? await this.pacing.isCold(accountJid, jid) : false;

            const personalMessage = this.personalizeFor(message, names?.[jid] || null);

            const res = await this._sendOnce(sock, jid, personalMessage, verifier);
            if (res.ok) {
                sent += 1;
                daily.count += 1;
                consecutiveFailures = 0;
                attempted += 1;
                deliveryOutcomes.push(1);
                this.pacing?.enabled && this.pacing.recordSuccess(accountJid);
            } else if (res.permanent) {
                // Recipient blocks DMs outright — not a throttling signal, and
                // re-sending would just collect reports. Skip and continue.
                skippedUnreachable += 1;
                consecutiveFailures = 0;
                deliveryOutcomes.push(0); // still a non-delivery for the soft-ban guard
                this.pacing?.enabled && this.pacing.recordSuccess(accountJid);
                logger.info(`Broadcast ${jobId}: ${jid} unreachable (still dropped after token) — skipped`);
            } else {
                failed += 1;
                consecutiveFailures += 1;
                attempted += 1;
                deliveryOutcomes.push(0);
                this.pacing?.enabled && this.pacing.recordFailure(accountJid);
                logger.warn(`Broadcast ${jobId} failed for ${jid}: ${res.error}`);
            }
            if (this.pacing?.enabled) await this.pacing.recordSend(accountJid, jid, wasCold);

            // Soft-ban guard: a sustained run of non-deliveries (drops, blocks,
            // hard failures) usually means the server is restricting us. Pause
            // with a cooldown instead of burning the rest of the cap.
            if (deliveryOutcomes.length >= this.opts.deliveryWindow) {
                const kept = deliveryOutcomes.slice(-this.opts.deliveryWindow);
                const rate = kept.reduce((s, v) => s + v, 0) / kept.length;
                if (rate < this.opts.deliveryFloor) {
                    const pausedUntil = Date.now() + this.opts.deliveryCooldownMs;
                    return finish(
                        BROADCAST_STATUS.PAUSED_CAP,
                        `delivery rate ${Math.round(rate * 100)}% over last ${kept.length} — cooling down ~${Math.round(this.opts.deliveryCooldownMs / 60000)} min`,
                        { delivery_paused_until: new Date(pausedUntil) }
                    );
                }
            }

            cursor += 1;
            await this._patch(jobId, { cursor, sent, failed, skipped_opt_out: skippedOptOut, skipped_unreachable: skippedUnreachable, daily });
            onProgress?.({ sent, failed, skippedOptOut, skippedUnreachable, cursor, total: targets.length });

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
            const breakerThreshold = this.pacing?.enabled ? this.pacing.breakerThreshold : 5;
            if (consecutiveFailures >= breakerThreshold) {
                if (this.pacing?.enabled) {
                    const mins = Math.max(1, Math.round(this.pacing.cfg.breakerCooldownMs / 60000));
                    return finish(
                        BROADCAST_STATUS.PAUSED_CAP,
                        `${breakerThreshold} consecutive failures — cooling down ~${mins} min; run /broadcast resume after`
                    );
                }
                return finish(BROADCAST_STATUS.FAILED, `${breakerThreshold} consecutive failures — stopped`);
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
        if (job.skipped_unreachable) lines.push(`🚷 Skipped (blocks DMs): *${job.skipped_unreachable}*`);
        if (job.skipped_messaged) lines.push(`♻️ Skipped (already messaged): *${job.skipped_messaged}*`);
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
    return new BroadcastService(mongoDb, optOutStore, config, new SendPacingService(mongoDb, config));
}

export default BroadcastService;
