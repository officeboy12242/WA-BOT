/**
 * Schedule daily good morning messages at a random time within a morning window.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';

function parseTime(str) {
    const [h, m = '0'] = str.trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

function randomTimeInWindow(startStr, endStr) {
    const start = parseTime(startStr);
    const end = parseTime(endStr);
    const startMins = start.hour * 60 + start.minute;
    const endMins = end.hour * 60 + end.minute;
    const pick = startMins + Math.floor(Math.random() * (endMins - startMins + 1));
    return { hour: Math.floor(pick / 60), minute: pick % 60 };
}

function formatTime(hour, minute) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function planNextMorningSend(startStr, endStr, timezone, fromMs = Date.now()) {
    const { hour, minute } = randomTimeInWindow(startStr, endStr);
    const delay = msUntilTimeInTimezone(hour, minute, timezone, fromMs);
    return { delay, hour, minute, timeLabel: formatTime(hour, minute) };
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ sendDailyMorning: Function }} options.morningController
 * @param {object} options.config
 * @returns {{ stop: () => void }}
 */
export function startMorningScheduler({ getSock, botState, morningController, config }) {
    let postTimeout = null;
    let stopped = false;

    const startTime = config.MORNING_MESSAGE_TIME_START;
    const endTime = config.MORNING_MESSAGE_TIME_END;

    if (!config.MORNING_MESSAGES_ENABLED || !startTime || !endTime) {
        return { stop() {} };
    }

    const scheduleNext = () => {
        if (stopped) {
            return;
        }

        const plan = planNextMorningSend(startTime, endTime, config.MORNING_TIMEZONE);
        const nextAt = new Date(Date.now() + plan.delay).toLocaleString('en-IN', {
            timeZone: config.MORNING_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        logger.info(
            `🌅 Next good morning message ~${plan.timeLabel} (random ${startTime}–${endTime}) → ${nextAt} (${config.MORNING_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const slotKey = formatSlotKey(
                    new Date(),
                    config.MORNING_TIMEZONE,
                    plan.hour,
                    plan.minute
                );
                if (botState.lastMorningPostSlot !== slotKey) {
                    botState.lastMorningPostSlot = slotKey;
                    await morningController.sendDailyMorning(sock, botState);
                }
            } catch (error) {
                logger.error(`Morning scheduled send failed: ${error.message}`);
            } finally {
                scheduleNext();
            }
        }, plan.delay);
    };

    scheduleNext();

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
