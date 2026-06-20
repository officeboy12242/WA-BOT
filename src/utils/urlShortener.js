/**
 * Expiring movie links: self-hosted /d/:code (7h TTL) → TinyURL for display.
 */

import https from 'https';
import { logger } from './logger.js';

const TINYURL_API = 'https://tinyurl.com/api-create.php?url=';
const TINYURL_TIMEOUT_MS = 4000;
const MAX_WAIT_MS = 10000;
const MAX_CACHE_SIZE = 500;

class UrlShortener {
    constructor() {
        this._service = null;
        this._cache = new Map();
    }

    setService(service) {
        this._service = service;
    }

    needsShortening(url) {
        if (typeof url !== 'string' || !url.startsWith('http')) return false;
        if (url.includes('tinyurl.com/')) return false;
        return true;
    }

    _fetchTinyUrl(targetUrl) {
        return new Promise((resolve, reject) => {
            const apiUrl = `${TINYURL_API}${encodeURIComponent(targetUrl)}`;
            const parsed = new URL(apiUrl);
            const req = https.request(
                { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET' },
                (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => resolve({ status: res.statusCode, data: data.trim() }));
                },
            );
            req.on('error', reject);
            req.setTimeout(TINYURL_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error('TinyURL timeout'));
            });
            req.end();
        });
    }

    async _toTinyUrl(url) {
        try {
            const { status, data } = await this._fetchTinyUrl(url);
            if (status === 200 && data.startsWith('https://tinyurl.com/')) {
                return data;
            }
        } catch (err) {
            logger.warn(`TinyURL failed: ${err.message}`);
        }
        return null;
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;
        if (this._cache.has(url)) return this._cache.get(url);
        if (!this._service) return url;

        try {
            const expiringLink = await this._service.shorten(url);
            const tiny = await this._toTinyUrl(expiringLink);
            const finalUrl = tiny || expiringLink;

            if (this._cache.size >= MAX_CACHE_SIZE) {
                this._cache.delete(this._cache.keys().next().value);
            }
            this._cache.set(url, finalUrl);
            return finalUrl;
        } catch (err) {
            logger.warn(`URL shorten failed: ${err.message}`);
            return url;
        }
    }

    async shortenMovieResults(results, maxWaitMs = MAX_WAIT_MS) {
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
