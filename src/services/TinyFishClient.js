/**
 * TinyFish Search + Fetch REST client (free tier).
 * Docs: https://docs.tinyfish.ai/
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

const FETCH_URL = 'https://api.fetch.tinyfish.ai';
const SEARCH_URL = 'https://api.search.tinyfish.ai';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export class TinyFishClient {
    constructor(apiKey, { fetchDelayMs = 2500, searchDelayMs = 13000 } = {}) {
        this.apiKey = String(apiKey || '').trim();
        this.fetchDelayMs = fetchDelayMs;
        this.searchDelayMs = searchDelayMs;
    }

    isConfigured() {
        return Boolean(this.apiKey);
    }

    _headers() {
        return {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    /**
     * @param {string[]} urls
     * @param {{ format?: string, links?: boolean }} opts
     */
    async getContents(urls, opts = {}) {
        const list = (urls || []).filter(Boolean).slice(0, 10);
        if (!list.length) return { results: [], errors: [] };

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const { data, status } = await axios.post(
                    FETCH_URL,
                    {
                        urls: list,
                        format: opts.format || 'markdown',
                        links: Boolean(opts.links),
                    },
                    { headers: this._headers(), timeout: 90_000 },
                );
                await sleep(Math.max(this.fetchDelayMs, list.length * 800));
                return {
                    results: data?.results || [],
                    errors: data?.errors || [],
                    status,
                };
            } catch (err) {
                const code = err?.response?.status;
                const msg = err?.response?.data?.message || err.message;
                if (code === 429 && attempt === 0) {
                    logger.warn(`TinyFish fetch rate-limited — waiting 65s (${msg})`);
                    await sleep(65_000);
                    continue;
                }
                if (code === 429 || /rate.?limit|quota|exhausted/i.test(String(msg))) {
                    const e = new Error(`TinyFish fetch limit: ${msg}`);
                    e.code = 'TINYFISH_LIMIT';
                    e.status = code;
                    throw e;
                }
                logger.warn(`TinyFish fetch error: ${msg}`);
                await sleep(this.fetchDelayMs);
                return { results: [], errors: [{ message: msg }] };
            }
        }
        return { results: [], errors: [{ message: 'rate limited' }] };
    }

    /**
     * @param {string} query
     */
    async search(query, { language = 'en' } = {}) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const { data, status } = await axios.get(SEARCH_URL, {
                    params: { query, language },
                    headers: this._headers(),
                    timeout: 45_000,
                });
                await sleep(this.searchDelayMs);
                const results = data?.results || data?.organic || data?.items || [];
                return { results, status };
            } catch (err) {
                const code = err?.response?.status;
                const msg = err?.response?.data?.message || err.message;
                if (code === 429 && attempt === 0) {
                    logger.warn(`TinyFish search rate-limited — waiting 62s (${msg})`);
                    await sleep(62_000);
                    continue;
                }
                if (code === 429 || /rate.?limit|quota|exhausted/i.test(String(msg))) {
                    const e = new Error(`TinyFish search limit: ${msg}`);
                    e.code = 'TINYFISH_LIMIT';
                    e.status = code;
                    throw e;
                }
                logger.warn(`TinyFish search error: ${msg}`);
                await sleep(this.searchDelayMs);
                return { results: [] };
            }
        }
        return { results: [] };
    }
}

export default TinyFishClient;
