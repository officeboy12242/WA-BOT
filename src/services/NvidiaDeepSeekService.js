/**
 * NVIDIA NIM chat completions (DeepSeek V4 Flash).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function clampTimeoutMs(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(MAX_TIMEOUT_MS, Math.max(20_000, n));
}

class NvidiaDeepSeekService {
    constructor(config = {}) {
        this.apiKey = config.NVIDIA_API_KEY || '';
        this.model = config.NVIDIA_MODEL || DEFAULT_MODEL;
        this.baseUrl = config.NVIDIA_API_BASE_URL || DEFAULT_BASE_URL;
        this.timeoutMs = clampTimeoutMs(config.NVIDIA_TIMEOUT_MS);
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ timeoutMs?: number, maxTokens?: number }} [opts]
     * @returns {Promise<string>}
     */
    async complete(systemPrompt, userPrompt, opts = {}) {
        if (!this.apiKey) {
            throw new Error('NVIDIA_API_KEY is not configured');
        }

        const timeoutMs = clampTimeoutMs(opts.timeoutMs ?? this.timeoutMs);
        const maxTokens = opts.maxTokens ?? 800;

        const body = {
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.35,
            max_tokens: maxTokens,
            stream: false,
            chat_template_kwargs: { thinking: false },
        };

        const { data } = await axios.post(this.baseUrl, body, {
            timeout: timeoutMs,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
        });

        const content = data?.choices?.[0]?.message?.content;
        if (!content?.trim()) {
            throw new Error('Empty response from NVIDIA API');
        }
        return content.trim();
    }

    /**
     * @param {string} prompt
     * @returns {Promise<object>}
     */
    async summarizeGroupChat(prompt) {
        const system = [
            'You summarize WhatsApp group chats for a daily recap.',
            'Reply with ONLY valid JSON (no markdown fences) in this shape:',
            '{"topics":[{"title":"short title","detail":"1-2 sentences"}],"notable":["bullet strings"],"wrap_up":"2-4 sentence paragraph"}',
            'Rules: use first names only; no phone numbers; no mention of bots or AI;',
            'keep topics to 3-5 items; notable to 0-3 items; friendly tone; English unless chat is mostly Hindi.',
        ].join(' ');

        let raw;
        try {
            raw = await this.complete(system, prompt);
        } catch (firstErr) {
            const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED/i.test(firstErr.message);
            if (!isTimeout || prompt.length <= 4000) {
                throw firstErr;
            }
            logger.warn(`NVIDIA recap timeout (${prompt.length} chars), retrying with shorter prompt`);
            const shorter = `${prompt.slice(0, 4000)}\n\n[...truncated for length...]`;
            raw = await this.complete(system, shorter, { timeoutMs: 45_000, maxTokens: 600 });
        }

        const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

        try {
            return JSON.parse(jsonText);
        } catch (err) {
            logger.warn(`Group summary JSON parse failed: ${err.message}`);
            return {
                topics: [],
                notable: [],
                wrap_up: raw.slice(0, 600),
            };
        }
    }
}

export default NvidiaDeepSeekService;
