/**
 * Per-user base resume text (Mongo).
 */

import { logger } from '../utils/logger.js';
import { normalizePhoneNumber } from '../utils/permissions.js';

class ResumeProfileStore {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.collection = null;
    }

    async init() {
        this.collection = this.mongoDb.collection('resume_profiles');
        await Promise.all([
            this.collection.createIndex({ phone: 1 }, { unique: true, name: 'resume_phone' }),
            this.collection.createIndex({ chat_id: 1 }, { name: 'resume_chat_id' }),
        ]);
        logger.info('Mongo resume profile store ready');
    }

    /**
     * @param {object} params
     * @param {string} params.phone
     * @param {string} [params.chatId]
     * @param {string} params.text
     * @param {string} [params.fileName]
     * @param {string} [params.kind]
     * @param {object|null} [params.palette] sampled PDF colors for export match
     * @param {object|null} [params.typography] detected PDF font family + header align
     */
    async saveBase({ phone, chatId, text, fileName, kind, palette, typography }) {
        const key = normalizePhoneNumber(phone) || String(phone || '').trim();
        if (!key) throw new Error('Missing phone for resume profile');

        await this.collection.updateOne(
            { phone: key },
            {
                $set: {
                    phone: key,
                    chat_id: chatId || '',
                    text: String(text || ''),
                    file_name: fileName || '',
                    kind: kind || '',
                    palette: palette && typeof palette === 'object' ? palette : null,
                    typography: typography && typeof typography === 'object' ? typography : null,
                    updated_at: new Date(),
                },
                $setOnInsert: { created_at: new Date() },
            },
            { upsert: true }
        );
        return this.getByPhone(key);
    }

    async getByPhone(phone) {
        const key = normalizePhoneNumber(phone) || String(phone || '').trim();
        if (!key) return null;
        return this.collection.findOne({ phone: key });
    }

    /**
     * @param {string} phone
     * @param {string} [chatId]
     * @param {{ jdText?: string, tailoredText?: string, gapsText?: string }} patch
     */
    async saveTailorResult(phone, chatId, patch) {
        const key = normalizePhoneNumber(phone) || String(phone || '').trim();
        if (!key) throw new Error('Missing phone');
        await this.collection.updateOne(
            { phone: key },
            {
                $set: {
                    phone: key,
                    ...(chatId ? { chat_id: chatId } : {}),
                    last_jd: String(patch.jdText || '').slice(0, 40_000),
                    last_tailored: String(patch.tailoredText || '').slice(0, 80_000),
                    last_gaps: String(patch.gapsText || '').slice(0, 8_000),
                    tailored_at: new Date(),
                    updated_at: new Date(),
                },
                $setOnInsert: { created_at: new Date(), text: '' },
            },
            { upsert: true }
        );
    }

    /**
     * Persist latest ATS / recruiter scan (general and optional JD match).
     * @param {string} phone
     * @param {string} [chatId]
     * @param {{ analysis: object, hasJd?: boolean, jdText?: string, fileName?: string }} patch
     */
    async saveAtsResult(phone, chatId, patch) {
        const key = normalizePhoneNumber(phone) || String(phone || '').trim();
        if (!key) throw new Error('Missing phone');
        const analysis = patch?.analysis && typeof patch.analysis === 'object' ? patch.analysis : null;
        if (!analysis) throw new Error('Missing ATS analysis');

        await this.collection.updateOne(
            { phone: key },
            {
                $set: {
                    phone: key,
                    ...(chatId ? { chat_id: chatId } : {}),
                    last_ats: analysis,
                    last_ats_has_jd: Boolean(patch.hasJd),
                    last_ats_jd: String(patch.jdText || '').slice(0, 40_000),
                    last_ats_file: String(patch.fileName || '').slice(0, 200),
                    last_ats_at: new Date(),
                    updated_at: new Date(),
                },
                $setOnInsert: { created_at: new Date(), text: '' },
            },
            { upsert: true }
        );
    }
}

export default ResumeProfileStore;
