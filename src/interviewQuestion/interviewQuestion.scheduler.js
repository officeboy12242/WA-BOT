/**
 * Schedule Interview Q of the Day at fixed times (default 13:00 & 18:00 IST).
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

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('./interviewQuestion.service.js').default} options.service
 * @param {object} options.config
 */
export function startInterviewQuestionScheduler({ getSock, botState, service, config }) {
    let postTimeout = null;
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

    // Recover answer jobs from DB after restart
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

            // All groups already had this slot, or we posted to remaining ones
            if (covered >= groups) {
                markDone(slotKey);
                logger.info(
                    `🧠 Interview Q slot ${slotKey}: ${posted} posted, ${skipped || 0} already done (${groups} groups)`
                );
                return true;
            }

            if (posted > 0) {
                // Partial fan-out — leave unmarked so catch-up can finish the rest
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

    // Recover anything missed while the bot was down
    void catchUpMissedSlots().catch((err) => {
        logger.warn(`Interview Q catch-up failed: ${err.message}`);
    });
    // Second pass — sock sometimes not fully ready on first tick
    setTimeout(() => {
        void catchUpMissedSlots().catch((err) => {
            logger.warn(`Interview Q delayed catch-up failed: ${err.message}`);
        });
    }, CATCHUP_RETRY_DELAY_MS);

    scheduleNextPost();

    return {
        stop() {
            stopped = true;
            if (postTimeout) {
                clearTimeout(postTimeout);
                postTimeout = null;
            }
        },
    };
}
