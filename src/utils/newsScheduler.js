/**
 * Schedule tech news posts at fixed local times (default 10:00 & 22:00 IST).
 */

import { logger } from './logger.js';

function zonedParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
        year: Number(get('year')),
        month: Number(get('month')),
        day: Number(get('day')),
        hour: Number(get('hour')),
        minute: Number(get('minute')),
    };
}

function parsePostTimes(times) {
    return times
        .map((slot) => {
            const [h, m = '0'] = slot.trim().split(':');
            return { hour: Number(h), minute: Number(m) };
        })
        .filter((slot) => !Number.isNaN(slot.hour) && !Number.isNaN(slot.minute));
}

export function msUntilTimeInTimezone(hour, minute, timezone, fromMs = Date.now()) {
    for (let addMin = 1; addMin <= 48 * 60; addMin++) {
        const candidate = new Date(fromMs + addMin * 60_000);
        const p = zonedParts(candidate, timezone);
        if (p.hour === hour && p.minute === minute) {
            return addMin * 60_000;
        }
    }
    return 24 * 60 * 60 * 1000;
}

export function getMsUntilNextNewsPost(postTimes, timezone, fromMs = Date.now()) {
    const slots = parsePostTimes(postTimes);
    if (!slots.length) {
        return 24 * 60 * 60 * 1000;
    }
    return Math.min(...slots.map((slot) => msUntilTimeInTimezone(slot.hour, slot.minute, timezone, fromMs)));
}

export function formatSlotKey(date, timezone, hour, minute) {
    const p = zonedParts(date, timezone);
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${hh}:${mm}`;
}

export function getCurrentDueSlot(postTimes, timezone, now = new Date()) {
    const p = zonedParts(now, timezone);
    const slots = parsePostTimes(postTimes);
    return slots.find((slot) => slot.hour === p.hour && slot.minute === p.minute) || null;
}

/**
 * @param {object} options
 * @param {() => import('@whiskeysockets/baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {{ checkAndPostNews: Function, scrapeAndQueueOnly: Function }} options.newsController
 * @param {{ NEWS_POST_TIMES: string[], NEWS_TIMEZONE: string, NEWS_SCRAPE_INTERVAL: number }} options.config
 * @returns {{ stop: () => void }}
 */
export function startNewsScheduler({ getSock, botState, newsController, config }) {
    let postTimeout = null;
    let scrapeInterval = null;
    let stopped = false;

    const scheduleNextPost = () => {
        if (stopped) {
            return;
        }
        const delay = getMsUntilNextNewsPost(config.NEWS_POST_TIMES, config.NEWS_TIMEZONE);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: config.NEWS_TIMEZONE,
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        logger.info(
            `📰 Next tech news post scheduled at ${nextAt} (${config.NEWS_TIMEZONE})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const due = getCurrentDueSlot(config.NEWS_POST_TIMES, config.NEWS_TIMEZONE);
                if (due) {
                    const slotKey = formatSlotKey(new Date(), config.NEWS_TIMEZONE, due.hour, due.minute);
                    if (botState.lastNewsPostSlot !== slotKey) {
                        botState.lastNewsPostSlot = slotKey;
                        await newsController.checkAndPostNews(sock, botState);
                    }
                }
            } catch (error) {
                logger.error(`News scheduled post failed: ${error.message}`);
            } finally {
                scheduleNextPost();
            }
        }, delay);
    };

    scrapeInterval = setInterval(async () => {
        try {
            await newsController.scrapeAndQueueOnly();
        } catch (error) {
            logger.error(`News background scrape failed: ${error.message}`);
        }
    }, config.NEWS_SCRAPE_INTERVAL * 1000);

    void newsController.scrapeAndQueueOnly();
    scheduleNextPost();

    return {
        stop() {
            stopped = true;
            if (postTimeout) {
                clearTimeout(postTimeout);
                postTimeout = null;
            }
            if (scrapeInterval) {
                clearInterval(scrapeInterval);
                scrapeInterval = null;
            }
        },
    };
}
