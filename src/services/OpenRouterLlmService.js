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
const DEFAULT_VISION_MODELS = [
    'google/gemini-2.5-flash',
    'google/gemini-2.0-flash-001',
    'qwen/qwen2.5-vl-72b-instruct',
    'qwen/qwen-2.5-vl-7b-instruct:free',
    'meta-llama/llama-3.2-11b-vision-instruct:free',
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
        this.visionModels = parseList(cfg.OPENROUTER_VISION_MODELS, DEFAULT_VISION_MODELS);
        this.tradeModel = this.models[0];
        this.timeoutMs = Math.min(120_000, Math.max(30_000, Number(cfg.OPENROUTER_TIMEOUT_MS) || 90_000));
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    async chat({ system, user, messages, temperature = 0.2, maxTokens = 4000, timeoutMs, models } = {}) {
        if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

        const modelList = Array.isArray(models) && models.length ? models : this.models;
        let lastErr;
        for (const model of modelList) {
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
                const detail = err?.response?.data?.error?.message || err.message;
                logger.warn(`OpenRouter ${model} failed: ${detail}`);
                if (isOpenRouterRateLimitError(err)) continue;
            }
        }
        throw lastErr || new Error('All OpenRouter models failed');
    }

    /**
     * Multimodal OCR / text extract — image_url for images, file for PDFs (Gemini-class models).
     * @param {{ prompt: string, buffer: Buffer, mimeType: string, temperature?: number, maxTokens?: number, timeoutMs?: number }} opts
     */
    async chatVision({ prompt, buffer, mimeType, temperature = 0.1, maxTokens = 8192, timeoutMs } = {}) {
        if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
        if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty media for OpenRouter vision');

        const mime = String(mimeType || 'application/pdf').split(';')[0].trim().toLowerCase();
        const b64 = buffer.toString('base64');
        const dataUrl = `data:${mime};base64,${b64}`;
        const isImage = mime.startsWith('image/');

        const userContent = isImage
            ? [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
              ]
            : [
                  { type: 'text', text: prompt },
                  {
                      type: 'file',
                      file: {
                          filename: mime.includes('pdf') ? 'resume.pdf' : 'resume.bin',
                          file_data: dataUrl,
                      },
                  },
              ];

        // For PDF: also try image-style data URL on models that reject `file` parts
        const pdfAsImageFallbackContent = !isImage
            ? [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
              ]
            : null;

        let lastErr;
        for (const model of this.visionModels) {
            for (const content of [userContent, pdfAsImageFallbackContent].filter(Boolean)) {
                try {
                    const { data } = await axios.post(
                        OPENROUTER_URL,
                        {
                            model,
                            messages: [{ role: 'user', content }],
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
                            timeout: timeoutMs || Math.max(this.timeoutMs, 90_000),
                        }
                    );
                    const text = data?.choices?.[0]?.message?.content?.trim();
                    if (!text) throw new Error('empty OpenRouter vision response');
                    return { text, provider: 'openrouter', model };
                } catch (err) {
                    lastErr = err;
                    const detail = err?.response?.data?.error?.message || err.message;
                    logger.warn(`OpenRouter vision ${model} failed: ${detail}`);
                    if (!isOpenRouterRateLimitError(err) && !/unsupported|invalid|file|image|modality|pdf/i.test(detail)) {
                        // hard failure for this content shape — try next content/model
                    }
                }
            }
        }
        throw lastErr || new Error('All OpenRouter vision models failed');
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
