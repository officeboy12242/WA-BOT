/**
 * HDHub4u movie search via free-udemy-courses-bot API.
 * Each result groups all quality/download links under one title (like AtoZ).
 */

import https from 'https';
import { logger } from '../utils/logger.js';
import { audioFromFilename } from '../utils/movieMetadata.js';
import { config } from '../config/config.js';

const DEFAULT_API_URL = 'https://free-udemy-courses-bot.onrender.com/api/movies';
const REQUEST_TIMEOUT = 20000;

function sourceLabel(raw) {
    const s = String(raw || 'hdhub4u').trim();
    if (!s) return 'HDHub4u';
    if (s.toLowerCase() === 'hdhub4u') return 'HDHub4u';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatLinkEntry(link) {
    const quality = String(link?.quality || '').trim();
    const size = String(link?.size || '').trim();
    const label = String(link?.label || '').trim();
    const url = String(link?.url || '').trim();

    if (!url) return null;

    let sizeLine;
    if (quality && size) {
        sizeLine = `${quality} • ${size}`;
    } else if (quality && label) {
        sizeLine = `${quality} • ${label}`;
    } else if (label) {
        sizeLine = label;
    } else if (quality) {
        sizeLine = quality;
    } else {
        sizeLine = 'Download';
    }

    return {
        label,
        size: sizeLine,
        audio: link?.audio || audioFromFilename(label || quality),
        quality: quality || undefined,
        rawFilename: label || url,
        url,
    };
}

class HdHubMoviesService {
    constructor() {
        this.name = 'HDHub4u';
    }

    _apiBase() {
        const raw = config.MOVIES_API_URL || DEFAULT_API_URL;
        return String(raw).replace(/\/$/, '');
    }

    _fetchJson(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; SassyBot/1.0)',
                    Accept: 'application/json',
                },
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error(`Invalid JSON: ${err.message}`));
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(REQUEST_TIMEOUT, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.end();
        });
    }

    _normalizeResults(payload) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const results = [];

        for (const row of rows) {
            const title = String(row?.title || '').trim();
            const links = (Array.isArray(row?.links) ? row.links : [])
                .map(formatLinkEntry)
                .filter(Boolean);

            if (!title || !links.length) continue;

            results.push({
                title,
                source: sourceLabel(row?.source),
                pageUrl: row?.page_url || null,
                links,
            });
        }

        return results;
    }

    /**
     * Search movies — returns grouped results compatible with MovieController.
     * @param {string} query
     * @param {number} maxResults
     */
    async searchMovies(query, maxResults = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        try {
            const apiUrl = `${this._apiBase()}?q=${encodeURIComponent(q)}`;
            const payload = await this._fetchJson(apiUrl);
            return this._normalizeResults(payload).slice(0, maxResults);
        } catch (err) {
            logger.warn(`HDHub movies API error: ${err.message}`);
            return [];
        }
    }

    _headCheck() {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (!settled) {
                    settled = true;
                    resolve(ok);
                }
            };

            try {
                const base = this._apiBase().replace(/\/api\/movies$/, '') || 'https://free-udemy-courses-bot.onrender.com';
                const url = new URL(base);
                const req = https.request(
                    { hostname: url.hostname, path: url.pathname || '/', method: 'HEAD' },
                    (res) => {
                        res.resume();
                        finish(res.statusCode >= 200 && res.statusCode < 400);
                    },
                );
                req.on('error', () => finish(false));
                req.setTimeout(8000, () => {
                    req.destroy();
                    finish(false);
                });
                req.end();
            } catch {
                finish(false);
            }
        });
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            const ok = await this._headCheck();
            if (ok) {
                logger.info(`🏓 HDHub movies API keep-alive OK (${this._apiBase()})`);
            } else {
                logger.warn(`🏓 HDHub movies API keep-alive failed (${this._apiBase()})`);
            }
        };
        void ping();
        this._keepAliveTimer = setInterval(() => { void ping(); }, intervalMs);
    }

    stopKeepAlive() {
        if (this._keepAliveTimer) {
            clearInterval(this._keepAliveTimer);
            this._keepAliveTimer = null;
        }
    }
}

export const hdHubMoviesService = new HdHubMoviesService();
export default HdHubMoviesService;
