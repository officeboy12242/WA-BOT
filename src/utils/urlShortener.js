/**
 * Shorten long movie download URLs via self-hosted /d/:code links (7h TTL).
 */

import { logger } from './logger.js';

const MIN_LENGTH_TO_SHORTEN = 55;
const MAX_WAIT_MS = 7000;

class UrlShortener {
    constructor() {
        this._service = null;
        this._cache = new Map();
    }

    setService(service) {
        this._service = service;
    }

    needsShortening(url) {
        return typeof url === 'string' && url.length >= MIN_LENGTH_TO_SHORTEN;
    }

    async shorten(url) {
        if (!this.needsShortening(url)) return url;
        if (this._cache.has(url)) return this._cache.get(url);
        if (!this._service) return url;

        try {
            const short = await this._service.shorten(url);
            this._cache.set(url, short);
            return short;
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
