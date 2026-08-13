/**
 * Send pacing governor for DM broadcasts.
 *
 * Adapted from the design of OpenWA's SendPacingService (rmyndharis/OpenWA):
 * WhatsApp restricts accounts that behave like machines — new accounts that
 * send at volume, accounts that blast first messages to strangers, and
 * accounts that keep pushing after the server starts refusing them. The
 * governor makes those shapes impossible by REFUSING sends instead of merely
 * slowing them down:
 *
 *  1. Warm-up ramp — the daily send allowance grows with the account's age
 *     (default [20, 40, 80, 160, 320, 640, 1000] ≈ ~1 msg/3 min on day one,
 *     ~1000/day by week two).
 *  2. Cold-reachout cap — a SEPARATE, far smaller daily budget for first
 *     messages to chats with no history in either direction (default
 *     [5, 10, 20, 40, 60, 80, 100]). Starting conversations with strangers is
 *     what actually triggers WhatsApp's reachout timelock, so it is capped
 *     well below the overall allowance.
 *  3. Failure-streak circuit breaker — N consecutive send failures opens a
 *     cooldown that refuses ALL sends for a while. A failure run usually
 *     means the server has already started restricting the account; pushing
 *     through it is how a limit becomes a ban.
 *
 * This is not evasion and it cannot un-restrict a flagged number. It exists
 * to keep a healthy number healthy.
 */

import { logger } from '../utils/logger.js';
import { getTodayDateStrIST } from '../utils/dateIST.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PACING_DEFAULTS = {
    warmupSchedule: [20, 40, 80, 160, 320, 640, 1000],
    coldSchedule: [5, 10, 20, 40, 60, 80, 100],
    breakerThreshold: 5,
    breakerCooldownMs: 15 * 60 * 1000,
};

function parseSchedule(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const parts = String(raw).split(',').map((s) => Number(s.trim()));
    if (parts.length === 0 || parts.some((n) => !Number.isFinite(n) || n < 1 || n > 100_000)) {
        return fallback;
    }
    return parts.map((n) => Math.floor(n));
}

function clampInt(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Pure and parameterised for testability. `config` is the bot config object
 * (PACING_* keys — raw strings and already-typed values are both accepted).
 */
export function resolvePacingConfig(config = {}) {
    const rawEnabled = config.PACING_ENABLED;
    return {
        enabled: rawEnabled !== false && String(rawEnabled ?? 'true') !== 'false',
        warmupSchedule: parseSchedule(config.PACING_WARMUP_SCHEDULE, PACING_DEFAULTS.warmupSchedule),
        coldSchedule: parseSchedule(config.PACING_COLD_DAILY_CAP, PACING_DEFAULTS.coldSchedule),
        breakerThreshold: clampInt(
            config.PACING_BREAKER_THRESHOLD,
            PACING_DEFAULTS.breakerThreshold,
            1,
            100
        ),
        breakerCooldownMs: clampInt(
            config.PACING_BREAKER_COOLDOWN_MS,
            PACING_DEFAULTS.breakerCooldownMs,
            60_000,
            24 * 60 * 60 * 1000
        ),
    };
}

export class SendPacingService {
    /**
     * @param {object|null} mongoDb
     * @param {object} config — PACING_* keys from the bot config
     */
    constructor(mongoDb = null, config = {}) {
        this.db = mongoDb ? mongoDb.collection('pacing_state') : null;
        this.history = mongoDb ? mongoDb.collection('dm_history') : null;
        this.cfg = resolvePacingConfig(config);
        /**
         * Per-account breaker state. In memory on purpose: it describes live
         * server behaviour, and a restart clearing the cooldown is correct.
         */
        this.breakers = new Map();
    }

    /** Pacing without a database cannot remember anything, so it is inert. */
    get enabled() {
        return this.cfg.enabled && !!this.db;
    }

    get breakerThreshold() {
        return this.cfg.breakerThreshold;
    }

    async init() {
        if (!this.db) return;
        await this.db.createIndex({ account: 1 }, { unique: true, name: 'pacing_account' });
        await this.history?.createIndex({ account: 1, jid: 1 }, { unique: true, name: 'dm_history_account_jid' });
    }

    async _state(account) {
        if (!this.db) return null;
        let doc = await this.db.findOne({ account });
        if (!doc) {
            const now = new Date();
            try {
                await this.db.insertOne({ account, account_since: now, updated_at: now });
            } catch (err) {
                if (err?.code !== 11000) throw err; // a raced create is fine
            }
            doc = await this.db.findOne({ account });
        }
        return doc;
    }

    async accountAgeDays(account) {
        const doc = await this._state(account);
        if (!doc) return 0;
        return Math.max(0, Math.floor((Date.now() - new Date(doc.account_since).getTime()) / DAY_MS));
    }

    allowanceForAge(schedule, ageDays) {
        return schedule[Math.min(Math.max(ageDays, 0), schedule.length - 1)];
    }

    /** What the account may do today, for plan/status messages. */
    async accountDayInfo(account) {
        const ageDays = await this.accountAgeDays(account);
        return {
            ageDays,
            warmupAllowance: this.allowanceForAge(this.cfg.warmupSchedule, ageDays),
            coldAllowance: this.allowanceForAge(this.cfg.coldSchedule, ageDays),
        };
    }

    /** True when this account has never messaged the recipient (either direction). */
    async isCold(account, recipient) {
        if (!this.history) return true;
        const row = await this.history.findOne({ account, jid: recipient });
        return !row;
    }

    /**
     * When this account last messaged the recipient, or null if never.
     * The basis for "skip people I have already messaged" — every DM a
     * broadcast sends is recorded here by recordSend().
     */
    async lastMessagedAt(account, recipient) {
        if (!this.history) return null;
        const row = await this.history.findOne(
            { account, jid: recipient },
            { projection: { last_dm: 1 } }
        );
        return row?.last_dm ? new Date(row.last_dm) : null;
    }

    async coldToday(account) {
        const date = getTodayDateStrIST();
        const doc = await this.db.findOne({ account }, { projection: { [`cold.${date}`]: 1 } });
        return doc?.cold?.[date] || 0;
    }

    /**
     * Record that a recipient was processed: they become "known" so future
     * sends are not cold, and a cold send counts against today's cold budget.
     */
    async recordSend(account, recipient, wasCold = true) {
        const now = new Date();
        if (this.history) {
            await this.history.updateOne(
                { account, jid: recipient },
                { $setOnInsert: { account, jid: recipient, first_dm: now }, $set: { last_dm: now } },
                { upsert: true }
            );
        }
        if (this.db && wasCold) {
            await this.db.updateOne(
                { account },
                { $inc: { [`cold.${getTodayDateStrIST()}`]: 1 }, $set: { updated_at: now } }
            );
        }
    }

    recordSuccess(account) {
        this.breakers.delete(account);
    }

    recordFailure(account) {
        const b = this.breakers.get(account) || { consecutiveFailures: 0, openedAt: null };
        b.consecutiveFailures += 1;
        if (b.openedAt === null && b.consecutiveFailures >= this.cfg.breakerThreshold) {
            b.openedAt = Date.now();
            logger.warn(
                `Send breaker tripped for ${account} after ${b.consecutiveFailures} consecutive failures — ` +
                `sends paused for ${Math.round(this.cfg.breakerCooldownMs / 60000)} min`
            );
        }
        this.breakers.set(account, b);
    }

    /** ms until the breaker lets traffic through again (0 = closed). */
    breakerRemainingMs(account) {
        const b = this.breakers.get(account);
        if (!b?.openedAt) return 0;
        const left = b.openedAt + this.cfg.breakerCooldownMs - Date.now();
        if (left <= 0) {
            this.breakers.delete(account);
            return 0;
        }
        return left;
    }

    /**
     * May this account send to `recipient` right now?
     * @returns {{ allowed: true } | { allowed: false, reason: string, retryLabel: string }}
     */
    async check(account, recipient, { sentToday = 0 } = {}) {
        if (!this.enabled) return { allowed: true };

        const cooldown = this.breakerRemainingMs(account);
        if (cooldown > 0) {
            return {
                allowed: false,
                reason: 'cooling down after consecutive send failures',
                retryLabel: `in ~${Math.max(1, Math.round(cooldown / 60000))} min`,
            };
        }

        const ageDays = await this.accountAgeDays(account);
        const warmupAllowance = this.allowanceForAge(this.cfg.warmupSchedule, ageDays);
        if (sentToday >= warmupAllowance) {
            return {
                allowed: false,
                reason: `day-${ageDays} warm-up allowance of ${warmupAllowance} sends reached`,
                retryLabel: 'tomorrow',
            };
        }

        if (await this.isCold(account, recipient)) {
            const coldAllowance = this.allowanceForAge(this.cfg.coldSchedule, ageDays);
            const coldUsed = await this.coldToday(account);
            if (coldUsed >= coldAllowance) {
                return {
                    allowed: false,
                    reason: `day-${ageDays} cold-reachout allowance of ${coldAllowance} new people reached`,
                    retryLabel: 'tomorrow',
                };
            }
        }
        return { allowed: true };
    }
}

export default SendPacingService;
