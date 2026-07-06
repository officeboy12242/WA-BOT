/**
 * Owner DM assistant — Gemini replies as Jacky when assist mode is on.
 * DMs only; never groups.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { buildAssistSystemPrompt } from '../prompts/assistPrompt.js';
import {
    extractPhoneNumber,
    isDirectMessage,
    isBotSelfChat,
} from '../utils/permissions.js';
import { safeSendMessage } from '../utils/waMessage.js';
import { extractInstagramUrl } from '../utils/instagramUrl.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'];

class AssistService {
    /**
     * @param {object} cfg
     * @param {import('../models/BotSettings.js').default} botSettings
     * @param {import('../models/GroupManager.js').default} groupManager
     * @param {import('mongodb').Db|null} mongoDb
     */
    constructor(cfg = config, botSettings = null, groupManager = null, mongoDb = null) {
        this.config = cfg;
        this.botSettings = botSettings;
        this.groupManager = groupManager;
        this.ownerName = (cfg.ASSIST_OWNER_NAME || 'Jacky').trim() || 'Jacky';
        this.apiKey = (cfg.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
        this.models = String(cfg.ASSIST_GEMINI_MODELS || cfg.ASSIST_GEMINI_MODEL || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (!this.models.length) {
            this.models = [...DEFAULT_MODELS];
        }
        this.maxHistory = Math.max(4, Number(cfg.ASSIST_MAX_HISTORY) || 12);
        this.cooldownMs = Math.max(1500, Number(cfg.ASSIST_REPLY_COOLDOWN_MS) || 3500);
        this.timeoutMs = Math.min(60_000, Math.max(15_000, Number(cfg.ASSIST_TIMEOUT_MS) || 45_000));
        this._enabled = false;
        this._lastReplyAt = new Map();
        this._collection = mongoDb ? mongoDb.collection('assist_conversations') : null;
    }

    async init() {
        if (this._collection) {
            await this._collection.createIndex({ chat_id: 1 }, { unique: true, name: 'assist_chat_id' });
            await this._collection.createIndex(
                { updated_at: 1 },
                { expireAfterSeconds: 7 * 24 * 60 * 60, name: 'assist_ttl' }
            );
        }
        if (this.botSettings) {
            this._enabled = await this.botSettings.getAssistModeEnabled();
            if (this._enabled) {
                logger.info(`🤖 Assist mode ON — DMs will reply as ${this.ownerName} (Gemini)`);
            }
        }
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    async isEnabled() {
        if (this.botSettings) {
            this._enabled = await this.botSettings.getAssistModeEnabled();
        }
        return this._enabled;
    }

    async setEnabled(on) {
        this._enabled = Boolean(on);
        if (this.botSettings) {
            await this.botSettings.setAssistModeEnabled(this._enabled);
        }
        logger.info(`🤖 Assist mode ${this._enabled ? 'ON' : 'OFF'} (${this.ownerName})`);
        return this._enabled;
    }

    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} chatId
     * @param {string} messageText
     * @param {string} senderJid
     * @param {import('baileys').proto.IWebMessageInfo} [originalMsg]
     * @returns {Promise<boolean>} true if assist handled the message
     */
    async maybeReply(sock, chatId, messageText, senderJid, originalMsg = null) {
        const text = String(messageText || '').trim();
        if (!text || text.startsWith('/')) {
            return false;
        }
        if (!isDirectMessage(chatId) || isBotSelfChat(sock, chatId)) {
            return false;
        }
        if (!(await this.isEnabled())) {
            return false;
        }
        if (!this.isConfigured()) {
            logger.warn('Assist mode on but GEMINI_API_KEY missing');
            return false;
        }

        const senderPhone = extractPhoneNumber(senderJid);
        if (this.groupManager?.isOwner(senderPhone)) {
            return false;
        }

        const igUrl = extractInstagramUrl(text);
        if (igUrl && text.replace(igUrl, '').trim().length < 8) {
            return false;
        }

        const now = Date.now();
        const last = this._lastReplyAt.get(chatId) || 0;
        if (now - last < this.cooldownMs) {
            return false;
        }

        const pushName = (originalMsg?.pushName || '').trim() || 'there';

        try {
            const reply = await this._generateReply(chatId, text, pushName);
            if (!reply) {
                return false;
            }

            this._lastReplyAt.set(chatId, Date.now());
            await safeSendMessage(sock, chatId, { text: reply }, originalMsg);
            logger.info(`🤖 Assist reply as ${this.ownerName} → ${chatId.slice(0, 20)}… (${reply.length} chars)`);
            return true;
        } catch (err) {
            logger.error(`Assist reply failed: ${err.message}`);
            return false;
        }
    }

    async _generateReply(chatId, userText, pushName) {
        const history = await this._loadHistory(chatId);
        const systemPrompt = buildAssistSystemPrompt(this.ownerName);

        const contents = [];
        for (const turn of history) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.text }],
            });
        }

        const userBlock = pushName && pushName !== 'there'
            ? `[${pushName}]: ${userText}`
            : userText;

        contents.push({
            role: 'user',
            parts: [{ text: userBlock }],
        });

        let lastErr;
        for (const model of this.models) {
            try {
                const reply = await this._callGemini(model, systemPrompt, contents);
                if (!reply) {
                    throw new Error('Empty Gemini reply');
                }
                await this._saveHistory(chatId, userBlock, reply);
                return reply;
            } catch (err) {
                lastErr = err;
                logger.warn(`Assist Gemini ${model} failed: ${err.message}`);
            }
        }
        throw lastErr || new Error('Assist Gemini failed');
    }

    async _callGemini(model, systemPrompt, contents) {
        const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

        const { data } = await axios.post(
            url,
            {
                contents,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    temperature: 0.75,
                    maxOutputTokens: 512,
                },
            },
            {
                timeout: this.timeoutMs,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (s) => s >= 200 && s < 300,
            }
        );

        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p) => p?.text || '').join('').trim();

        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Gemini safety block');
        }

        return text.slice(0, 2000);
    }

    async _loadHistory(chatId) {
        if (!this._collection) {
            return [];
        }
        const row = await this._collection.findOne({ chat_id: chatId });
        const messages = Array.isArray(row?.messages) ? row.messages : [];
        return messages.slice(-this.maxHistory);
    }

    async _saveHistory(chatId, userText, assistantText) {
        if (!this._collection) {
            return;
        }
        const push = [
            { role: 'user', text: userText.slice(0, 800), at: new Date() },
            { role: 'assistant', text: assistantText.slice(0, 800), at: new Date() },
        ];

        await this._collection.updateOne(
            { chat_id: chatId },
            {
                $push: {
                    messages: {
                        $each: push,
                        $slice: -this.maxHistory,
                    },
                },
                $set: { updated_at: new Date() },
            },
            { upsert: true }
        );
    }

    async clearHistory(chatId) {
        if (!this._collection || !chatId) {
            return;
        }
        await this._collection.deleteOne({ chat_id: chatId });
    }
}

export default AssistService;
