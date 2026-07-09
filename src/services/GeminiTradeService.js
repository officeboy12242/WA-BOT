/**
 * Google Gemini for trade discovery, research brief, and CE/PE analysis.
 * Replaces GLM/NVIDIA for /tradelert and /tradenow.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TRADE_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];
const MAX_TRADE_TIMEOUT_MS = 180_000;

function shortModelName(model) {
    return String(model || '').replace(/^models\//, '').split('/').pop() || model;
}

function clampTimeoutMs(raw, cap = MAX_TRADE_TIMEOUT_MS) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 120_000;
    return Math.min(cap, Math.max(25_000, n));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function isGeminiRateLimitError(err) {
    const status = err?.response?.status;
    const msg = String(err?.response?.data?.error?.message || err?.message || err);
    return status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg);
}

function rateLimitDelayMs(attemptIndex) {
    return Math.min(12_000, 2000 * 2 ** attemptIndex);
}

export default class GeminiTradeService {
    constructor(cfg = config) {
        this.apiKey = (cfg.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();
        this.models = this._parseModelChain(cfg.GEMINI_TRADE_MODELS || cfg.GEMINI_TRADE_MODEL);
        this.tradeModel = this.models[0];
        this.tradeTimeoutMs = clampTimeoutMs(cfg.TRADE_ANALYSIS_TIMEOUT_MS || 150_000);
        this.researchTimeoutMs = clampTimeoutMs(
            cfg.TRADE_RESEARCH_TIMEOUT_MS || 55_000,
            90_000
        );
    }

    _parseModelChain(raw) {
        if (!raw) return [...DEFAULT_TRADE_MODELS];
        const parts = String(raw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return parts.length ? [...new Set(parts)] : [...DEFAULT_TRADE_MODELS];
    }

    getModelChain() {
        return [...this.models];
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ model?: string, maxTokens?: number, timeoutMs?: number, temperature?: number }} [opts]
     */
    async complete(systemPrompt, userPrompt, opts = {}) {
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is not configured');
        }

        const model = opts.model || this.tradeModel;
        const url = `${API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

        const body = {
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: {
                temperature: opts.temperature ?? 0.35,
                maxOutputTokens: opts.maxTokens ?? 8192,
            },
        };

        let data;
        try {
            ({ data } = await axios.post(url, body, {
                timeout: opts.timeoutMs ?? this.tradeTimeoutMs,
                headers: { 'Content-Type': 'application/json' },
                validateStatus: (s) => s >= 200 && s < 300,
            }));
        } catch (err) {
            if (isGeminiRateLimitError(err)) {
                const e = new Error('Gemini rate limit — please wait 30–60 seconds and try again');
                e.cause = err;
                e.isRateLimit = true;
                throw e;
            }
            throw err;
        }

        const parts = data?.candidates?.[0]?.content?.parts || [];
        let text = parts.map((p) => p?.text || '').join('').trim();

        if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
            throw new Error('Gemini blocked response (safety)');
        }
        if (!text) {
            throw new Error('Gemini empty response');
        }

        return text
            .replace(/^```(?:markdown|text)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
    }

    async _completeWithFallback(systemPrompt, userPrompt, opts = {}) {
        const chain = [...new Set((opts.models || this.models).filter(Boolean))];
        const attempts = [
            { prompt: userPrompt, maxTokens: opts.maxTokens ?? 2200, timeoutMs: opts.timeoutMs ?? this.tradeTimeoutMs },
            {
                prompt: userPrompt.slice(0, 9000) + (userPrompt.length > 9000 ? '\n\n[...trimmed...]' : ''),
                maxTokens: 2000,
                timeoutMs: Math.min(MAX_TRADE_TIMEOUT_MS, (opts.timeoutMs ?? this.tradeTimeoutMs) + 15_000),
            },
            {
                prompt: userPrompt.slice(0, 5000) + (userPrompt.length > 5000 ? '\n\n[...trimmed...]' : ''),
                maxTokens: 1800,
                timeoutMs: MAX_TRADE_TIMEOUT_MS,
            },
        ];

        let lastErr;
        let sawRateLimit = false;
        for (const model of chain) {
            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                for (let rateTry = 0; rateTry < 3; rateTry++) {
                    try {
                        if (i > 0 && rateTry === 0) {
                            logger.warn(
                                `Gemini trade retry ${i + 1} (${shortModelName(model)}, ${attempt.prompt.length} chars)`
                            );
                        }
                        const text = await this.complete(systemPrompt, attempt.prompt, {
                            model,
                            maxTokens: attempt.maxTokens,
                            timeoutMs: attempt.timeoutMs,
                        });
                        return { text, model: shortModelName(model) };
                    } catch (err) {
                        lastErr = err;
                        const msg = String(err?.response?.data?.error?.message || err?.message || err);
                        const status = err?.response?.status;
                        if (isGeminiRateLimitError(err)) {
                            sawRateLimit = true;
                            if (rateTry < 2) {
                                const waitMs = rateLimitDelayMs(rateTry);
                                logger.warn(
                                    `Gemini rate limited (${shortModelName(model)}) — retry ${rateTry + 1}/3 in ${waitMs}ms`
                                );
                                await sleep(waitMs);
                                continue;
                            }
                            logger.warn(`Gemini rate limited (${shortModelName(model)}) — trying next model`);
                            break;
                        }
                        if (status === 404 || /not found|invalid.*model/i.test(msg)) {
                            break;
                        }
                        if (!this.isTimeoutError(err) && i === attempts.length - 1) {
                            break;
                        }
                        break;
                    }
                }
            }
        }
        if (sawRateLimit) {
            throw new Error('Gemini rate limit — please wait 30–60 seconds and try again');
        }
        throw lastErr || new Error('All Gemini trade models failed');
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this._completeWithFallback(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 900,
            timeoutMs: opts.timeoutMs ?? this.researchTimeoutMs,
        });
        return text;
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const { text, model } = await this._completeWithFallback(systemPrompt, userPrompt, opts);
        logger.info(`Gemini trade analysis done (${model})`);
        return text;
    }
}

export const geminiTradeService = new GeminiTradeService();
