/**
 * PronoobDrive Scraper Service
 * Scrapes movie download links from the self-hosted Render index page.
 * The page dumps ALL files as HTML; search filtering happens locally.
 */

import https from 'https';
import http from 'http';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://pronoobdrive-7w2p.onrender.com';
const REQUEST_TIMEOUT = 25000;
const CACHE_TTL_MS = 10 * 60 * 1000; // refresh file list every 10 min
const CARD_RE =
    /<!-- Card\s+-->\s*<div title="\s*[^|]+\|\s*([^"]+?)\s*"[^>]*>[\s\S]*?<a href="(Sct\/\d+\/[^"]+)"[\s\S]*?<button title="([^"]+?)\.m3u"/g;

function qualityFromFilename(name) {
    const n = name.toLowerCase();
    if (n.includes('2160p') || n.includes('4k')) return '4K';
    if (n.includes('1080p')) return '1080p';
    if (n.includes('720p') && n.includes('hevc')) return '720p HEVC';
    if (n.includes('720p')) return '720p';
    if (n.includes('480p')) return '480p';
    return '';
}

function titleFromFilename(raw) {
    let name = raw
        .replace(/^@\S+\s*[-–]\s*/, '') // strip channel tags like @Latest_Movies_Reborn -
        .replace(/\.[^.]+$/, '');        // strip extension

    // Replace dots/underscores with spaces for readability
    name = name.replace(/[._]/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Try to cut at the first quality/codec tag to get a clean title
    const cutPoint = name.search(
        /\b(1080p|720p|480p|2160p|4K|HDRip|WEBRip|WEB-DL|BluRay|HDTC|HQRip|HEVC|x264|x265|H 264|H 265|DD|DDP|AAC|Atmos)\b/i,
    );
    if (cutPoint > 3) {
        name = name.substring(0, cutPoint).trim();
    }

    // Remove trailing year brackets / parens residue
    name = name.replace(/[\[\(]\s*$/, '').trim();

    return name || raw;
}

class PronoobDriveService {
    constructor() {
        this.name = 'Drive';
        this._cache = [];        // parsed file objects
        this._cacheTime = 0;     // when cache was populated
        this._fetching = null;   // in-flight promise (dedup concurrent requests)
    }

    /** Low-level HTTPS GET returning { status, data }. */
    _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const mod = url.protocol === 'https:' ? https : http;
            const req = mod.request(
                { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
                (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
                },
            );
            req.on('error', reject);
            req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); reject(new Error('Request timeout')); });
            req.end();
        });
    }

    /** Parse the index HTML and return an array of file objects. */
    _parseHtml(html) {
        const files = [];
        let match;
        CARD_RE.lastIndex = 0;
        while ((match = CARD_RE.exec(html)) !== null) {
            const size = match[1].trim();
            const relUrl = match[2];
            const rawFilename = match[3];
            files.push({
                rawFilename,
                title: titleFromFilename(rawFilename),
                quality: qualityFromFilename(rawFilename),
                size,
                url: `${BASE_URL}/${relUrl}`,
            });
        }
        return files;
    }

    /** Refresh the cached file list (deduplicates concurrent calls). */
    async _refreshCache() {
        if (this._fetching) return this._fetching;

        this._fetching = (async () => {
            try {
                const { status, data } = await this._fetch(`${BASE_URL}/?name=`);
                if (status !== 200) {
                    logger.warn(`PronoobDrive returned status ${status}`);
                    return;
                }
                const files = this._parseHtml(data);
                if (files.length) {
                    this._cache = files;
                    this._cacheTime = Date.now();
                    logger.info(`PronoobDrive cache refreshed: ${files.length} files`);
                }
            } catch (err) {
                logger.warn(`PronoobDrive refresh failed: ${err.message}`);
            } finally {
                this._fetching = null;
            }
        })();

        return this._fetching;
    }

    /** Ensure cache is warm; refresh if stale. */
    async _ensureCache() {
        if (Date.now() - this._cacheTime > CACHE_TTL_MS || !this._cache.length) {
            await this._refreshCache();
        }
    }

    /**
     * Search cached files for a query string.
     * Returns results in the format MovieController expects:
     *   [{ title, source, links: [{ size, url }] }]
     */
    async searchMovies(query, maxResults = 5) {
        try {
            await this._ensureCache();
            if (!this._cache.length) return [];

            const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

            // Score each file: every query term that appears in the filename boosts the score
            const scored = this._cache
                .map((f) => {
                    const haystack = f.rawFilename.toLowerCase();
                    const hits = terms.filter((t) => haystack.includes(t)).length;
                    return { file: f, hits };
                })
                .filter((s) => s.hits > 0)
                .sort((a, b) => b.hits - a.hits);

            // Group files by cleaned title so multiple qualities appear as links
            const groups = new Map();
            for (const { file } of scored) {
                const key = file.title.toLowerCase();
                if (!groups.has(key)) {
                    groups.set(key, { title: file.title, links: [] });
                }
                const qualityLabel = file.quality ? `${file.quality} • ${file.size}` : file.size;
                groups.get(key).links.push({ size: qualityLabel, url: file.url });
                if (groups.size >= maxResults * 2) break; // limit scanning
            }

            const results = [];
            for (const [, group] of groups) {
                results.push({ title: group.title, source: 'Drive', links: group.links });
                if (results.length >= maxResults) break;
            }

            return results;
        } catch (err) {
            logger.error(`PronoobDrive searchMovies error: ${err.message}`);
            return [];
        }
    }

    /** Warm-up call — pre-populate cache at boot. */
    warmUp() {
        void this._refreshCache();
    }
}

export const pronoobDriveService = new PronoobDriveService();
export default PronoobDriveService;
