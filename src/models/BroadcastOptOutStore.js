/**
 * Who must never be broadcast to again.
 *
 * WhatsApp's bulk-messaging detection keys mostly off recipient behaviour —
 * blocks and "report spam" taps. Honouring an opt-out is the one lever that
 * reduces those directly; pacing only changes how fast you reach the same
 * annoyed people.
 *
 * Keyed by phone number, not JID, so an opt-out survives a member being
 * re-scraped from a different group under a different LID.
 */

import { logger } from '../utils/logger.js';
import { normalizePhoneNumber, extractPhoneNumber } from '../utils/permissions.js';

/** Recognised in any language people actually type it in. */
const OPT_OUT_PATTERNS = [
    /^\s*stop\s*$/i,
    /^\s*unsubscribe\s*$/i,
    /^\s*opt\s*-?\s*out\s*$/i,
    /^\s*remove\s+me\s*$/i,
    /^\s*don'?t\s+message\s+me\s*$/i,
    /^\s*band\s+karo\s*$/i,
    /^\s*mat\s+bhejo\s*$/i,
];

const OPT_IN_PATTERNS = [/^\s*start\s*$/i, /^\s*subscribe\s*$/i, /^\s*resume\s*$/i];

/** @returns {'out'|'in'|null} */
export function classifyOptMessage(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 40) return null; // a sentence containing "stop" is not a command
    if (OPT_OUT_PATTERNS.some((re) => re.test(t))) return 'out';
    if (OPT_IN_PATTERNS.some((re) => re.test(t))) return 'in';
    return null;
}

/** Phone key for any JID or raw number. Returns '' when not derivable. */
export function optOutKey(value) {
    const raw = String(value || '');
    const phone = normalizePhoneNumber(extractPhoneNumber(raw.split('@')[0]));
    return /^\d{10,15}$/.test(phone) ? phone : '';
}

class BroadcastOptOutStore {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.col = null;
        /** Hot set so the send loop never waits on Mongo per recipient. */
        this._cache = new Set();
        this._loaded = false;
    }

    async init() {
        this.col = this.mongoDb.collection('broadcast_opt_outs');
        await this.col.createIndex({ phone: 1 }, { unique: true, name: 'broadcast_opt_out_phone' });
        await this.refresh();
        logger.info(`🚫 Broadcast opt-out list ready (${this._cache.size} suppressed)`);
    }

    async refresh() {
        if (!this.col) return;
        try {
            const rows = await this.col.find({}, { projection: { phone: 1 } }).toArray();
            this._cache = new Set(rows.map((r) => r.phone).filter(Boolean));
            this._loaded = true;
        } catch (err) {
            logger.warn(`Opt-out refresh failed: ${err.message}`);
        }
    }

    /**
     * @param {string} value phone or JID
     * @returns {Promise<boolean>} true when newly suppressed
     */
    async optOut(value, { reason = 'user_request', source = null } = {}) {
        const phone = optOutKey(value);
        if (!phone || !this.col) return false;
        const already = this._cache.has(phone);
        this._cache.add(phone);
        await this.col.updateOne(
            { phone },
            { $set: { phone, reason, source, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
            { upsert: true }
        );
        if (!already) logger.info(`🚫 Broadcast opt-out: ${phone} (${reason})`);
        return !already;
    }

    /** @returns {Promise<boolean>} true when they were actually suppressed before */
    async optIn(value) {
        const phone = optOutKey(value);
        if (!phone || !this.col) return false;
        const had = this._cache.delete(phone);
        await this.col.deleteOne({ phone });
        if (had) logger.info(`✅ Broadcast opt-in restored: ${phone}`);
        return had;
    }

    isOptedOut(value) {
        const phone = optOutKey(value);
        return phone ? this._cache.has(phone) : false;
    }

    /** Drop suppressed recipients from a JID list. */
    filter(jids = []) {
        return jids.filter((jid) => !this.isOptedOut(jid));
    }

    get size() {
        return this._cache.size;
    }

    get loaded() {
        return this._loaded;
    }
}

export default BroadcastOptOutStore;
