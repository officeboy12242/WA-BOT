/**
 * Trade LLM router: Gemini → Groq → NVIDIA → OpenRouter fallback chain.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import GeminiTradeService, { isGeminiRateLimitError } from './GeminiTradeService.js';
import GroqTradeService, { isGroqRateLimitError } from './GroqTradeService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import OpenRouterLlmService, { isOpenRouterRateLimitError } from './OpenRouterLlmService.js';

const DEFAULT_PROVIDER_ORDER = ['gemini', 'groq', 'nvidia', 'openrouter'];

export function isTradeLlmRateLimitError(err) {
    return (
        isGeminiRateLimitError(err) ||
        isGroqRateLimitError(err) ||
        isOpenRouterRateLimitError(err) ||
        err?.response?.status === 429 ||
        /rate limit|quota|resource.?exhausted|too many requests/i.test(String(err?.message || err))
    );
}

export function isTradeLlmFallbackError(err) {
    const msg = String(err?.message || err);
    const status = err?.response?.status;
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

    isConfigured() {
        return this._providers().length > 0;
    }

    getModelChain() {
        return this._providers().map((p) => p.label());
    }

    getPrimaryLabel() {
        const providers = this._providers();
        if (!providers.length) return 'none';
        return providers[0].label();
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async _route(method, systemPrompt, userPrompt, opts = {}) {
        const providers = this._providers();
        if (!providers.length) {
            throw new Error(
                'No trade LLM configured (set GEMINI_API_KEY, GROQ_API_KEY, NVIDIA_API_KEY, or OPENROUTER_API_KEY)',
            );
        }

        let lastErr;
        for (let i = 0; i < providers.length; i++) {
            const provider = providers[i];
            try {
                const text = await provider.svc[method](systemPrompt, userPrompt, opts);
                this.lastProvider = provider.name;
                if (i > 0) {
                    logger.info(`Trade LLM fallback succeeded via ${provider.name}`);
                }
                return text;
            } catch (err) {
                lastErr = err;
                const hasNext = i < providers.length - 1;
                if (hasNext && isTradeLlmFallbackError(err)) {
                    logger.warn(`Trade ${provider.name} failed — trying next provider: ${err.message}`);
                    continue;
                }
                throw err;
            }
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
