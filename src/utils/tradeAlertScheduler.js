/**
 * Schedule daily F&O trade alerts at a fixed IST time.
 */

import { logger } from './logger.js';
import { formatSlotKey, msUntilTimeInTimezone } from './newsScheduler.js';
import { createDurableSlotStore } from './durableSlots.js';

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
 */
export function startTradeAlertScheduler({ getSock, botState, tradeAlertController, config, botSettings = null }) {
    let postTimeout = null;
    let stopped = false;
    const slots = createDurableSlotStore(botSettings, 'trade');

    if (config.TRADE_ALERT_ENABLED === false) {
        return { stop() {} };
    }

    const timezone = config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata';
    const { hour, minute } = parseAlertTime(config.TRADE_ALERT_TIME);

    const scheduleNext = () => {
        if (stopped) return;

        const delay = msUntilTimeInTimezone(hour, minute, timezone);
        const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
            timeZone: timezone,
            dateStyle: 'medium',
            timeStyle: 'short',
        });

        logger.info(
            `📈 Next trade alert at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ` +
                `→ ${nextAt} (${timezone})`
        );

        postTimeout = setTimeout(async () => {
            try {
                const sock = getSock();
                const slotKey = formatSlotKey(new Date(), timezone, hour, minute);
                if (await slots.isDone(botState, slotKey, 'lastTradeAlertSlot')) {
                    return;
                }
                if (!sock) return;
                await tradeAlertController.postDailyAlerts(sock);
                await slots.markDone(botState, slotKey, 'lastTradeAlertSlot');
            } catch (error) {
                logger.error(`Trade alert scheduled send failed: ${error.message}`);
            } finally {
                scheduleNext();
            }
        }, delay);
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
