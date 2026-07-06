/**
 * Google Gemini API for /fix and self-heal code proposals.
 * JSON-mode responses + model fallback — more reliable than GLM for exact replacements.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

function shortModelName(model) {
    return String(model || '').replace(/^models\//, '').split('/').pop() || model;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export default class GeminiHealService {
    constructor(cfg = config) {
        this.apiKey = (cfg.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
        this.models = this._parseModelChain(cfg.GEMINI_HEAL_MODELS || cfg.GEMINI_HEAL_MODEL);
    }

    _parseModelChain(raw) {
        if (!raw) return [...DEFAULT_MODELS];
        const parts = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return parts.length ? [...new Set(parts)] : [...DEFAULT_MODELS];
    }

    getModelChain() {
        return [...this.models];
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
     */
    async complete(systemPrompt, userPrompt, opts = {}) {
        const model = opts.model || this.models[0];
        const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userPrompt }],
                },
            ],
            systemInstruction: {
                parts: [{ text: systemPrompt }],
            },
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: opts.maxTokens ?? 8192,
                responseMimeType: 'application/json',
            },
        };

        const { data } = await axios.post(url, body, {
            timeout: opts.timeoutMs ?? 120_000,
            headers: { 'Content-Type': 'application/json' },
            validateStatus: (s) => s >= 200 && s < 300,
        });

        const parts = data?.candidates?.[0]?.content?.parts || [];
        let text = parts.map((p) => p?.text || '').join('').trim();

        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Gemini blocked response (safety)');
        }
        if (!text) {
            throw new Error('Gemini empty response');
        }

        // Strip accidental markdown fences
        text = text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        return text;
    }

    /**
     * @param {string[]} [models]
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ maxTokens?: number, onProgress?: (line: string) => void|Promise<void> }} [opts]
     * @returns {Promise<{ content: string, model: string }>}
     */
    async completeWithModelFallback(models, systemPrompt, userPrompt, opts = {}) {
        const chain = [...new Set((models || this.models).filter(Boolean))];
        if (!chain.length) chain.push(...DEFAULT_MODELS);
        if (!this.isConfigured()) {
            throw new Error('GEMINI_API_KEY not configured');
        }

        const progress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};

        const attempts = [
            { prompt: userPrompt, maxTokens: opts.maxTokens ?? 8192, timeoutMs: 120_000 },
            {
                prompt:
                    userPrompt.slice(0, 10_000) +
                    (userPrompt.length > 10_000 ? '\n\n[...truncated for retry...]' : ''),
                maxTokens: 6000,
                timeoutMs: 120_000,
            },
            {
                prompt:
                    userPrompt.slice(0, 6_000) +
                    (userPrompt.length > 6_000 ? '\n\n[...truncated for retry...]' : ''),
                maxTokens: 4000,
                timeoutMs: 90_000,
            },
        ];

        let lastErr;
        for (const model of chain) {
            const label = shortModelName(model);
            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                try {
                    await progress(
                        i === 0
                            ? `🤖 Gemini *${label}* analyzing code…`
                            : `🤖 Gemini *${label}* retry (${i + 1}/${attempts.length}, smaller prompt)…`,
                    );
                    const content = await this.complete(systemPrompt, attempt.prompt, {
                        model,
                        maxTokens: attempt.maxTokens,
                        timeoutMs: attempt.timeoutMs,
                    });
                    await progress(`✅ Gemini *${label}* responded`);
                    return { content, model: `gemini/${label}` };
                } catch (err) {
                    lastErr = err;
                    const msg = String(err?.response?.data?.error?.message || err?.message || err);
                    const status = err?.response?.status;
                    logger.warn(`Gemini heal failed (${model}): ${msg}`);

                    if (status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg)) {
                        await progress(`⚠️ *${label}* rate limited — next model…`);
                        await sleep(800);
                        break;
                    }
                    if (status === 404 || /not found|invalid.*model/i.test(msg)) {
                        await progress(`⚠️ *${label}* unavailable — next model…`);
                        break;
                    }
                    if (/503|502|504|unavailable|overloaded/i.test(msg)) {
                        await progress(`⚠️ *${label}* busy — next model…`);
                        break;
                    }

                    const retryable = /timeout|ECONNRESET|empty response|socket/i.test(msg);
                    if (!retryable || i === attempts.length - 1) {
                        await progress(`⚠️ *${label}* failed — next model…`);
                        break;
                    }
                    await progress(`⚠️ *${label}* timeout — retrying…`);
                }
            }
        }

        throw lastErr || new Error('All Gemini heal models failed');
    }
}

export const geminiHealService = new GeminiHealService();
