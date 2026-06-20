/**
 * Schedule individual GitHub trending repo posts throughout the day.
 */

import { logger } from './logger.js';
import {
    formatSlotKey,
    getCurrentDueSlot,
    getMsUntilNextNewsPost,
    parsePostTimesFromConfig,
} from './newsScheduler.js';

export { parsePostTimesFromConfig };

/**
 * @param {object} options
 * @param {() => import('@whiskeysockets/baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ checkAndPostRepo: Function }} options.githubController
 * @param {{ GITHUB_TRENDING_ENABLED: boolean, GITHUB_TRENDING_TIMES: string[], GITHUB_TRENDING_TIMEZONE: string }} options.config
 */
export function startGithubScheduler({ getSock, botState, githubController, config }) {
    let postTimeout = null;
    let stopped = false;

    if (!config.GITHUB_TRENDING_ENABLED) {
        logger.info('🐙 GitHub trending scheduler disabled');
        return { stop() {} };
    }

    const slots = parsePostTimesFromConfig(config.GITHUB_TRENDING_TIMES);
    if (!slots.length) {
        logger.warn('🐙 GitHub trending enabled but no post times configured');
        return { stop() {} };
    }

    const scheduleNextPost = () => {
        if (stopped) return;

        const delay = getMsUntilNextNewsPost(config.GITHUB_TRENDING_TIMES, config.GITHUB_TRENDING_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.GITHUB_TRENDING_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(
            `🐙 Next GitHub trending repo scheduled at ${nextAt} (${config.GITHUB_TRENDING_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const due = getCurrentDueSlot(config.GITHUB_TRENDING_TIMES, config.GITHUB_TRENDING_TIMEZONE);
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
                    config.GITHUB_TRENDING_TIMEZONE,
                    due.hour,
                    due.minute
                );
                if (botState.lastGithubPostSlots?.[slotKey]) {
                    scheduleNextPost();
                    return;
                }

                if (!botState.lastGithubPostSlots) {
                    botState.lastGithubPostSlots = {};
                }
                botState.lastGithubPostSlots[slotKey] = true;

                await githubController.checkAndPostRepo(sock, botState, slotIndex);
            } catch (err) {
                logger.error(`GitHub trending scheduled post failed: ${err.message}`);
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
