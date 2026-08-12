/**
 * NVIDIA NIM chat completions — summary model + optional trade model (GLM-5.2).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { buildKeyPool } from '../utils/apiKeyPool.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_SUMMARY_MODEL = 'deepseek-ai/deepseek-v4-flash';
const DEFAULT_TRADE_MODEL = 'z-ai/glm-5.2';
const MAX_TIMEOUT_MS = 120_000;
const MAX_TRADE_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const SUMMARY_SYSTEM_PROMPT = [
    'You are the resident chronicler of a WhatsApp group, writing its daily recap.',
    'Read what members actually said to each other and capture the conversation itself: who took part,',
    'the themes they discussed, questions asked and answered, opinions shared, decisions or plans made,',
    'and how the mood moved through the day.',
    '',
    'FIRST work out what this group is FOR, from the chat alone — trading, movies, study, a friend circle,',
    'a work team, stickers and memes, whatever it is. Do not guess from the group name; infer it from what',
    'people do and talk about. Say it in one line, and let it colour everything else you write: a trading',
    'group and a meme group should not read the same way.',
    '',
    'THEN give your own verdict on the day. Be a character, not a report — witty, warm, a little cheeky,',
    'with a real opinion about how the day went. Tease gently, notice the running jokes, call out who',
    'carried the conversation. Never mean, never sarcastic about a person, and never invent events.',
    'One vivid line beats three bland ones.',
    '',
    'Reply with ONLY valid JSON (no markdown fences) in this shape:',
    '{"about":"one line on what this group is for, inferred from the chat",',
    '"vibe":"3-6 word mood tag for today, e.g. \\"chaotic, in the best way\\"",',
    '"topics":[{"title":"short title","detail":"1-2 sentences on what was discussed and by whom"}],',
    '"notable":["bullet strings"],',
    '"wrap_up":"2-4 sentence paragraph",',
    '"verdict":"2-4 sentences of YOUR opinion on the day, in character"}',
    '',
    'Rules: first names only; no phone numbers; never mention bots, AI, or that you are summarizing;',
    '3-5 topics; 0-3 notable; English unless the chat is mostly Hindi, in which case match it.',
].join(' ');

export { SUMMARY_SYSTEM_PROMPT };

function clampTimeoutMs(raw, cap = MAX_TIMEOUT_MS) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(cap, Math.max(20_000, n));
}

class NvidiaDeepSeekService {
    constructor(config = {}) {
        this.keyPool = buildKeyPool(config.NVIDIA_API_KEYS, config.NVIDIA_API_KEY);
        this.model = config.NVIDIA_MODEL || DEFAULT_SUMMARY_MODEL;
        this.tradeModel = config.NVIDIA_TRADE_MODEL?.trim() || DEFAULT_TRADE_MODEL;
        this.baseUrl = config.NVIDIA_API_BASE_URL || DEFAULT_BASE_URL;
        this.timeoutMs = clampTimeoutMs(config.NVIDIA_TIMEOUT_MS);
        this.summaryTimeoutMs = clampTimeoutMs(
            config.GROUP_SUMMARY_LLM_TIMEOUT_MS || Math.max(this.timeoutMs, 90_000)
        );
        this.tradeTimeoutMs = clampTimeoutMs(
            config.TRADE_ANALYSIS_TIMEOUT_MS || 150_000,
            MAX_TRADE_TIMEOUT_MS
        );
    }

    isConfigured() {
        return this.keyPool.size > 0;
    }

    isRetryableError(err) {
        if (!err) return false;
        if (this.isTimeoutError(err)) return true;
        const status = err?.response?.status || err?.status;
        return status === 503 || status === 502 || status === 429;
    }

    async completeWithSummaryRetry(systemPrompt, userPrompt, opts = {}) {
        const maxRetries = 2;
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.complete(systemPrompt, userPrompt, opts);
            } catch (err) {
                lastErr = err;
                if (!this.isRetryableError(err) || attempt === maxRetries) {
                    throw err;
                }
                const backoffMs = 3000 * (attempt + 1);
                logger.warn(
                    `NVIDIA summary retry ${attempt + 1}/${maxRetries} after ${backoffMs}ms: ${err.message}`
                );
                await new Promise((r) => setTimeout(r, backoffMs));
            }
        }
        throw lastErr;
    }

    resolveModel(forTrade = false) {
        return forTrade ? this.tradeModel : this.model;
    }

    buildRequestBody(model, systemPrompt, userPrompt, maxTokens) {
        const body = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.35,
            max_tokens: maxTokens,
            stream: false,
        };
        if (/deepseek/i.test(model)) {
            body.chat_template_kwargs = { thinking: false };
        }
        return body;
    }

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ timeoutMs?: number, maxTokens?: number, forTrade?: boolean, model?: string, timeoutCapMs?: number }} [opts]
     * @returns {Promise<string>}
     */
    async complete(systemPrompt, userPrompt, opts = {}) {
        if (!this.keyPool.size) {
            throw new Error('NVIDIA_API_KEY is not configured');
        }

        const forTrade = opts.forTrade === true;
        const model = opts.model || this.resolveModel(forTrade);
        const cap = opts.timeoutCapMs || (forTrade ? MAX_TRADE_TIMEOUT_MS : MAX_TIMEOUT_MS);
        const timeoutMs = clampTimeoutMs(
            opts.timeoutMs ?? (forTrade ? this.tradeTimeoutMs : this.timeoutMs),
            cap
        );
        const maxTokens = opts.maxTokens ?? 800;

        const body = this.buildRequestBody(model, systemPrompt, userPrompt, maxTokens);

        // Quotas are per key — rotate through spare keys before failing over.
        let lastErr;
        for (let attempt = 0; attempt < this.keyPool.size; attempt++) {
            const key = this.keyPool.next();
            try {
                const { data } = await axios.post(this.baseUrl, body, {
                    timeout: timeoutMs,
                    headers: {
                        Authorization: `Bearer ${key}`,
                        'Content-Type': 'application/json',
                    },
                });

                const content = this.extractMessageContent(data);
                if (!content?.trim()) {
                    throw new Error('Empty response from NVIDIA API');
                }
                return content.trim();
            } catch (err) {
                const status = err.response?.status;
                const detail =
                    err.response?.data?.detail || err.response?.data?.message || err.message;
                const msg = status ? `NVIDIA ${status}: ${detail}` : String(detail || err.message);
                const wrapped = new Error(msg);
                wrapped.cause = err;
                lastErr = wrapped;
                if (status !== 429) throw wrapped;
                this.keyPool.markRateLimited(key);
                if (attempt < this.keyPool.size - 1) {
                    logger.warn(`NVIDIA key ${attempt + 1} rate limited — rotating to next key`);
                }
            }
        }
        throw lastErr || new Error('NVIDIA request failed');
    }

    /**
     * Heal / long jobs: try primary model then fallbacks with shrinking prompts.
     * 503/502/504 skip to next model immediately (smaller prompt will not help).
     * @param {string[]} models
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ maxTokens?: number, onProgress?: (line: string) => void|Promise<void> }} [opts]
     * @returns {Promise<{ content: string, model: string }>}
     */
    async completeWithModelFallback(models, systemPrompt, userPrompt, opts = {}) {
        const chain = [...new Set((models || []).filter(Boolean))];
        if (!chain.length) chain.push(this.model);
        const progress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};

        const attempts = [
            { prompt: userPrompt, maxTokens: opts.maxTokens ?? 2500, timeoutMs: 90_000 },
            {
                prompt: userPrompt.slice(0, 8_000) + (userPrompt.length > 8_000 ? '\n\n[...truncated...]' : ''),
                maxTokens: 1600,
                timeoutMs: 120_000,
            },
            {
                prompt: userPrompt.slice(0, 4_500) + (userPrompt.length > 4_500 ? '\n\n[...truncated...]' : ''),
                maxTokens: 1000,
                timeoutMs: 120_000,
            },
        ];

        let lastErr;
        for (const model of chain) {
            for (let i = 0; i < attempts.length; i++) {
                const attempt = attempts[i];
                try {
                    const shortModel = model.split('/').pop() || model;
                    await progress(
                        i === 0
                            ? `🤖 Asking *${shortModel}*…`
                            : `🤖 Retry *${shortModel}* (smaller prompt, try ${i + 1}/${attempts.length})…`
                    );
                    if (i > 0 || model !== chain[0]) {
                        logger.warn(
                            `NVIDIA heal try model=${model} attempt=${i + 1}/${attempts.length} ` +
                                `(${attempt.prompt.length} chars)`
                        );
                    }
                    const content = await this.complete(systemPrompt, attempt.prompt, {
                        model,
                        maxTokens: attempt.maxTokens,
                        timeoutMs: attempt.timeoutMs,
                        timeoutCapMs: MAX_TRADE_TIMEOUT_MS,
                    });
                    await progress(`✅ Model *${shortModel}* responded`);
                    if (model !== chain[0]) {
                        logger.info(`NVIDIA heal succeeded with fallback model: ${model}`);
                    }
                    return { content, model };
                } catch (err) {
                    lastErr = err;
                    const msg = String(err?.message || err);
                    const shortModel = model.split('/').pop() || model;
                    logger.warn(`NVIDIA heal failed (${model}): ${msg}`);

                    // Service down / rate limit — do not burn retries on same model
                    if (/503|502|504|429|overloaded|unavailable|capacity/i.test(msg)) {
                        await progress(`⚠️ *${shortModel}* unavailable (${msg.match(/\d{3}/)?.[0] || 'err'}) — next model…`);
                        logger.warn(`NVIDIA heal skipping model ${model} (unavailable), trying next…`);
                        break;
                    }
                    // Bad model id — next model
                    if (/401|403|404|invalid.*model|not found|does not exist/i.test(msg)) {
                        await progress(`⚠️ *${shortModel}* not available — next model…`);
                        logger.warn(`NVIDIA heal skipping model ${model} (not available), trying next…`);
                        break;
                    }

                    const retryable =
                        this.isTimeoutError(err) ||
                        /empty response|ECONNRESET|ENOTFOUND|socket/i.test(msg);
                    if (!retryable || i === attempts.length - 1) {
                        await progress(`⚠️ *${shortModel}* failed — trying next…`);
                        break;
                    }
                    await progress(`⚠️ *${shortModel}* timeout — retrying smaller prompt…`);
                }
            }
        }
        throw lastErr || new Error('All NVIDIA heal models failed');
    }

    extractMessageContent(data) {
        const msg = data?.choices?.[0]?.message || {};
        let content = msg.content || msg.reasoning_content || '';
        if (Array.isArray(content)) {
            content = content.map((p) => p?.text || p?.content || '').join('');
        }
        content = String(content || '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '')
            .trim();
        return content;
    }

    /** Trade discovery, research, CE/PE analysis — uses NVIDIA_TRADE_MODEL (GLM-5.2). */
    async completeTrade(systemPrompt, userPrompt, opts = {}) {
        return this.complete(systemPrompt, userPrompt, { ...opts, forTrade: true });
    }

    normalizeSummaryShape(parsed, fallbackText = '') {
        const topics = [];
        const rawTopics = Array.isArray(parsed?.topics) ? parsed.topics : [];
        for (const t of rawTopics) {
            if (typeof t === 'string' && t.trim()) {
                topics.push({ title: t.trim().slice(0, 80), detail: '' });
            } else if (t && typeof t === 'object') {
                const title = String(t.title || t.name || t.topic || '').trim();
                const detail = String(t.detail || t.summary || t.description || '').trim();
                if (title || detail) {
                    topics.push({
                        title: (title || 'Discussion').slice(0, 80),
                        detail: detail.slice(0, 280),
                    });
                }
            }
        }

        const notable = (Array.isArray(parsed?.notable) ? parsed.notable : [])
            .map((n) => (typeof n === 'string' ? n : n?.text || n?.detail || ''))
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 4);

        const wrap_up = String(
            parsed?.wrap_up || parsed?.wrapUp || parsed?.summary || fallbackText || ''
        ).trim();

        return { topics, notable, wrap_up };
    }

    parseSummaryJson(raw) {
        let text = String(raw || '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        const tryParse = (candidate) => {
            try {
                return this.normalizeSummaryShape(JSON.parse(candidate), text.slice(0, 400));
            } catch {
                return null;
            }
        };

        let parsed = tryParse(text);
        if (parsed?.topics?.length || parsed?.wrap_up) return parsed;

        const objectMatch = text.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            parsed = tryParse(objectMatch[0]);
            if (parsed?.topics?.length || parsed?.wrap_up) return parsed;
        }

        logger.warn('Group summary JSON parse failed — using text wrap-up only');
        return {
            topics: [],
            notable: [],
            wrap_up: text.slice(0, 600),
        };
    }

    /** Merge partial recaps without another LLM call (timeout-safe). */
    mergePartialsLocally(partials, meta = {}) {
        const topics = [];
        const notable = [];
        const wrapParts = [];
        const seenTitles = new Set();

        for (const part of partials) {
            for (const t of part?.topics || []) {
                const key = String(t.title || '').toLowerCase();
                if (!key || seenTitles.has(key)) continue;
                seenTitles.add(key);
                topics.push(t);
            }
            for (const n of part?.notable || []) {
                if (n && !notable.includes(n)) notable.push(n);
            }
            if (part?.wrap_up) wrapParts.push(part.wrap_up);
        }

        const wrap_up = wrapParts.length
            ? wrapParts.slice(0, 3).join(' ')
            : `Busy day${meta.totalMessages ? ` with ${meta.totalMessages} messages` : ''}.`;

        return {
            topics: topics.slice(0, 5),
            notable: notable.slice(0, 3),
            wrap_up: wrap_up.slice(0, 800),
        };
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
        // Start compact — large prompts are the main timeout cause
        const attempts = [
            {
                prompt: prompt.length > 5000 ? prompt.slice(0, 5000) + '\n\n[...truncated...]' : prompt,
                timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(baseTimeout, 90_000)),
                maxTokens: opts.maxTokens ?? 700,
            },
            {
                prompt: prompt.slice(0, 3200) + (prompt.length > 3200 ? '\n\n[...truncated...]' : ''),
                timeoutMs: MAX_TIMEOUT_MS,
                maxTokens: 600,
            },
            {
                prompt: prompt.slice(0, 2000) + (prompt.length > 2000 ? '\n\n[...truncated...]' : ''),
                timeoutMs: MAX_TIMEOUT_MS,
                maxTokens: 500,
            },
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
                const retryable = this.isTimeoutError(err) || /empty response|5\d\d|ECONNRESET/i.test(String(err?.message || ''));
                if (!retryable || i === attempts.length - 1) {
                    throw err;
                }
            }
        }
        throw lastErr || new Error('Summary request failed');
    }

    /**
     * Trade analysis with retry + prompt trim on timeout.
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @param {{ maxTokens?: number, baseTimeoutMs?: number }} [opts]
     */
    async completeTradeAnalysis(systemPrompt, userPrompt, opts = {}) {
        const baseTimeout = clampTimeoutMs(opts.baseTimeoutMs ?? this.tradeTimeoutMs, MAX_TRADE_TIMEOUT_MS);
        const attempts = [
            { prompt: userPrompt, timeoutMs: baseTimeout, maxTokens: opts.maxTokens ?? 2200 },
            {
                prompt: userPrompt.slice(0, 9000) + '\n\n[...trimmed for speed...]',
                timeoutMs: Math.min(MAX_TRADE_TIMEOUT_MS, baseTimeout + 20_000),
                maxTokens: 2000,
            },
            {
                prompt: userPrompt.slice(0, 5000) + '\n\n[...trimmed for speed...]',
                timeoutMs: MAX_TRADE_TIMEOUT_MS,
                maxTokens: 1800,
            },
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
                        `NVIDIA trade analysis retry ${i + 1}/${attempts.length} ` +
                            `(${attempt.prompt.length} chars, ${attempt.timeoutMs}ms)`
                    );
                }
                return await this.complete(systemPrompt, attempt.prompt, {
                    timeoutMs: attempt.timeoutMs,
                    maxTokens: attempt.maxTokens,
                    forTrade: true,
                });
            } catch (err) {
                lastErr = err;
                const status = err?.response?.status;
                const msg = String(err?.message || err);
                if (status === 429 || /rate.?limit|quota|too many requests/i.test(msg)) {
                    const e = new Error('NVIDIA rate limit — switching provider');
                    e.isRateLimit = true;
                    e.cause = err;
                    throw e;
                }
                if (!this.isTimeoutError(err) || i === attempts.length - 1) {
                    throw err;
                }
            }
        }
        throw lastErr || new Error('Trade analysis request failed');
    }

    /**
     * @param {string} prompt
     * @returns {Promise<object>}
     */
    async summarizeGroupChat(prompt) {
        const raw = await this.completeWithSummaryRetry(SUMMARY_SYSTEM_PROMPT, prompt, {
            timeoutMs: this.summaryTimeoutMs,
        });
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
            try {
                partials.push(await this.summarizeGroupChat(chunkPrompts[i]));
            } catch (err) {
                logger.warn(
                    `Group recap chunk ${i + 1}/${chunkPrompts.length} failed: ${err.message}`
                );
            }
        }

        if (!partials.length) {
            throw new Error('All recap chunks failed');
        }

        if (partials.length === 1) {
            return partials[0];
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

        try {
            const raw = await this.completeWithSummaryRetry(mergeSystem, mergePrompt, { maxTokens: 800 });
            const merged = this.parseSummaryJson(raw);
            if (merged.topics?.length) return merged;
            return this.mergePartialsLocally(partials, meta);
        } catch (err) {
            logger.warn(`Group recap merge failed, using local merge: ${err.message}`);
            return this.mergePartialsLocally(partials, meta);
        }
    }
}

export default NvidiaDeepSeekService;
