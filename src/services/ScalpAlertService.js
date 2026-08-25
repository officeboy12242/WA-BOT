/**
 * ScalpAlertService — Auto-trigger scalp alerts
 *
 * Scans NIFTY option chain every 3 minutes during market hours (9:15–15:30 IST).
 * When a setup hits 75%+ confidence, sends an alert to enabled groups.
 * Cooldown: same setup type won't re-alert within 30 minutes.
 */

import { logger } from '../utils/logger.js';
import ScalpService from './ScalpService.js';

const SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per setup type
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 30;

class ScalpAlertService {
    constructor() {
        this.scalpSvc = new ScalpService();
        this._timer = null;
        this._lastAlerts = {}; // { setupType: timestamp }
        this._sock = null;
        this._getGroups = null;
        this._enabled = false;
    }

    /**
     * Start the scanner.
     * @param {object} opts
     * @param {object} opts.sock - WhatsApp socket
     * @param {Function} opts.getGroups - async () => [{ group_id, scalp_enabled }]
     * @param {Function} opts.sendMessage - async (chatId, msg) => void
     */
    start({ sock, getGroups, sendMessage }) {
        if (this._timer) return;
        this._sock = sock;
        this._getGroups = getGroups;
        this._sendMessage = sendMessage;
        this._enabled = true;

        logger.info('⚡ ScalpAlertService started — scanning every 3 min during market hours');

        this._timer = setInterval(() => {
            void this._scan();
        }, SCAN_INTERVAL_MS);

        // Run first scan after 10 seconds
        setTimeout(() => void this._scan(), 10_000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this._enabled = false;
        logger.info('⚡ ScalpAlertService stopped');
    }

    async _scan() {
        if (!this._enabled) return;

        // Check if market is open
        if (!this._isMarketOpen()) return;

        try {
            const card = await this.scalpSvc.buildScalpCard('NIFTY');
            if (!card || card.includes('NO CLEAR SETUP') || card.includes('Could not fetch')) {
                return; // No setup or market closed
            }

            // Check if card has any PRIMARY setups (75%+ confidence)
            if (!card.includes('PRIMARY')) return;

            // Extract setup types from card
            const setups = this._extractSetups(card);
            if (!setups.length) return;

            // Filter out setups on cooldown
            const now = Date.now();
            const freshSetups = setups.filter((s) => {
                const lastAlert = this._lastAlerts[s.type] || 0;
                return (now - lastAlert) >= COOLDOWN_MS;
            });

            if (!freshSetups.length) return; // All on cooldown

            // Send alert to enabled groups
            const groups = this._getGroups ? await this._getGroups() : [];
            const scalpGroups = groups.filter((g) => g.scalp_enabled);

            if (!scalpGroups.length) return;

            // Build alert message
            const alertMsg = this._buildAlertMsg(card, freshSetups);

            for (const group of scalpGroups) {
                try {
                    await this._sendMessage(group.group_id, { text: alertMsg });
                    logger.info(`⚡ Scalp alert sent to ${group.group_name || group.group_id}`);
                } catch (err) {
                    logger.error(`Failed to send scalp alert to ${group.group_id}:`, err.message);
                }
            }

            // Mark setups as alerted
            for (const s of freshSetups) {
                this._lastAlerts[s.type] = now;
            }

        } catch (err) {
            logger.error('ScalpAlert scan error:', err.message);
        }
    }

    _isMarketOpen() {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
            weekday: 'short',
        }).formatToParts(now);

        const weekday = parts.find((p) => p.type === 'weekday')?.value;
        if (weekday === 'Sat' || weekday === 'Sun') return false;

        let hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
        if (hour === 24) hour = 0;
        const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);

        const timeMinutes = hour * 60 + minute;
        const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
        const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;

        return timeMinutes >= openMinutes && timeMinutes <= closeMinutes;
    }

    _extractSetups(card) {
        const setups = [];
        // Look for PRIMARY setups in the card
        if (card.includes('BUY CE')) setups.push({ type: 'BUY CE', emoji: '🟢' });
        if (card.includes('BUY PE')) setups.push({ type: 'BUY PE', emoji: '🔴' });
        return setups;
    }

    _buildAlertMsg(card, setups) {
        const setupLabels = setups.map((s) => `${s.emoji} ${s.type}`).join(' & ');
        const now = new Date();
        const timeStr = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        }).format(now);

        return [
            `⚡ *SCALP ALERT* — ${timeStr} IST`,
            '',
            `${setupLabels} setup triggered with 75%+ confidence!`,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            card,
        ].join('\n');
    }
}

export default new ScalpAlertService();
