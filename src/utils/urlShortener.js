/**
 * TinyURL shortener with in-memory cache.
 */

import https from 'https';
import { logger } from './logger.js';

const TINYURL_API = 'https://tinyurl.com/api-create.php?url=';
const MAX_CACHE_SIZE = 500;
const SHORTEN_TIMEOUT_MS = 4000;
const MIN_LENGTH_TO_SHORTEN = 55;

class UrlShortener {
    constructor() {
        this._cache = new Map();
    }

    _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const req = https.request(
                { hostname: url.hostname, path: url.pathname + url.search, method: 'GET' },
                (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                },
            );
            req.on('error', reject);
            req.setTimeout(SHORTEN_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error('Shorten timeout'));
            });
            req.end();
        });
    }

    needsShortening(url) {
        return typeof url === 'string' && url.length >= MIN_LENGTH_TO_SHORTEN;
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;
        if (this._cache.has(url)) return this._cache.get(url);

        try {
            const { status, data } = await this._fetch(`${TINYURL_API}${encodeURIComponent(url)}`);
            if (status === 200 && data.startsWith('https://tinyurl.com/')) {
                if (this._cache.size >= MAX_CACHE_SIZE) {
                    this._cache.delete(this._cache.keys().next().value);
                }
                this._cache.set(url, data);
                return data;
            }
        } catch (err) {
            logger.warn(`URL shorten failed: ${err.message}`);
        }
        return url;
    }

    /** Shorten all long links in movie results (parallel, capped wait time). */
    async shortenMovieResults(results, maxWaitMs = 7000) {
        const links = [];
        for (const item of results) {
            for (const link of item.links || []) {
                if (this.needsShortening(link.url)) {
                    links.push(link);
                }
            }
        }
        if (!links.length) return results;

        const shortenAll = Promise.allSettled(
            links.map(async (link) => {
                link.url = await this.shorten(link.url);
            }),
        );

        await Promise.race([
            shortenAll,
            new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
        ]);

        return results;
    }
}

export const urlShortener = new UrlShortener();
export default UrlShortener;
