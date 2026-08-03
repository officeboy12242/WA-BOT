/**
 * Trade LLM router: Gemini → Groq → NVIDIA → OpenRouter fallback chain.
 * Rate-limited providers are cooled so the next symbol skips straight to a working one.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import GeminiTradeService, { isGeminiRateLimitError } from './GeminiTradeService.js';
import GroqTradeService, { isGroqRateLimitError } from './GroqTradeService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import OpenRouterLlmService, { isOpenRouterRateLimitError } from './OpenRouterLlmService.js';

const DEFAULT_PROVIDER_ORDER = ['gemini', 'groq', 'nvidia', 'openrouter'];
/** After a 429, skip this provider for a bit (shared across daily scan symbols). */
const DEFAULT_COOLDOWN_MS = 90_000;

export function isTradeLlmRateLimitError(err) {
    if (err?.isRateLimit) return true;
    if (isGeminiRateLimitError(err) || isGroqRateLimitError(err) || isOpenRouterRateLimitError(err)) {
        return true;
    }
    const status = err?.response?.status ?? err?.cause?.response?.status;
    const msg = String(
        err?.response?.data?.error?.message ||
            err?.cause?.response?.data?.error?.message ||
            err?.message ||
            err
    );
    return (
        status === 429 ||
        /rate limit|quota|resource.?exhausted|too many requests|switching provider/i.test(msg)
    );
}

export function isTradeLlmFallbackError(err) {
    const msg = String(err?.message || err);
    const status = err?.response?.status ?? err?.cause?.response?.status;
    if (isTradeLlmRateLimitError(err)) return true;
    if (status === 503 || status === 502 || status === 504) return true;
    if (/timeout|ETIMEDOUT|ECONNABORTED|empty response|503|502|504|overloaded|unavailable/i.test(msg)) {
        return true;
    }
    return false;
}

export default class TradeLlmRouterService {
    constructor(cfg = config) {
        this.config = cfg;
        this.gemini = new GeminiTradeService(cfg);
        this.groq = new GroqTradeService(cfg);
        this.nvidia = new NvidiaDeepSeekService(cfg);
        this.openrouter = new OpenRouterLlmService(cfg);
        this.providerOrder = this._parseProviderOrder(cfg.TRADE_LLM_PROVIDERS);
        this.lastProvider = null;
        /** @type {Map<string, number>} provider → cooledUntil epoch ms */
        this._cooledUntil = new Map();
        this.cooldownMs = Math.max(
            15_000,
            Math.min(5 * 60_000, Number(cfg.TRADE_LLM_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS)
        );
    }

    _parseProviderOrder(raw) {
        const allowed = new Set(DEFAULT_PROVIDER_ORDER);
        const parts = String(raw || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => allowed.has(s));
        return parts.length ? parts : [...DEFAULT_PROVIDER_ORDER];
    }

    _providers() {
        const map = {
            gemini: { name: 'gemini', svc: this.gemini, label: () => `Gemini ${this.gemini.tradeModel}` },
            groq: { name: 'groq', svc: this.groq, label: () => `Groq ${this.groq.tradeModel}` },
            nvidia: {
                name: 'nvidia',
                svc: this.nvidia,
                label: () => `NVIDIA ${this.nvidia.tradeModel}`,
            },
            openrouter: {
                name: 'openrouter',
                svc: this.openrouter,
                label: () => `OpenRouter ${this.openrouter.tradeModel}`,
            },
        };
        return this.providerOrder
            .map((key) => map[key])
            .filter((p) => p && p.svc.isConfigured());
    }

    /** Prefer live providers; cooled (rate-limited) ones go last. */
    _providersForAttempt() {
        const now = Date.now();
        const all = this._providers();
        const live = [];
        const cooled = [];
        for (const p of all) {
            const until = this._cooledUntil.get(p.name) || 0;
            if (until > now) cooled.push(p);
            else live.push(p);
        }
        return [...live, ...cooled];
    }

    _markCooled(name) {
        const until = Date.now() + this.cooldownMs;
        this._cooledUntil.set(name, until);
        logger.warn(
            `Trade LLM provider ${name} cooled for ${Math.round(this.cooldownMs / 1000)}s after rate limit`
        );
    }

    isConfigured() {
        return this._providers().length > 0;
    }

    getModelChain() {
        return this._providers().map((p) => p.label());
    }

    getPrimaryLabel() {
        const providers = this._providersForAttempt();
        if (!providers.length) return 'none';
        return providers[0].label();
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async _route(method, systemPrompt, userPrompt, opts = {}) {
        const providers = this._providersForAttempt();
        if (!providers.length) {
            throw new Error(
                'No trade LLM configured (set GEMINI_API_KEY, GROQ_API_KEY, NVIDIA_API_KEY, or OPENROUTER_API_KEY)'
            );
        }

        let lastErr;
        let sawRateLimit = false;
        for (let i = 0; i < providers.length; i++) {
            const provider = providers[i];
            const cooledUntil = this._cooledUntil.get(provider.name) || 0;
            if (cooledUntil > Date.now() && i < providers.length - 1) {
                // Still have another provider — skip cooled one entirely
                logger.info(`Trade LLM skipping cooled provider ${provider.name}`);
                continue;
            }
            try {
                if (!provider.svc[method]) {
                    throw new Error(`${provider.name} missing ${method}`);
                }
                const text = await provider.svc[method](systemPrompt, userPrompt, opts);
                this.lastProvider = provider.name;
                if (i > 0 || this._cooledUntil.has(provider.name)) {
                    logger.info(`Trade LLM fallback succeeded via ${provider.name}`);
                }
                return text;
            } catch (err) {
                lastErr = err;
                const rateLimited = isTradeLlmRateLimitError(err);
                if (rateLimited) {
                    sawRateLimit = true;
                    this._markCooled(provider.name);
                }
                const hasNext = i < providers.length - 1;
                if (hasNext && isTradeLlmFallbackError(err)) {
                    logger.warn(
                        `Trade ${provider.name} failed — trying next provider: ${err.message}`
                    );
                    continue;
                }
                throw err;
            }
        }
        if (sawRateLimit) {
            const e = new Error(
                'All trade LLM providers rate limited — wait 30–60 seconds and try `/tradenow` again.'
            );
            e.isRateLimit = true;
            e.cause = lastErr;
            throw e;
        }
        throw lastErr || new Error('All trade LLM providers failed');
    }

    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        return this._route('completeTrade', systemPrompt, userPrompt, opts);
    }

    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        return this._route('completeTradeAnalysis', systemPrompt, userPrompt, opts);
    }
}

export const tradeLlmRouterService = new TradeLlmRouterService();
