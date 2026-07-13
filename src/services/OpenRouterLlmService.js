/**
 * OpenRouter chat completions — fallback when Gemini/Groq/NVIDIA fail.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-4-31b-it:free',
    'qwen/qwen3-coder:free',
];

function parseList(raw, fallback) {
    const parts = String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return parts.length ? parts : [...fallback];
}

export function isOpenRouterRateLimitError(err) {
    const status = err?.response?.status || err?.status;
    const msg = String(err?.message || err);
    return status === 429 || status === 402 || /rate.?limit|quota|credit|exhausted/i.test(msg);
}

export default class OpenRouterLlmService {
    constructor(cfg = config) {
        this.config = cfg;
        this.apiKey = (cfg.OPENROUTER_API_KEY || '').trim();
        const fromCfg = [cfg.OPENROUTER_MODEL, ...(cfg.OPENROUTER_FALLBACK_MODELS || [])].filter(Boolean);
        this.models = parseList(cfg.OPENROUTER_MODELS, fromCfg.length ? fromCfg : DEFAULT_MODELS);
        this.tradeModel = this.models[0];
        this.timeoutMs = Math.min(120_000, Math.max(30_000, Number(cfg.OPENROUTER_TIMEOUT_MS) || 90_000));
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    async chat({ system, user, messages, temperature = 0.2, maxTokens = 4000, timeoutMs } = {}) {
        if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

        let lastErr;
        for (const model of this.models) {
            try {
                const msgs = messages?.length
                    ? messages
                    : [
                          ...(system ? [{ role: 'system', content: system }] : []),
                          { role: 'user', content: user || '' },
                      ];
                const { data } = await axios.post(
                    OPENROUTER_URL,
                    {
                        model,
                        messages: msgs,
                        temperature,
                        max_tokens: maxTokens,
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            'HTTP-Referer': this.config.PUBLIC_URL || 'https://github.com/officeboy12242/WA-BOT',
                            'X-Title': 'WA-BOT',
                        },
                        timeout: timeoutMs || this.timeoutMs,
                    },
                );
                const text = data?.choices?.[0]?.message?.content?.trim();
                if (!text) throw new Error('empty OpenRouter response');
                return { text, provider: 'openrouter', model };
            } catch (err) {
                lastErr = err;
                logger.warn(`OpenRouter ${model} failed: ${err.message}`);
                if (isOpenRouterRateLimitError(err)) continue;
            }
        }
        throw lastErr || new Error('All OpenRouter models failed');
    }

    async complete(systemPrompt, userPrompt, opts = {}) {
        const { text } = await this.chat({
            system: systemPrompt,
            user: userPrompt,
            temperature: opts.temperature ?? 0.2,
            maxTokens: opts.maxTokens ?? 4000,
            timeoutMs: opts.timeoutMs,
        });
        return text;
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        return this.complete(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 900,
            timeoutMs: opts.timeoutMs ?? 55_000,
        });
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const text = await this.complete(systemPrompt, userPrompt, {
            ...opts,
            maxTokens: opts.maxTokens ?? 4000,
            timeoutMs: opts.timeoutMs ?? 120_000,
        });
        logger.info('OpenRouter trade analysis done');
        return text;
    }
}

export const openRouterLlmService = new OpenRouterLlmService();
