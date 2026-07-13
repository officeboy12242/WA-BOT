/**
 * Job-hunt LLM: OpenRouter free chain → Gemini → Groq → NVIDIA.
 * Notifies caller when a provider hits rate limits.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { isGeminiRateLimitError } from './GeminiTradeService.js';
import { isGroqRateLimitError } from './GroqTradeService.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const DEFAULT_OR_MODELS = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
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

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isLimitError(err) {
    const status = err?.response?.status || err?.status;
    const msg = String(err?.message || err);
    if (status === 429 || status === 402) return true;
    if (isGeminiRateLimitError(err) || isGroqRateLimitError(err)) return true;
    return /rate.?limit|quota|exhausted|capacity|too many requests|credit/i.test(msg);
}

export class JobHuntLlmService {
    constructor(cfg = config) {
        this.config = cfg;
        this.openRouterKey = cfg.OPENROUTER_API_KEY || '';
        this.openRouterModels = parseList(cfg.OPENROUTER_JOB_MODELS, [
            cfg.OPENROUTER_MODEL,
            ...(cfg.OPENROUTER_FALLBACK_MODELS || []),
        ].filter(Boolean).length
            ? [cfg.OPENROUTER_MODEL, ...(cfg.OPENROUTER_FALLBACK_MODELS || [])].filter(Boolean)
            : DEFAULT_OR_MODELS);
        this.geminiKey = cfg.GEMINI_API_KEY || '';
        this.geminiModels = parseList(cfg.JOB_HUNT_GEMINI_MODELS || cfg.ASSIST_GEMINI_MODELS, [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
        ]);
        this.groqKey = cfg.GROQ_API_KEY || '';
        this.groqModels = parseList(cfg.JOB_HUNT_GROQ_MODELS, ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
        this.nvidiaKey = cfg.NVIDIA_API_KEY || '';
        this.nvidiaModel = cfg.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash';
        /** @type {string[]} */
        this.limitWarnings = [];
        /** Skip OpenRouter for the rest of this scan after a rate/quota hit. */
        this._skipOpenRouter = false;
        /** Skip Gemini models after a rate/quota hit this scan. */
        this._skipGemini = false;
        /** Skip Groq after a rate/quota hit this scan. */
        this._skipGroq = false;
    }

    takeLimitWarnings() {
        const w = [...this.limitWarnings];
        this.limitWarnings = [];
        return w;
    }

    _noteLimit(provider, detail) {
        const line = `${provider}: ${detail}`;
        if (!this.limitWarnings.includes(line)) this.limitWarnings.push(line);
        logger.warn(`JobHunt LLM limit — ${line}`);
    }

    async chat({ system, user, temperature = 0.2, maxTokens = 4000 } = {}) {
        const errors = [];

        if (this.openRouterKey && !this._skipOpenRouter) {
            for (const model of this.openRouterModels) {
                try {
                    return await this._openRouter(model, system, user, temperature, maxTokens);
                } catch (err) {
                    errors.push(`openrouter/${model}: ${err.message}`);
                    if (isLimitError(err)) {
                        this._noteLimit('OpenRouter', `${model} — ${err.message}`);
                        this._skipOpenRouter = true;
                        logger.info('JobHunt: skipping OpenRouter for rest of scan (rate limited)');
                        break;
                    }
                    logger.warn(`OpenRouter ${model} failed: ${err.message}`);
                }
            }
        }

        if (this.geminiKey && !this._skipGemini) {
            for (const model of this.geminiModels) {
                try {
                    return await this._gemini(model, system, user, temperature, maxTokens);
                } catch (err) {
                    errors.push(`gemini/${model}: ${err.message}`);
                    if (isLimitError(err)) {
                        this._noteLimit('Gemini', `${model} — ${err.message}`);
                        this._skipGemini = true;
                        break;
                    }
                }
            }
        }

        if (this.groqKey && !this._skipGroq) {
            for (const model of this.groqModels) {
                try {
                    return await this._groq(model, system, user, temperature, maxTokens);
                } catch (err) {
                    errors.push(`groq/${model}: ${err.message}`);
                    if (isLimitError(err)) {
                        this._noteLimit('Groq', `${model} — ${err.message}`);
                        this._skipGroq = true;
                        break;
                    }
                }
            }
        }

        if (this.nvidiaKey) {
            try {
                return await this._nvidia(this.nvidiaModel, system, user, temperature, maxTokens);
            } catch (err) {
                errors.push(`nvidia: ${err.message}`);
                if (isLimitError(err)) this._noteLimit('NVIDIA', err.message);
            }
        }

        const e = new Error(`All job-hunt LLMs failed: ${errors.slice(0, 4).join(' | ')}`);
        e.code = 'JOB_HUNT_LLM_EXHAUSTED';
        throw e;
    }

    async _openRouter(model, system, user, temperature, maxTokens) {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: user });

        const { data } = await axios.post(
            OPENROUTER_URL,
            { model, messages, temperature, max_tokens: maxTokens },
            {
                headers: {
                    Authorization: `Bearer ${this.openRouterKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': this.config.PUBLIC_URL || 'https://github.com/officeboy12242/WA-BOT',
                    'X-Title': 'WA-BOT JobHunt',
                },
                timeout: 120_000,
            },
        );
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('empty OpenRouter response');
        return { text, provider: 'openrouter', model };
    }

    async _gemini(model, system, user, temperature, maxTokens) {
        const url = `${GEMINI_ROOT}/${model}:generateContent?key=${this.geminiKey}`;
        const body = {
            contents: [{ role: 'user', parts: [{ text: system ? `${system}\n\n${user}` : user }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
        };
        const { data } = await axios.post(url, body, { timeout: 120_000 });
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('')?.trim();
        if (!text) throw new Error('empty Gemini response');
        return { text, provider: 'gemini', model };
    }

    async _groq(model, system, user, temperature, maxTokens) {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: user });
        const { data } = await axios.post(
            GROQ_URL,
            { model, messages, temperature, max_tokens: maxTokens },
            {
                headers: { Authorization: `Bearer ${this.groqKey}`, 'Content-Type': 'application/json' },
                timeout: 90_000,
            },
        );
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('empty Groq response');
        return { text, provider: 'groq', model };
    }

    async _nvidia(model, system, user, temperature, maxTokens) {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: user });
        const { data } = await axios.post(
            NVIDIA_URL,
            { model, messages, temperature, max_tokens: maxTokens },
            {
                headers: { Authorization: `Bearer ${this.nvidiaKey}`, 'Content-Type': 'application/json' },
                timeout: 120_000,
            },
        );
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error('empty NVIDIA response');
        return { text, provider: 'nvidia', model };
    }
}

export default JobHuntLlmService;
