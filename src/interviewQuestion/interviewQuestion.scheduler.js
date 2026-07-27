/**
 * Schedule Interview Q of the Day at fixed times (default 13:00 & 18:00 IST),
 * plus Saturday 22:00 IST weekly learning recap.
 *
 * Durable-ish catch-up: if the bot was down at slot time, past-due slots
 * still post on startup / reconnect (per-group slot_key dedupes duplicates).
 */

import { logger } from '../utils/logger.js';
import {
    formatSlotKey,
    getCurrentDueSlot,
    getMsUntilNextNewsPost,
    getPastDueSlotsToday,
    parsePostTimesFromConfig,
} from '../utils/newsScheduler.js';

const RETRY_MS = 45_000;
const MAX_RETRIES = 3;
const CATCHUP_GAP_MS = 2_500;
const CATCHUP_RETRY_DELAY_MS = 60_000;

function zonedNow(timezone, fromMs = Date.now()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(new Date(fromMs));
    const get = (type) => parts.find((p) => p.type === type)?.value;
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        weekday: String(get('weekday') || ''),
        hour,
        minute: Number(get('minute')),
    };
}

function parseHm(raw) {
    const [h, m = '0'] = String(raw || '').trim().split(':');
    const hour = Number(h);
    const minute = Number(m);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
}

/** ms until next Saturday at hour:minute in timezone. */
export function msUntilNextSaturday(hour, minute, timezone, fromMs = Date.now()) {
    for (let addMin = 0; addMin <= 8 * 24 * 60; addMin++) {
        const candidate = new Date(fromMs + addMin * 60_000);
        const p = zonedNow(timezone, candidate.getTime());
        if (p.weekday === 'Sat' && p.hour === hour && p.minute === minute) {
            return Math.max(addMin, 1) * 60_000;
        }
    }
    return 7 * 24 * 60 * 60 * 1000;
}

export function saturdaySummaryKey(timezone, fromMs = Date.now()) {
    const p = zonedNow(timezone, fromMs);
    return `summary-${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('./interviewQuestion.service.js').default} options.service
 * @param {object} options.config
 */
export function startInterviewQuestionScheduler({ getSock, botState, service, config }) {
    let postTimeout = null;
    let summaryTimeout = null;
    let stopped = false;
    /** @type {Set<string>} */
    const inFlight = new Set();

    if (!config.INTERVIEW_Q_ENABLED) {
        logger.info('🧠 Interview Q scheduler disabled');
        return { stop() {} };
    }

    const slots = parsePostTimesFromConfig(config.INTERVIEW_Q_TIMES);
    if (!slots.length) {
        logger.warn('🧠 Interview Q enabled but no post times configured');
        return { stop() {} };
    }

    if (!botState.lastInterviewQSlots) {
        botState.lastInterviewQSlots = {};
    }
    if (!botState.lastInterviewQSummaries) {
        botState.lastInterviewQSummaries = {};
    }

    void service.recoverPendingAnswers().catch((err) => {
        logger.warn(`Interview Q recover failed: ${err.message}`);
    });

    async function isDone(slotKey) {
        if (botState.lastInterviewQSlots[slotKey]) return true;
        if (typeof service.isSlotFullyPosted === 'function') {
            try {
                if (await service.isSlotFullyPosted(slotKey)) {
                    botState.lastInterviewQSlots[slotKey] = true;
                    return true;
                }
            } catch (err) {
                logger.warn(`Interview Q slot lookup failed: ${err.message}`);
            }
        }
        return false;
    }

    function markDone(slotKey) {
        botState.lastInterviewQSlots[slotKey] = true;
    }

    /**
     * @returns {Promise<boolean>} true if slot settled
     */
    async function runSlot(slotKey, slotIndex, attempt = 0) {
        if (stopped) return true;
        if (await isDone(slotKey)) return true;
        if (inFlight.has(slotKey)) return false;
        inFlight.add(slotKey);

        try {
            const sock = getSock();
            if (!sock) {
                logger.info(`🧠 Interview Q slot ${slotKey}: waiting for WhatsApp…`);
                if (attempt < MAX_RETRIES) {
                    setTimeout(() => {
                        void runSlot(slotKey, slotIndex, attempt + 1);
                    }, RETRY_MS);
                }
                return false;
            }

            const { posted, groups, skipped } = await service.postSlotToGroups(sock, {
                slotKey,
                slotIndex,
            });
            const covered = (posted || 0) + (skipped || 0);

            if (groups === 0) {
                markDone(slotKey);
                return true;
            }

            if (covered >= groups) {
                markDone(slotKey);
                logger.info(
                    `🧠 Interview Q slot ${slotKey}: ${posted} posted, ${skipped || 0} already done (${groups} groups)`
                );
                return true;
            }

            if (posted > 0) {
                logger.warn(
                    `🧠 Interview Q slot ${slotKey}: partial ${covered}/${groups}; will retry remaining`
                );
            }

            if (attempt < MAX_RETRIES) {
                logger.warn(
                    `🧠 Interview Q slot ${slotKey} incomplete (${covered}/${groups}); retry ${attempt + 1}/${MAX_RETRIES}`
                );
                setTimeout(() => {
                    void runSlot(slotKey, slotIndex, attempt + 1);
                }, RETRY_MS);
                return false;
            }

            logger.error(`🧠 Interview Q slot ${slotKey} gave up after ${MAX_RETRIES} retries`);
            return false;
        } catch (err) {
            logger.error(`Interview Q slot ${slotKey} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                setTimeout(() => {
                    void runSlot(slotKey, slotIndex, attempt + 1);
                }, RETRY_MS);
            }
            return false;
        } finally {
            inFlight.delete(slotKey);
        }
    }

    async function catchUpMissedSlots() {
        if (stopped) return;
        const past = getPastDueSlotsToday(
            config.INTERVIEW_Q_TIMES,
            config.INTERVIEW_Q_TIMEZONE
        );
        for (const slot of past) {
            if (stopped) return;
            const slotKey = formatSlotKey(
                new Date(),
                config.INTERVIEW_Q_TIMEZONE,
                slot.hour,
                slot.minute
            );
            if (await isDone(slotKey)) continue;
            logger.info(`🧠 Catching up Interview Q slot ${slotKey}`);
            await runSlot(slotKey, slot.index, 0);
            await new Promise((r) => setTimeout(r, CATCHUP_GAP_MS));
        }
    }

    async function runWeeklySummary(attempt = 0) {
        if (stopped) return;
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) return;

        const tz = config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata';
        const now = zonedNow(tz);
        if (now.weekday !== 'Sat') return;
        if (now.hour !== hm.hour || now.minute !== hm.minute) return;

        const summaryKey = saturdaySummaryKey(tz);
        if (botState.lastInterviewQSummaries[summaryKey]) return;
        if (inFlight.has(summaryKey)) return;
        inFlight.add(summaryKey);

        try {
            const sock = getSock();
            if (!sock) {
                if (attempt < MAX_RETRIES) {
                    setTimeout(() => {
                        void runWeeklySummary(attempt + 1);
                    }, RETRY_MS);
                }
                return;
            }

            const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const { posted, groups, skipped } = await service.postWeeklySummaryToGroups(sock, {
                summaryKey,
                sinceMs,
            });
            botState.lastInterviewQSummaries[summaryKey] = true;
            logger.info(
                `📚 Interview Q weekly summary ${summaryKey}: ${posted} posted, ${skipped || 0} skipped (${groups} groups)`
            );
        } catch (err) {
            logger.error(`Interview Q weekly summary failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                setTimeout(() => {
                    void runWeeklySummary(attempt + 1);
                }, RETRY_MS);
            }
        } finally {
            inFlight.delete(summaryKey);
        }
    }

    const scheduleNextPost = () => {
        if (stopped) return;

        const delay = getMsUntilNextNewsPost(config.INTERVIEW_Q_TIMES, config.INTERVIEW_Q_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.INTERVIEW_Q_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(`🧠 Next Interview Q at ${nextAt} (${config.INTERVIEW_Q_TIMEZONE})`);

        postTimeout = setTimeout(async () => {
            try {
                const due = getCurrentDueSlot(
                    config.INTERVIEW_Q_TIMES,
                    config.INTERVIEW_Q_TIMEZONE
                );
                if (!due) {
                    await catchUpMissedSlots();
                    return;
                }

                const slotIndex = slots.findIndex(
                    (slot) => slot.hour === due.hour && slot.minute === due.minute
                );
                if (slotIndex < 0) return;

                const slotKey = formatSlotKey(
                    new Date(),
                    config.INTERVIEW_Q_TIMEZONE,
                    due.hour,
                    due.minute
                );
                await runSlot(slotKey, slotIndex, 0);
            } catch (err) {
                logger.error(`Interview Q scheduled post failed: ${err.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

    const scheduleNextSummary = () => {
        if (stopped) return;
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) {
            logger.info('📚 Interview Q weekly summary disabled (empty INTERVIEW_Q_SUMMARY_TIME)');
            return;
        }

        const tz = config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata';
        const delay = msUntilNextSaturday(hm.hour, hm.minute, tz);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: tz,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(`📚 Next Interview Q weekly summary at ${nextAt} (${tz})`);

        summaryTimeout = setTimeout(async () => {
            try {
                await runWeeklySummary(0);
            } catch (err) {
                logger.error(`Interview Q summary tick failed: ${err.message}`);
            } finally {
                scheduleNextSummary();
            }
        }, delay);
    };

    void catchUpMissedSlots().catch((err) => {
        logger.warn(`Interview Q catch-up failed: ${err.message}`);
    });
    setTimeout(() => {
        void catchUpMissedSlots().catch((err) => {
            logger.warn(`Interview Q delayed catch-up failed: ${err.message}`);
        });
    }, CATCHUP_RETRY_DELAY_MS);

    // If we restart on Saturday after 22:00, still try catch-up summary once
    setTimeout(() => {
        const hm = parseHm(config.INTERVIEW_Q_SUMMARY_TIME);
        if (!hm) return;
        const tz = config.INTERVIEW_Q_TIMEZONE || 'Asia/Kolkata';
        const now = zonedNow(tz);
        if (now.weekday !== 'Sat') return;
        const nowMin = now.hour * 60 + now.minute;
        const dueMin = hm.hour * 60 + hm.minute;
        if (nowMin < dueMin) return;
        const summaryKey = saturdaySummaryKey(tz);
        if (botState.lastInterviewQSummaries[summaryKey]) return;
        logger.info(`📚 Catching up Interview Q weekly summary ${summaryKey}`);
        void runWeeklySummary(0);
    }, CATCHUP_RETRY_DELAY_MS + 5_000);

    scheduleNextPost();
    scheduleNextSummary();

    return {
        stop() {
            stopped = true;
            if (postTimeout) {
                clearTimeout(postTimeout);
                postTimeout = null;
            }
            if (summaryTimeout) {
                clearTimeout(summaryTimeout);
                summaryTimeout = null;
            }
        },
    };
}
