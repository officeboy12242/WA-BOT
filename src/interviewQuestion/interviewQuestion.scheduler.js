/**
 * Schedule Interview Q of the Day at fixed times (default 13:00 & 18:00 IST).
 */

import { logger } from '../utils/logger.js';
import {
    formatSlotKey,
    getCurrentDueSlot,
    getMsUntilNextNewsPost,
    parsePostTimesFromConfig,
} from '../utils/newsScheduler.js';

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

    if (!config.INTERVIEW_Q_ENABLED) {
        logger.info('🧠 Interview Q scheduler disabled');
        return { stop() {} };
    }

    const slots = parsePostTimesFromConfig(config.INTERVIEW_Q_TIMES);
    if (!slots.length) {
        logger.warn('🧠 Interview Q enabled but no post times configured');
        return { stop() {} };
    }

    // Recover answer jobs from DB after restart
    void service.recoverPendingAnswers().catch((err) => {
        logger.warn(`Interview Q recover failed: ${err.message}`);
    });

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
                const sock = getSock();
                const due = getCurrentDueSlot(config.INTERVIEW_Q_TIMES, config.INTERVIEW_Q_TIMEZONE);
                if (!due) {
                    scheduleNextPost();
                    return;
                }

                const slotIndex = slots.findIndex(
                    (slot) => slot.hour === due.hour && slot.minute === due.minute
                );
                if (slotIndex < 0) {
                    scheduleNextPost();
                    return;
                }

                const slotKey = formatSlotKey(
                    new Date(),
                    config.INTERVIEW_Q_TIMEZONE,
                    due.hour,
                    due.minute
                );
                if (botState.lastInterviewQSlots?.[slotKey]) {
                    scheduleNextPost();
                    return;
                }

                if (!botState.lastInterviewQSlots) {
                    botState.lastInterviewQSlots = {};
                }
                botState.lastInterviewQSlots[slotKey] = true;

                if (!sock) {
                    logger.info('Waiting for WhatsApp (Interview Q)...');
                } else {
                    const { posted, groups } = await service.postSlotToGroups(sock, {
                        slotKey,
                        slotIndex,
                    });
                    logger.info(`🧠 Interview Q slot posted to ${posted}/${groups} group(s)`);
                }
            } catch (err) {
                logger.error(`Interview Q scheduled post failed: ${err.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

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
