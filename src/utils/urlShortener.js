/**
 * Expiring movie links: self-hosted /d/:code (7h TTL) → display shortener.
 * TinyURL works on Render; Koyeb *.koyeb.app → zip1.io / clck.ru (TinyURL returns 400).
 */

import https from 'https';
import { logger } from './logger.js';
import { isTinyUrlBlockedHost } from './publicBaseUrl.js';
import { LINK_TTL_MS } from '../services/ShortLinkService.js';

const SHORTENER_TIMEOUT_MS = 3500;
const PER_LINK_SHORTEN_MS = 8000;
/** Hosts we wrap /d/ links with for WhatsApp display (all still expire via /d/ TTL). */
export const DISPLAY_SHORT_RE = /(?:tinyurl\.com|zip1\.io|clck\.ru|is\.gd|v\.gd)\//i;

const DISPLAY_SHORTENERS = [
    {
        name: 'TinyURL',
        build: (u) => `https://tinyurl.com/api-create.php?url=${encodeURIComponent(u)}`,
        ok: (status, data) => status === 200 && data.startsWith('https://tinyurl.com/'),
        attempts: 2,
    },
    {
        name: 'zip1.io',
        post: true,
        url: 'https://zip1.io/api/create',
        parse: (status, raw) => {
            if (status !== 200) return null;
            try {
                const short = JSON.parse(raw)?.short_url;
                return typeof short === 'string' && short.startsWith('https://zip1.io/') ? short : null;
            } catch {
                return null;
            }
        },
        attempts: 1,
    },
    {
        name: 'clck.ru',
        build: (u) => `https://clck.ru/--?url=${encodeURIComponent(u)}`,
        ok: (status, data) => status === 200 && /^https:\/\/clck\.ru\/\S+/.test(data),
        attempts: 1,
    },
    {
        name: 'is.gd',
        build: (u) => `https://is.gd/create.php?format=simple&url=${encodeURIComponent(u)}`,
        ok: (status, data) => status === 200 && data.startsWith('https://is.gd/'),
        attempts: 1,
    },
    {
        name: 'v.gd',
        build: (u) => `https://v.gd/create.php?format=simple&url=${encodeURIComponent(u)}`,
        ok: (status, data) => status === 200 && data.startsWith('https://v.gd/'),
        attempts: 1,
    },
];
const MAX_CACHE_SIZE = 500;
const SHORTEN_CONCURRENCY = 6;
const BATCH_PAUSE_MS = 100;
/** Keep display cache under short-link TTL (buffer so TinyURL never outlives /d/). */
const MEMORY_CACHE_TTL_MS = Math.max(60 * 60 * 1000, LINK_TTL_MS - 60 * 60 * 1000);

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
        if (DISPLAY_SHORT_RE.test(url)) return false;
        return true;
    }

    _fetchShortenerApi(apiUrl) {
        return new Promise((resolve, reject) => {
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
            req.setTimeout(SHORTENER_TIMEOUT_MS, () => {
                req.destroy();
                reject(new Error('shortener timeout'));
            });
            req.end();
        });
    }

    async _callDisplayShortener(provider, targetUrl) {
        if (provider.post) {
            const res = await fetch(provider.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl }),
                signal: AbortSignal.timeout(SHORTENER_TIMEOUT_MS),
            });
            const raw = (await res.text()).trim();
            const url = provider.parse(res.status, raw);
            if (url) return url;
            throw new Error(`${provider.name} HTTP ${res.status}`);
        }

        const { status, data } = await this._fetchShortenerApi(provider.build(targetUrl));
        if (provider.ok(status, data)) return data;
        throw new Error(`${provider.name} HTTP ${status}`);
    }

    async _toDisplayShortUrl(url) {
        const chain = isTinyUrlBlockedHost(url)
            ? DISPLAY_SHORTENERS.filter((p) => p.name !== 'TinyURL')
            : DISPLAY_SHORTENERS;

        let lastErr = null;
        for (const provider of chain) {
            for (let i = 0; i < provider.attempts; i++) {
                try {
                    return await this._callDisplayShortener(provider, url);
                } catch (err) {
                    lastErr = err;
                    if (i < provider.attempts - 1) {
                        await delay(400);
                    }
                }
            }
            if (lastErr) {
                logger.warn(`${provider.name} failed for ${url.slice(0, 60)}…: ${lastErr.message}`);
            }
        }
        return null;
    }

    /** @deprecated tests stub this — production uses _toDisplayShortUrl */
    async _toTinyUrl(url) {
        return this._toDisplayShortUrl(url);
    }

    _isDisplayShort(url) {
        return typeof url === 'string' && DISPLAY_SHORT_RE.test(url);
    }

    _isExpiringLink(link, original) {
        return typeof link === 'string' && link !== original && /\/d\/[A-Za-z0-9_-]+/.test(link);
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;

        const cached = this._cache.get(url);
        if (cached && cached.expiresAt > Date.now() && cached.finalUrl) {
            return cached.finalUrl;
        }
        if (cached) this._cache.delete(url);

        let shortMeta = null;
        let expiringLink = url;
        if (this._service) {
            try {
                const minted = await this._service.shorten(url);
                if (typeof minted === 'string') {
                    expiringLink = minted;
                } else if (minted?.url) {
                    expiringLink = minted.url;
                    shortMeta = minted;
                }
            } catch (err) {
                logger.warn(`Expiring link failed: ${err.message}`);
            }
        }

        const hasExpiring = this._isExpiringLink(expiringLink, url);
        if (!hasExpiring) {
            logger.warn(
                `No expiring /d/ link for ${url.slice(0, 60)}… — check KOYEB_PUBLIC_DOMAIN / PUBLIC_URL`,
            );
            return url;
        }

        let finalUrl = expiringLink;
        try {
            const display = await Promise.race([
                this._toDisplayShortUrl(expiringLink),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('display shorten timeout')), PER_LINK_SHORTEN_MS),
                ),
            ]);
            if (display) finalUrl = display;
        } catch (err) {
            logger.warn(
                `Display shorten skipped for ${expiringLink.slice(0, 60)}…: ${err.message} — using /d/ link`,
            );
        }

        // Only cache when we actually minted an expiring short link.
        const canCache =
            finalUrl !== url &&
            (this._isDisplayShort(finalUrl) || finalUrl.includes('/d/'));
        if (canCache) {
            const expiresAt = Math.min(
                shortMeta?.expiresAt || Date.now() + MEMORY_CACHE_TTL_MS,
                Date.now() + MEMORY_CACHE_TTL_MS,
            );
            if (this._cache.size >= MAX_CACHE_SIZE) {
                this._cache.delete(this._cache.keys().next().value);
            }
            this._cache.set(url, {
                finalUrl,
                code: shortMeta?.code || null,
                expiresAt,
            });
        }

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
                    if (this._isDisplayShort(link.url) || link.url.includes('/d/')) {
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
