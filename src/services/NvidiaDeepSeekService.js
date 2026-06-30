/**
 * NVIDIA NIM chat completions (DeepSeek V4 Flash).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';

class NvidiaDeepSeekService {
    constructor(config = {}) {
        this.apiKey = config.NVIDIA_API_KEY || '';
        this.model = config.NVIDIA_MODEL || DEFAULT_MODEL;
        this.baseUrl = config.NVIDIA_API_BASE_URL || DEFAULT_BASE_URL;
        this.timeoutMs = Math.max(15000, Number(config.NVIDIA_TIMEOUT_MS) || 90000);
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    /**
     * @param {string} systemPrompt
     * @param {string} userPrompt
     * @returns {Promise<string>}
     */
    async complete(systemPrompt, userPrompt) {
        if (!this.apiKey) {
            throw new Error('NVIDIA_API_KEY is not configured');
        }

        const { data } = await axios.post(
            this.baseUrl,
            {
                model: this.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.4,
                max_tokens: 1200,
                stream: false,
            },
            {
                timeout: this.timeoutMs,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
            }
        );

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
            'keep topics to 3-6 items; notable to 0-4 items; friendly tone; English unless chat is mostly Hindi.',
        ].join(' ');

        const raw = await this.complete(system, prompt);
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
