/**
 * Self-hosted short links with TTL (stored in MongoDB).
 */

import crypto from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

/** Public so UrlShortener can align its memory cache under this TTL. */
export const LINK_TTL_MS = 7 * 60 * 60 * 1000; // 7 hours
/** Reuse an existing /d/ code only if it still has at least this long left. */
const MIN_REUSE_REMAINING_MS = 60 * 60 * 1000; // 1 hour

class ShortLinkService {
    constructor() {
        this.collection = null;
        this._warnedLocalhost = false;
    }

    async init(mongoDb) {
        this.collection = mongoDb.collection('short_links');
        await this.collection.createIndex({ code: 1 }, { unique: true });
        await this.collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        logger.info('Short link store ready (7h expiry)');
    }

    getPublicBaseUrl() {
        // Resolve at call time so Koyeb/Render injected vars + learned Host are live.
        const base =
            resolvePublicBaseUrl() ||
            config.PUBLIC_URL ||
            `http://localhost:${process.env.PORT || 3000}`;
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base) && !this._warnedLocalhost) {
            this._warnedLocalhost = true;
            logger.warn(
                'Movie short links using localhost — waiting for KOYEB_PUBLIC_DOMAIN / RENDER_EXTERNAL_URL ' +
                    'or an inbound public request to learn the host'
            );
        }
        return String(base).replace(/\/$/, '');
    }

    async _generateCode() {
        for (let i = 0; i < 5; i++) {
            const code = crypto.randomBytes(4).toString('base64url');
            const exists = await this.collection.findOne({ code }, { projection: { _id: 1 } });
            if (!exists) return code;
        }
        throw new Error('Failed to generate unique short code');
    }

    /**
     * @returns {{ url: string, code: string, expiresAt: number }}
     */
    async shorten(longUrl) {
        const now = new Date();
        const reuseAfter = new Date(now.getTime() + MIN_REUSE_REMAINING_MS);
        const existing = await this.collection.findOne({
            long_url: longUrl,
            expires_at: { $gt: reuseAfter },
        });
        if (existing) {
            return {
                url: `${this.getPublicBaseUrl()}/d/${existing.code}`,
                code: existing.code,
                expiresAt: new Date(existing.expires_at).getTime(),
            };
        }

        const code = await this._generateCode();
        const expiresAt = new Date(Date.now() + LINK_TTL_MS);
        await this.collection.insertOne({
            code,
            long_url: longUrl,
            expires_at: expiresAt,
            created_at: now,
        });

        return {
            url: `${this.getPublicBaseUrl()}/d/${code}`,
            code,
            expiresAt: expiresAt.getTime(),
        };
    }

    async resolve(code) {
        if (!code || !this.collection) return null;
        const doc = await this.collection.findOne({ code });
        if (!doc || doc.expires_at <= new Date()) return null;
        return doc.long_url;
    }
}

export const shortLinkService = new ShortLinkService();
export default ShortLinkService;
