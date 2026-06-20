/**
 * Self-hosted short links with TTL (stored in MongoDB).
 */

import crypto from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const LINK_TTL_MS = 7 * 60 * 60 * 1000; // 7 hours

class ShortLinkService {
    constructor() {
        this.collection = null;
    }

    async init(mongoDb) {
        this.collection = mongoDb.collection('short_links');
        await this.collection.createIndex({ code: 1 }, { unique: true });
        await this.collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
        logger.info('Short link store ready (7h expiry)');
    }

    getPublicBaseUrl() {
        const base = config.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
        return base.replace(/\/$/, '');
    }

    async _generateCode() {
        for (let i = 0; i < 5; i++) {
            const code = crypto.randomBytes(4).toString('base64url');
            const exists = await this.collection.findOne({ code }, { projection: { _id: 1 } });
            if (!exists) return code;
        }
        throw new Error('Failed to generate unique short code');
    }

    async shorten(longUrl) {
        const now = new Date();
        const existing = await this.collection.findOne({
            long_url: longUrl,
            expires_at: { $gt: now },
        });
        if (existing) {
            return `${this.getPublicBaseUrl()}/d/${existing.code}`;
        }

        const code = await this._generateCode();
        const expiresAt = new Date(Date.now() + LINK_TTL_MS);
        await this.collection.insertOne({
            code,
            long_url: longUrl,
            expires_at: expiresAt,
            created_at: now,
        });

        return `${this.getPublicBaseUrl()}/d/${code}`;
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
