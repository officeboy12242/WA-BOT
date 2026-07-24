/**
 * Assist DM chat router: Gemini → Groq → NVIDIA → OpenRouter.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { isGeminiRateLimitError } from './GeminiTradeService.js';
import { isGroqRateLimitError } from './GroqTradeService.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import OpenRouterLlmService, { isOpenRouterRateLimitError } from './OpenRouterLlmService.js';

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

const DEFAULT_GEMINI = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'];
const DEFAULT_GROQ = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'];
const DEFAULT_PROVIDERS = ['gemini', 'groq', 'nvidia', 'openrouter'];

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

export function isAssistLlmFallbackError(err) {
    const msg = String(err?.message || err);
    const status = err?.response?.status;
    if (isGeminiRateLimitError(err) || isGroqRateLimitError(err) || isOpenRouterRateLimitError(err)) return true;
    if (status === 429 || status === 503 || status === 502 || status === 504) return true;
    return /rate limit|quota|timeout|ETIMEDOUT|ECONNABORTED|empty response|overloaded|unavailable/i.test(msg);
}

function toOpenAiMessages(systemPrompt, history, userBlock) {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const turn of history || []) {
        messages.push({
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            content: String(turn.text || '').slice(0, 800),
        });
    }
    messages.push({ role: 'user', content: userBlock });
    return messages;
}

export default class AssistLlmRouter {
    constructor(cfg = config) {
        this.cfg = cfg;
        this.geminiKey = (cfg.GEMINI_API_KEY || '').trim();
        this.groqKey = (cfg.GROQ_API_KEY || '').trim();
        this.nvidiaKey = (cfg.NVIDIA_API_KEY || '').trim();
        this.geminiModels = parseList(cfg.ASSIST_GEMINI_MODELS || cfg.ASSIST_GEMINI_MODEL, DEFAULT_GEMINI);
        this.groqModels = parseList(cfg.ASSIST_GROQ_MODELS || cfg.ASSIST_GROQ_MODEL || cfg.GROQ_TRADE_MODEL, DEFAULT_GROQ);
        this.nvidiaModels = parseList(
            cfg.ASSIST_NVIDIA_MODELS || cfg.ASSIST_NVIDIA_MODEL || cfg.NVIDIA_MODEL,
            ['deepseek-ai/deepseek-v4-flash']
        );
        this.openrouter = new OpenRouterLlmService(cfg);
        this.providerOrder = parseList(cfg.ASSIST_LLM_PROVIDERS || cfg.TRADE_LLM_PROVIDERS, DEFAULT_PROVIDERS);
        this.timeoutMs = Math.min(60_000, Math.max(15_000, Number(cfg.ASSIST_TIMEOUT_MS) || 45_000));
        this.nvidia = new NvidiaDeepSeekService(cfg);
    }

    isConfigured() {
        return Boolean(this.geminiKey || this.groqKey || this.nvidiaKey || this.openrouter.isConfigured());
    }

    getProviderChain() {
        const out = [];
        if (this.geminiKey && this.providerOrder.includes('gemini')) {
            out.push(`Gemini ${this.geminiModels[0]}`);
        }
        if (this.groqKey && this.providerOrder.includes('groq')) {
            out.push(`Groq ${this.groqModels[0]}`);
        }
        if (this.nvidiaKey && this.providerOrder.includes('nvidia')) {
            out.push(`NVIDIA ${this.nvidiaModels[0].split('/').pop()}`);
        }
        if (this.openrouter.isConfigured() && this.providerOrder.includes('openrouter')) {
            out.push(`OpenRouter ${this.openrouter.tradeModel}`);
        }
        return out;
    }

    async completeChat({ systemPrompt, history, userBlock, maxTokens = 512, temperature = 0.75, maxChars = 2000 }) {
        const outLimit = Math.min(50_000, Math.max(200, Number(maxChars) || 2000));
        const providers = this.providerOrder.filter((p) => {
            if (p === 'gemini') return Boolean(this.geminiKey);
            if (p === 'groq') return Boolean(this.groqKey);
            if (p === 'nvidia') return Boolean(this.nvidiaKey);
            if (p === 'openrouter') return this.openrouter.isConfigured();
            return false;
        });

        if (!providers.length) {
            throw new Error('No assist LLM configured (GEMINI, GROQ, NVIDIA, or OPENROUTER API key)');
        }

        let lastErr;
        for (let pi = 0; pi < providers.length; pi++) {
            const provider = providers[pi];
            const models =
                provider === 'gemini'
                    ? this.geminiModels
                    : provider === 'groq'
                      ? this.groqModels
                      : provider === 'openrouter'
                        ? ['openrouter']
                        : this.nvidiaModels;

            for (const model of models) {
                for (let rateTry = 0; rateTry < 2; rateTry++) {
                    try {
                        let text;
                        let usedModel = model;
                        if (provider === 'gemini') {
                            text = await this._callGemini(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        } else if (provider === 'groq') {
                            text = await this._callGroq(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        } else if (provider === 'openrouter') {
                            const res = await this.openrouter.chat({
                                messages: toOpenAiMessages(systemPrompt, history, userBlock),
                                temperature,
                                maxTokens,
                                timeoutMs: this.timeoutMs,
                            });
                            text = res.text;
                            usedModel = res.model;
                        } else {
                            text = await this._callNvidia(model, systemPrompt, history, userBlock, {
                                maxTokens,
                                temperature,
                            });
                        }

                        if (!text?.trim()) {
                            throw new Error(`${provider} empty reply`);
                        }

                        if (pi > 0) {
                            logger.info(`Assist fallback succeeded via ${provider}/${usedModel}`);
                        }
                        return { text: text.trim().slice(0, outLimit), provider, model: usedModel };
                    } catch (err) {
                        lastErr = err;
                        if (isAssistLlmFallbackError(err) && rateTry < 1) {
                            await sleep(1500);
                            continue;
                        }
                        logger.warn(`Assist ${provider}/${model} failed: ${err.message}`);
                        break;
                    }
                }
            }

            const hasNext = pi < providers.length - 1;
            if (hasNext && isAssistLlmFallbackError(lastErr)) {
                logger.warn(`Assist ${provider} exhausted — trying next provider`);
                continue;
            }
        }

        throw lastErr || new Error('All assist LLM providers failed');
    }

    async _callGemini(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const contents = [];
        for (const turn of history || []) {
            contents.push({
                role: turn.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: turn.text }],
            });
        }
        contents.push({ role: 'user', parts: [{ text: userBlock }] });

        const url = `${GEMINI_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
        const { data } = await axios.post(
            url,
            {
                contents,
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { temperature, maxOutputTokens: maxTokens },
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
        return text;
    }

    async _callGroq(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const messages = toOpenAiMessages(systemPrompt, history, userBlock);
        const { data } = await axios.post(
            GROQ_URL,
            {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.groqKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        return data?.choices?.[0]?.message?.content || '';
    }

    async _callNvidia(model, systemPrompt, history, userBlock, { maxTokens, temperature }) {
        const messages = toOpenAiMessages(systemPrompt, history, userBlock);
        const { data } = await axios.post(
            NVIDIA_URL,
            {
                model,
                messages,
                temperature,
                max_tokens: maxTokens,
                stream: false,
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.nvidiaKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        const content = this.nvidia.extractMessageContent(data);
        return content || '';
    }

    /**
     * OCR / PDF text extraction via Gemini multimodal (PDF or image bytes).
     * @param {{ buffer: Buffer, mimeType: string, prompt?: string, maxChars?: number }} opts
     */
    async extractMediaText({ buffer, mimeType, prompt, maxChars = 80_000 }) {
        if (!this.geminiKey) {
            throw new Error('Gemini API key required for OCR / scanned resume extraction');
        }
        if (!Buffer.isBuffer(buffer) || !buffer.length) {
            throw new Error('Empty media for OCR');
        }
        // Gemini inline upload practical ceiling for this bot
        if (buffer.length > 18 * 1024 * 1024) {
            throw new Error('File too large for OCR (max ~18MB)');
        }

        const mime = String(mimeType || 'application/pdf').split(';')[0].trim().toLowerCase();
        const userPrompt =
            prompt ||
            [
                'Extract ALL readable text from this resume document/image.',
                'Preserve reading order, section headings, bullets, dates, emails, and links.',
                'Return plain text only — no markdown fences, no commentary.',
            ].join(' ');

        let lastErr;
        for (const model of this.geminiModels) {
            try {
                const url = `${GEMINI_ROOT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
                const { data } = await axios.post(
                    url,
                    {
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    { text: userPrompt },
                                    {
                                        inlineData: {
                                            mimeType: mime,
                                            data: buffer.toString('base64'),
                                        },
                                    },
                                ],
                            },
                        ],
                        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
                    },
                    {
                        timeout: Math.max(this.timeoutMs, 90_000),
                        headers: { 'Content-Type': 'application/json' },
                        validateStatus: (s) => s >= 200 && s < 300,
                    }
                );
                const parts = data?.candidates?.[0]?.content?.parts || [];
                const text = parts
                    .map((p) => p?.text || '')
                    .join('')
                    .trim();
                if (!text) {
                    throw new Error(`${model} empty OCR reply`);
                }
                return {
                    text: text.slice(0, Math.min(100_000, Math.max(200, Number(maxChars) || 80_000))),
                    provider: 'gemini',
                    model,
                };
            } catch (err) {
                lastErr = err;
                logger.warn(`Assist OCR ${model} failed: ${err.message}`);
                if (!isAssistLlmFallbackError(err)) break;
            }
        }
        throw lastErr || new Error('Gemini OCR failed');
    }
}

export const assistLlmRouter = new AssistLlmRouter();
