/**
 * ScalpAlertService — Auto-trigger scalp alerts
 *
 * Scans every 3 minutes during market hours (9:15–15:30 IST). When a setup hits
 * 75%+ confidence it alerts the groups that asked for that index.
 *
 * Per-group index selection: a group stores `scalp_indices` (e.g. ['SENSEX'] or
 * ['NIFTY','SENSEX']). Each index's card is built ONCE per scan and then fanned
 * out to whichever groups want it, so adding SENSEX does not double the number
 * of option-chain fetches for groups that only follow NIFTY.
 *
 * Cooldown logic: tracks setup fingerprint (index + strike + entry price).
 * - Same setup (same index/strike/entry): 10 min cooldown
 * - Different setup (new strike or entry): alerts immediately
 * The index is part of the fingerprint because NIFTY and SENSEX can produce the
 * same strike-and-entry pair and they are not the same trade.
 */

import { logger } from '../utils/logger.js';
import ScalpService from './ScalpService.js';
import { resolveScalpIndex } from '../data/scalpIndexConfig.js';
import { isIndianEquityTradingDay } from '../utils/indianMarketCalendar.js';
import { scalpOutcomeTracker } from './ScalpOutcomeTracker.js';

const SCAN_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes per unique setup
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MIN = 15;
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MIN = 30;
/** CAS: cash freezes 15:15, closing price prints by ~15:35. */
const CAS_FREEZE_START_MIN = 15 * 60 + 15;
const CAS_FREEZE_END_MIN = 15 * 60 + 35;

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
    start({ sock, getGroups, sendMessage, mongoDb = null }) {
        if (this._timer) return;
        this._sock = sock;
        this._getGroups = getGroups;
        this._sendMessage = sendMessage;
        this._enabled = true;
        scalpOutcomeTracker.attach(mongoDb);

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

    /** Indices a group wants, normalised. Pre-SENSEX groups default to NIFTY. */
    static indicesFor(group) {
        const raw = Array.isArray(group?.scalp_indices) && group.scalp_indices.length
            ? group.scalp_indices
            : ['NIFTY'];
        return raw.map((k) => String(k).trim().toUpperCase()).filter(Boolean);
    }

    async _scan() {
        if (!this._enabled) return;
        if (!this._isMarketOpen()) return;

        let scalpGroups;
        try {
            const groups = this._getGroups ? await this._getGroups() : [];
            scalpGroups = groups.filter((g) => g.scalp_enabled);
        } catch (err) {
            logger.error('ScalpAlert group lookup failed:', err.message);
            return;
        }
        if (!scalpGroups.length) return;

        // Build each index's card once, however many groups follow it.
        const wanted = new Set();
        for (const g of scalpGroups) {
            for (const k of ScalpAlertService.indicesFor(g)) wanted.add(k);
        }

        for (const indexKey of wanted) {
            try {
                await this._scanIndex(indexKey, scalpGroups);
            } catch (err) {
                // One index failing must not stop the others.
                logger.error(`ScalpAlert ${indexKey} scan error:`, err.message);
            }
        }
    }

    async _scanIndex(indexKey, scalpGroups) {
        const cfg = resolveScalpIndex(indexKey);
        if (!cfg) {
            logger.warn(`ScalpAlert: unknown index ${indexKey}`);
            return;
        }

        const ctx = await this.scalpSvc.buildScalpCardWithContext(cfg.key);
        const card = ctx?.card;
        const snapshot = ctx?.snapshot;

        // Grade anything already open BEFORE the early returns below. A quiet
        // scan with no new setup is exactly when an open scalp is most likely to
        // be hitting its target, and returning early would leave it ungraded
        // until the next setup happened to appear.
        if (snapshot) {
            try {
                await scalpOutcomeTracker.resolveAgainst(cfg.key, snapshot);
            } catch (err) {
                logger.warn(`Scalp outcome resolve failed for ${cfg.key}: ${err.message}`);
            }
        }

        if (!card) return;
        // "not live" is the BSE settlement-price refusal: SENSEX returns
        // settlement figures outside live hours and alerting on those would
        // quote untradeable premiums as entries.
        if (
            card.includes('NO CLEAR SETUP')
            || card.includes('Could not fetch')
            || card.includes('is not live')
        ) return;

        // Trigger on any setup with 75%+ confidence (PRIMARY or SECONDARY)
        if (!card.includes('✅')) return;

        const setups = this._extractSetups(card, cfg.key);
        if (!setups.length) return;

        const now = Date.now();
        const freshSetups = setups.filter((s) => {
            const last = this._lastAlerts[s.fingerprint];
            if (!last) return true;
            return (now - last.timestamp) >= COOLDOWN_MS;
        });
        if (!freshSetups.length) return;

        const targets = scalpGroups.filter((g) =>
            ScalpAlertService.indicesFor(g).includes(cfg.key)
        );
        if (!targets.length) return;

        const alertMsg = this._buildAlertMsg(card, freshSetups, cfg);

        let sent = 0;
        for (const group of targets) {
            try {
                await this._sendMessage(group.group_id, { text: alertMsg });
                sent++;
                logger.info(`⚡ ${cfg.key} scalp alert sent to ${group.group_name || group.group_id}`);
            } catch (err) {
                logger.error(`Failed to send ${cfg.key} scalp alert to ${group.group_id}:`, err.message);
            }
        }

        // Only start the cooldown if the alert actually reached someone —
        // otherwise a transient send failure silences the setup for 10 minutes.
        if (!sent) return;
        for (const s of freshSetups) {
            this._lastAlerts[s.fingerprint] = { timestamp: now, strike: s.strike, entry: s.entry };
            // Journal what we just told people to trade, so it can be graded.
            try {
                await scalpOutcomeTracker.record(s, cfg, {
                    expiry: snapshot?.expiry ?? null,
                    spot: snapshot?.spot ?? null,
                    confidence: s.confidence ?? null,
                    groupId: targets[0]?.group_id ?? null,
                });
            } catch (err) {
                // Journalling must never cost an alert.
                logger.warn(`Scalp outcome record failed: ${err.message}`);
            }
        }
    }

    _isMarketOpen() {
        const now = new Date();

        // Weekday alone is not a trading day. The shared NSE calendar is what
        // TradeAlertController already gates on; this only checked Sat/Sun, so
        // it scanned and could alert straight through every market holiday.
        if (!isIndianEquityTradingDay(now.getTime())) return false;

        const parts = new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: 'numeric',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23',
        }).formatToParts(now);

        let hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
        if (hour === 24) hour = 0;
        const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);

        const timeMinutes = hour * 60 + minute;
        const openMinutes = MARKET_OPEN_HOUR * 60 + MARKET_OPEN_MIN;
        const closeMinutes = MARKET_CLOSE_HOUR * 60 + MARKET_CLOSE_MIN;

        if (timeMinutes < openMinutes || timeMinutes > closeMinutes) return false;

        // ── Closing Auction Session guard (live since 3 Aug 2026) ────────────
        // F&O stocks stop continuous trading at 15:15 and the index freezes
        // while the auction runs: measured over 24 post-CAS sessions, the 15:15
        // bar was flat in 92% of them and the 15:20 bar in 100% (avg range 0.00).
        // Every setup built in that window prices off a dead spot while options
        // keep trading to 15:40 — and the auction print then moves the index a
        // mean of 48 pts (vs 5.2 pts pre-CAS), so an 8-pt stop cannot be honoured.
        if (timeMinutes >= CAS_FREEZE_START_MIN && timeMinutes <= CAS_FREEZE_END_MIN) return false;

        return true;
    }

    /**
     * Extract setup details from card text.
     * Fingerprint = type:strike:entry — if any changes, it's a "new" setup.
     */
    _extractSetups(card, indexKey = 'NIFTY') {
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
                fingerprint: `${indexKey}:BUY CE:${strike}:${entry}`,
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
                fingerprint: `${indexKey}:BUY PE:${strike}:${entry}`,
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
                fingerprint: `${indexKey}:SHORT STRADDLE:${entry}`,
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
                fingerprint: `${indexKey}:SHORT STRANGLE:${entry}`,
            });
        }

        return setups;
    }

    _buildAlertMsg(card, setups, cfg = null) {
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
            `⚡ *SCALP ALERT${cfg ? ' · ' + cfg.label : ''}* — ${timeStr} IST`,
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
