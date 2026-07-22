/**
 * OmniRoute OpenAI-compatible gateway client.
 * OmniRoute runs separately (npm i -g omniroute); this bot only calls /v1.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

/** Normalize to .../v1 (no trailing slash after v1). */
export function normalizeOmniRouteBaseUrl(raw) {
    let u = String(raw || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (!/\/v1$/i.test(u)) {
        u = `${u}/v1`;
    }
    return u;
}

export function isOmniRouteFallbackError(err) {
    const status = err?.response?.status || err?.status;
    const msg = String(err?.message || err);
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return /rate.?limit|quota|timeout|ETIMEDOUT|ECONNABORTED|ECONNREFUSED|empty response|overloaded|unavailable/i.test(
        msg
    );
}

/** Prepend omniroute when configured unless already listed. */
export function withOmniRouteFirst(order, omniConfigured) {
    const list = (order || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (!omniConfigured) {
        return list.filter((p) => p !== 'omniroute');
    }
    if (list.includes('omniroute')) return list;
    return ['omniroute', ...list];
}

export default class OmniRouteLlmService {
    constructor(cfg = config) {
        this.config = cfg;
        this.baseUrl = normalizeOmniRouteBaseUrl(cfg.OMNIROUTE_BASE_URL);
        this.apiKey = (cfg.OMNIROUTE_API_KEY || '').trim();
        this.model = (cfg.OMNIROUTE_MODEL || 'auto').trim() || 'auto';
        this.timeoutMs = Math.min(
            120_000,
            Math.max(15_000, Number(cfg.OMNIROUTE_TIMEOUT_MS) || 60_000)
        );
    }

    isConfigured() {
        return Boolean(this.baseUrl && this.apiKey);
    }

    get completionsUrl() {
        return `${this.baseUrl}/chat/completions`;
    }

    async chat({ system, user, messages, temperature = 0.2, maxTokens = 4000, timeoutMs } = {}) {
        if (!this.isConfigured()) {
            throw new Error('OmniRoute is not configured (OMNIROUTE_BASE_URL + OMNIROUTE_API_KEY)');
        }

        const msgs = messages?.length
            ? messages
            : [
                  ...(system ? [{ role: 'system', content: system }] : []),
                  { role: 'user', content: user || '' },
              ];

        const { data } = await axios.post(
            this.completionsUrl,
            {
                model: this.model,
                messages: msgs,
                temperature,
                max_tokens: maxTokens,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: timeoutMs || this.timeoutMs,
            }
        );

        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('empty OmniRoute response');
        const usedModel = data?.model || this.model;
        return { text, provider: 'omniroute', model: usedModel };
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
        logger.info('OmniRoute trade analysis done');
        return text;
    }
}

export const omniRouteLlmService = new OmniRouteLlmService();
