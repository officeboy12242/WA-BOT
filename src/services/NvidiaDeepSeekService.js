/**
 * NVIDIA NIM chat completions (DeepSeek V4 Flash).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SUMMARY_SYSTEM_PROMPT = [
    'You summarize WhatsApp group chats for a daily recap.',
    'Reply with ONLY valid JSON (no markdown fences) in this shape:',
    '{"topics":[{"title":"short title","detail":"1-2 sentences"}],"notable":["bullet strings"],"wrap_up":"2-4 sentence paragraph"}',
    'Rules: use first names only; no phone numbers; no mention of bots or AI;',
    'keep topics to 3-5 items; notable to 0-3 items; friendly tone; English unless chat is mostly Hindi.',
].join(' ');

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
        this.summaryTimeoutMs = clampTimeoutMs(
            config.GROUP_SUMMARY_LLM_TIMEOUT_MS || Math.max(this.timeoutMs, 90_000)
        );
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

    parseSummaryJson(raw) {
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

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    /**
     * Retry with progressively smaller prompts and longer timeouts.
     * @param {string} systemPrompt
     * @param {string} prompt
     * @param {{ maxTokens?: number, baseTimeoutMs?: number }} [opts]
     */
    async completeWithSummaryRetry(systemPrompt, prompt, opts = {}) {
        const baseTimeout = clampTimeoutMs(opts.baseTimeoutMs ?? this.summaryTimeoutMs);
        const attempts = [
            { prompt, timeoutMs: baseTimeout, maxTokens: opts.maxTokens ?? 800 },
            { prompt: prompt.slice(0, 6000), timeoutMs: Math.min(MAX_TIMEOUT_MS, baseTimeout + 15_000), maxTokens: 700 },
            { prompt: prompt.slice(0, 3500), timeoutMs: MAX_TIMEOUT_MS, maxTokens: 600 },
        ];

        let lastErr;
        for (let i = 0; i < attempts.length; i++) {
            const attempt = attempts[i];
            if (!attempt.prompt.trim()) {
                continue;
            }
            try {
                if (i > 0) {
                    logger.warn(
                        `NVIDIA recap retry ${i + 1}/${attempts.length} ` +
                            `(${attempt.prompt.length} chars, ${attempt.timeoutMs}ms timeout)`
                    );
                }
                return await this.complete(systemPrompt, attempt.prompt, {
                    timeoutMs: attempt.timeoutMs,
                    maxTokens: attempt.maxTokens,
                });
            } catch (err) {
                lastErr = err;
                if (!this.isTimeoutError(err) || i === attempts.length - 1) {
                    throw err;
                }
            }
        }
        throw lastErr || new Error('Summary request failed');
    }

    /**
     * @param {string} prompt
     * @returns {Promise<object>}
     */
    async summarizeGroupChat(prompt) {
        const raw = await this.completeWithSummaryRetry(SUMMARY_SYSTEM_PROMPT, prompt);
        return this.parseSummaryJson(raw);
    }

    /**
     * Map-reduce for busy groups: summarize each chunk, then merge partial JSON.
     * @param {string[]} chunkPrompts
     * @param {{ groupName?: string, dateLabel?: string, totalMessages?: number }} [meta]
     */
    async summarizeGroupChatChunks(chunkPrompts, meta = {}) {
        if (!chunkPrompts.length) {
            throw new Error('No chunk prompts provided');
        }
        if (chunkPrompts.length === 1) {
            return this.summarizeGroupChat(chunkPrompts[0]);
        }

        const partials = [];
        for (let i = 0; i < chunkPrompts.length; i++) {
            logger.info(
                `Group recap chunk ${i + 1}/${chunkPrompts.length} ` +
                    `(${chunkPrompts[i].length} chars) for ${meta.groupName || 'group'}`
            );
            partials.push(await this.summarizeGroupChat(chunkPrompts[i]));
        }

        const mergePrompt = [
            `Merge these partial WhatsApp group recap JSON summaries into one final recap.`,
            meta.groupName ? `Group: ${meta.groupName}` : '',
            meta.dateLabel ? `Date: ${meta.dateLabel}` : '',
            meta.totalMessages ? `Total messages that day: ${meta.totalMessages}` : '',
            'Combine overlapping topics, keep 3-5 topics total, 0-3 notable items, one wrap_up.',
            '',
            ...partials.map((part, idx) => `Part ${idx + 1}:\n${JSON.stringify(part)}`),
        ]
            .filter(Boolean)
            .join('\n');

        const mergeSystem = [
            'You merge partial group chat recap JSON objects into one final recap.',
            'Reply with ONLY valid JSON (no markdown fences) in this shape:',
            '{"topics":[{"title":"short title","detail":"1-2 sentences"}],"notable":["bullet strings"],"wrap_up":"2-4 sentence paragraph"}',
            'Deduplicate topics; preserve the most important details from each part.',
        ].join(' ');

        const raw = await this.completeWithSummaryRetry(mergeSystem, mergePrompt, { maxTokens: 900 });
        return this.parseSummaryJson(raw);
    }
}

export default NvidiaDeepSeekService;
