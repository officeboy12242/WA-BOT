/**
 * Expiring movie links: self-hosted /d/:code (7h TTL) → TinyURL for display.
 */

import https from 'https';
import { logger } from './logger.js';

const TINYURL_API = 'https://tinyurl.com/api-create.php?url=';
const TINYURL_TIMEOUT_MS = 5000;
const PER_LINK_SHORTEN_MS = 8000;
const MAX_CACHE_SIZE = 500;
const SHORTEN_CONCURRENCY = 4;
const BATCH_PAUSE_MS = 250;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    async _toTinyUrl(url, attempts = 2) {
        let lastErr = null;
        for (let i = 0; i < attempts; i++) {
            try {
                const { status, data } = await this._fetchTinyUrl(url);
                if (status === 200 && data.startsWith('https://tinyurl.com/')) {
                    return data;
                }
                lastErr = new Error(`TinyURL HTTP ${status}`);
            } catch (err) {
                lastErr = err;
                if (i < attempts - 1) {
                    await delay(400);
                }
            }
        }
        if (lastErr) {
            logger.warn(`TinyURL failed for ${url.slice(0, 60)}…: ${lastErr.message}`);
        }
        return null;
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;

        const cached = this._cache.get(url);
        if (cached) {
            return cached.finalUrl;
        }

        const work = (async () => {
            let expiringLink = url;
            if (this._service) {
                try {
                    expiringLink = await this._service.shorten(url);
                } catch (err) {
                    logger.warn(`Expiring link failed: ${err.message}`);
                }
            }

            let tiny = await this._toTinyUrl(expiringLink);
            if (!tiny && expiringLink !== url) {
                tiny = await this._toTinyUrl(url);
            }

            return tiny || expiringLink;
        })();

        let finalUrl = url;
        try {
            finalUrl = await Promise.race([
                work,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('shorten timeout')), PER_LINK_SHORTEN_MS),
                ),
            ]);
        } catch (err) {
            logger.warn(`Shorten skipped for ${url.slice(0, 60)}…: ${err.message}`);
            finalUrl = url;
        }

        if (this._cache.size >= MAX_CACHE_SIZE) {
            this._cache.delete(this._cache.keys().next().value);
        }
        this._cache.set(url, { expiringLink: finalUrl, finalUrl });

        return finalUrl;
    }

    async shortenMovieResults(results, maxMs = 45000) {
        const links = [];
        for (const item of results) {
            for (const link of item.links || []) {
                if (this.needsShortening(link.url)) {
                    links.push(link);
                }
            }
        }
        if (!links.length) return results;

        const deadline = Date.now() + maxMs;
        let shortened = 0;
        let failed = 0;
        let skipped = 0;

        for (let i = 0; i < links.length; i += SHORTEN_CONCURRENCY) {
            if (Date.now() >= deadline) {
                skipped = links.length - i;
                logger.warn(`URL shorten time budget reached — ${skipped} link(s) left unshortened`);
                break;
            }

            const batch = links.slice(i, i + SHORTEN_CONCURRENCY);
            const outcomes = await Promise.allSettled(
                batch.map(async (link) => {
                    const original = link.url;
                    link.url = await this.shorten(original);
                    if (link.url.includes('tinyurl.com/') || link.url.includes('/d/')) {
                        shortened++;
                    } else if (this.needsShortening(link.url)) {
                        failed++;
                    }
                }),
            );

            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') {
                    failed++;
                    logger.warn(`Link shorten rejected: ${outcome.reason?.message || outcome.reason}`);
                }
            }

            if (i + SHORTEN_CONCURRENCY < links.length) {
                await delay(BATCH_PAUSE_MS);
            }
        }

        logger.info(`URL shorten done: ${shortened}/${links.length} short, ${failed} long, ${skipped} skipped`);
        return results;
    }
}

export const urlShortener = new UrlShortener();
export default UrlShortener;
