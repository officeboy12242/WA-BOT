/**
 * ScalpAlertService — Auto-trigger scalp alerts
 *
 * Scans NIFTY option chain every 3 minutes during market hours (9:15–15:30 IST).
 * When a setup hits 75%+ confidence, sends an alert to enabled groups.
 *
 * Cooldown logic: tracks setup fingerprint (strike + entry price).
 * - Same setup (same strike/entry): 10 min cooldown
 * - Different setup (new strike or entry): alerts immediately
 */

import { logger } from '../utils/logger.js';
import ScalpService from './ScalpService.js';

const SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per unique setup
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 30;

class ScalpAlertService {
    constructor() {
        this.scalpSvc = new ScalpService();
        this._timer = null;
        this._lastAlerts = {}; // { fingerprint: { timestamp, strike, entry } }
        this._sock = null;
        this._getGroups = null;
        this._sendMessage = null;
        this._enabled = false;
    }

    /**
     * Start the scanner.
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
        if (!this._isMarketOpen()) return;

        try {
            const card = await this.scalpSvc.buildScalpCard('NIFTY');
            if (!card || card.includes('NO CLEAR SETUP') || card.includes('Could not fetch')) {
                return;
            }

            // Trigger on any setup with 75%+ confidence (PRIMARY or SECONDARY)
            if (!card.includes('✅')) return;

            // Extract setup details
            const setups = this._extractSetups(card);
            if (!setups.length) return;

            // Filter: alert if setup is new OR details changed (strike/entry)
            const now = Date.now();
            const freshSetups = setups.filter((s) => {
                const last = this._lastAlerts[s.fingerprint];
                if (!last) return true; // never alerted — send
                // On cooldown? Check if details actually changed
                if ((now - last.timestamp) < COOLDOWN_MS) {
                    // Same fingerprint on cooldown — skip
                    return false;
                }
                return true; // cooldown expired — send
            });

            if (!freshSetups.length) return;

            // Send alert to enabled groups
            const groups = this._getGroups ? await this._getGroups() : [];
            const scalpGroups = groups.filter((g) => g.scalp_enabled);
            if (!scalpGroups.length) return;

            const alertMsg = this._buildAlertMsg(card, freshSetups);

            for (const group of scalpGroups) {
                try {
                    await this._sendMessage(group.group_id, { text: alertMsg });
                    logger.info(`⚡ Scalp alert sent to ${group.group_name || group.group_id}`);
                } catch (err) {
                    logger.error(`Failed to send scalp alert to ${group.group_id}:`, err.message);
                }
            }

            // Mark as alerted
            for (const s of freshSetups) {
                this._lastAlerts[s.fingerprint] = { timestamp: now, strike: s.strike, entry: s.entry };
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

    /**
     * Extract setup details from card text.
     * Fingerprint = type:strike:entry — if any changes, it's a "new" setup.
     */
    _extractSetups(card) {
        const setups = [];

        // Extract directional setups (BUY CE / BUY PE)
        if (card.includes('BUY CE')) {
            const strikeMatch = card.match(/Buy CE ([\d,]+)/);
            const entryMatch = card.match(/Entry: ₹([\d.]+)/);
            const strike = strikeMatch ? strikeMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BUY CE',
                emoji: '🟢',
                strike,
                entry,
                fingerprint: `BUY CE:${strike}:${entry}`,
            });
        }

        if (card.includes('BUY PE')) {
            const strikeMatch = card.match(/Buy PE ([\d,]+)/);
            const entryMatch = card.match(/Entry: ₹([\d.]+)/);
            const strike = strikeMatch ? strikeMatch[1] : '?';
            const entry = entryMatch ? entryMatch[1] : '0';
            setups.push({
                type: 'BUY PE',
                emoji: '🔴',
                strike,
                entry,
                fingerprint: `BUY PE:${strike}:${entry}`,
            });
        }

        // Extract theta setups (SHORT STRADDLE / SHORT STRANGLE)
        if (card.includes('SHORT STRADDLE')) {
            const entryMatch = card.match(/SELL[\s\S]*?Premium: ₹([\d.]+)/);
            const entry = entryMatch ? entryMatch[1] : '?';
            setups.push({
                type: 'SHORT STRADDLE',
                emoji: '⚡',
                strike: 'ATM',
                entry,
                fingerprint: `SHORT STRADDLE:${entry}`,
            });
        }

        if (card.includes('SHORT STRANGLE')) {
            const entryMatch = card.match(/SHORT STRANGLE[\s\S]*?Premium: ₹([\d.]+)/);
            const entry = entryMatch ? entryMatch[1] : '?';
            setups.push({
                type: 'SHORT STRANGLE',
                emoji: '🪁',
                strike: 'OTM wings',
                entry,
                fingerprint: `SHORT STRANGLE:${entry}`,
            });
        }

        return setups;
    }

    _buildAlertMsg(card, setups) {
        const setupLabels = setups.map((s) => `${s.emoji} ${s.type} ${s.strike} @ ₹${s.entry}`).join(' & ');
        const now = new Date();
        const timeStr = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        }).format(now);

        const isDirectional = setups.some(s => s.type.startsWith('BUY'));
        const isTheta = setups.some(s => s.type.startsWith('SHORT'));
        let trigger = '';
        if (isDirectional) trigger = 'Directional setup triggered!';
        if (isTheta) trigger = 'Theta decay setup triggered!';
        if (isDirectional && isTheta) trigger = 'Multiple setups triggered!';

        return [
            `⚡ *SCALP ALERT* — ${timeStr} IST`,
            '',
            `${setupLabels}`,
            trigger,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            card,
        ].join('\n');
    }
}

export default new ScalpAlertService();
