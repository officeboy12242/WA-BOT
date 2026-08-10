/**
 * Schedule daily F&O trade alerts.
 *
 * Two clocks, because the strategies do not become useful at the same moment:
 *
 *   09:20  v1 / legacy / nse — a pre-market read, which is what those sources
 *          are built on (v1 selects from the pre-open auction snapshot).
 *   09:50  heatmap2 — the earliest a breakout can be CONFIRMED. v2 needs the
 *   11:15  09:15 opening range to close plus a following bar, so at 09:20 it
 *          can only offer watches with no entry, stop or target. Both of its
 *          slots sit inside 09:45–12:00, where its measured edge lives; breaks
 *          after noon tested at 37% and negative expectancy.
 *
 * A group only ever fires on the clock matching its own discovery source, so
 * nobody gets two morning posts. Same-symbol dedupe (`trade_alert_sent`) means
 * the 11:15 slot adds new names rather than repeating the 09:50 ones.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

const HEATMAP2 = 'heatmap2';

function parseAlertTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '09:20').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

/**
 * @param {object} options
 * @param {() => import('baileys').WASocket | null} options.getSock
 * @param {object} options.botState
 * @param {import('../controllers/TradeAlertController.js').default} options.tradeAlertController
 * @param {object} options.config
 * @param {import('../models/BotSettings.js').default} [options.botSettings]
 * @param {{ enqueue: Function }|null} [options.jobQueue]
 */
export function startTradeAlertScheduler({
    getSock,
    botState,
    tradeAlertController,
    config,
    botSettings = null,
    jobQueue = null,
}) {
    const timers = [];
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'trade');

    if (config.TRADE_ALERT_ENABLED === false) {
        return { stop() {} };
    }

    const timezone = config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata';

    /**
     * @param {string} name distinct slot id, so two clocks cannot share a
     *   "already ran today" marker and silently cancel each other
     * @param {string} timeStr
     * @param {object} postOpts forwarded to postDailyAlerts
     */
    const scheduleSlot = (name, timeStr, postOpts) => {
        const { hour, minute } = parseAlertTime(timeStr);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            logger.warn(`Trade alert scheduler: bad time for ${name} (${timeStr})`);
            return;
        }
        const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        const next = () => {
            if (stopped) return;

            const delay = msUntilTimeInTimezone(hour, minute, timezone);
            const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
                timeZone: timezone,
                dateStyle: 'medium',
                timeStyle: 'short',
            });
            logger.info(`📈 Next trade alert [${name}] at ${hhmm} → ${nextAt} (${timezone})`);

            const t = setTimeout(async () => {
                try {
                    const sock = getSock();
                    const slotKey = `${name}:${formatSlotKey(new Date(), timezone, hour, minute)}`;
                    if (await slots.isDone(botState, slotKey, 'lastTradeAlertSlot')) {
                        return;
                    }
                    if (!sock && !jobQueue) return;

                    if (jobQueue) {
                        await jobQueue.enqueue(
                            'trade.daily_alerts',
                            { slotKey, ...postOpts },
                            { jobKey: `trade.daily:${slotKey}`, maxAttempts: 2 }
                        );
                        logger.info(`📈 Trade alert enqueued [${name}] (${slotKey})`);
                    } else {
                        if (!sock) return;
                        await tradeAlertController.postDailyAlerts(sock, postOpts);
                    }
                    await slots.markDone(botState, slotKey, 'lastTradeAlertSlot');
                } catch (error) {
                    logger.error(`Trade alert [${name}] failed: ${error.message}`);
                } finally {
                    next();
                }
            }, delay);
            timers.push(t);
        };

        next();
    };

    // Everyone except heatmap2 keeps the original pre-market slot.
    scheduleSlot('default', config.TRADE_ALERT_TIME, {
        excludeSources: [HEATMAP2],
        slotLabel: 'pre-market',
    });

    const v2Times = Array.isArray(config.TRADE_ALERT_HEATMAP2_TIMES)
        ? config.TRADE_ALERT_HEATMAP2_TIMES
        : [];
    v2Times.forEach((time, i) => {
        scheduleSlot(`heatmap2-${i + 1}`, time, {
            onlySources: [HEATMAP2],
            slotLabel: i === 0 ? 'v2 morning' : 'v2 midday',
        });
    });

    return {
        stop() {
            stopped = true;
            for (const t of timers) clearTimeout(t);
            timers.length = 0;
        },
    };
}
