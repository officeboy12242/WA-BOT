/**
 * HDHub4u movie search via free-udemy-courses-bot API.
 * Each result groups all quality/download links under one title (like AtoZ).
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { audioFromFilename } from '../utils/movieMetadata.js';
import { config } from '../config/config.js';

const DEFAULT_API_URL = 'https://free-udemy-courses-bot.onrender.com/api/movies';
const REQUEST_TIMEOUT_MS = 55_000;

function sourceLabel(raw) {
    const s = String(raw || 'hdhub4u').trim();
    if (!s) return 'HDHub4u';
    if (s.toLowerCase() === 'hdhub4u') return 'HDHub4u';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function isZipOrPackLink(link) {
    const label = String(link?.label || '');
    const size = String(link?.size || '');
    const quality = String(link?.quality || '');
    const blob = `${label} ${size} ${quality}`;
    return /\bzip\b/i.test(blob) || /\bpack\b/i.test(blob) || /\bfull\s*season\b/i.test(blob);
}

/**
 * Prefer season Zip/pack links (often listed after episode links in API).
 * Episode links fill remaining slots so WhatsApp stays under length limits.
 */
function prioritizeLinks(links, maxLinks) {
    if (!links.length || links.length <= maxLinks) return links;

    const zips = [];
    const rest = [];
    for (const link of links) {
        if (isZipOrPackLink(link)) zips.push(link);
        else rest.push(link);
    }

    const zipTake = Math.min(zips.length, maxLinks);
    const episodeTake = Math.max(0, maxLinks - zipTake);
    return [...zips.slice(0, zipTake), ...rest.slice(0, episodeTake)];
}

function formatLinkEntry(link) {
    const quality = String(link?.quality || '').trim();
    const size = String(link?.size || '').trim();
    const label = String(link?.label || '').trim();
    const url = String(link?.url || '').trim();

    if (!url) return null;

    const isZip = isZipOrPackLink({ label, size, quality });

    let sizeLine;
    if (isZip && size && label) {
        // "Zip [2.14GB] (HubCloud)" + size "2.14GB" → keep label as primary
        sizeLine = label.includes(size) ? label : `${label} • ${size}`;
    } else if (quality && size) {
        sizeLine = `${quality} • ${size}`;
    } else if (quality && label) {
        sizeLine = `${quality} • ${label}`;
    } else if (label) {
        sizeLine = label;
    } else if (size) {
        sizeLine = size;
    } else if (quality) {
        sizeLine = quality;
    } else {
        sizeLine = 'Download';
    }

    return {
        label: label || (isZip ? `Zip${size ? ` [${size}]` : ''}` : ''),
        size: sizeLine,
        audio: link?.audio || audioFromFilename(label || quality || size),
        quality: quality || undefined,
        rawFilename: label || url,
        url,
    };
}

function pageUrlAsLink(pageUrl) {
    const url = String(pageUrl || '').trim();
    if (!url.startsWith('http')) {
        return null;
    }
    return {
        label: 'Movie page',
        size: 'Open page',
        audio: '',
        rawFilename: 'page',
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

    async _fetchJson(urlStr) {
        const { data } = await axios.get(urlStr, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; SassyBot/1.0)',
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });
        return data;
    }

    _normalizeResults(payload) {
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        const results = [];
        // Episode lists can be long; zip/pack links are prioritized so they are never dropped.
        const maxLinksPerResult = 16;

        for (const row of rows) {
            const title = String(row?.title || '').trim();
            let links = (Array.isArray(row?.links) ? row.links : [])
                .map(formatLinkEntry)
                .filter(Boolean);

            if (!links.length) {
                const pageLink = pageUrlAsLink(row?.page_url);
                if (pageLink) {
                    links = [pageLink];
                }
            }

            if (!title || !links.length) continue;

            links = prioritizeLinks(links, maxLinksPerResult);

            results.push({
                title,
                source: sourceLabel(row?.source),
                pageUrl: row?.page_url || null,
                links,
            });
        }

        const rawCount = rows.length;
        if (rawCount && !results.length) {
            logger.warn(`HDHub API: ${rawCount} raw row(s) but none had links or page_url`);
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

        const apiUrl = `${this._apiBase()}?q=${encodeURIComponent(q)}`;
        let lastErr = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const started = Date.now();
                const payload = await this._fetchJson(apiUrl);
                const normalized = this._normalizeResults(payload);
                const results = normalized.slice(0, maxResults);
                logger.info(
                    `HDHub API: ${results.length}/${normalized.length} normalized from ` +
                        `${payload?.count ?? payload?.results?.length ?? 0} raw for "${q}" ` +
                        `in ${Date.now() - started}ms (attempt ${attempt})`,
                );
                return results;
            } catch (err) {
                lastErr = err;
                const msg = err?.response?.status
                    ? `HTTP ${err.response.status}`
                    : (err?.message || String(err));
                logger.warn(`HDHub movies API attempt ${attempt} failed (${apiUrl}): ${msg}`);
                if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 1500));
                }
            }
        }

        logger.warn(`HDHub movies API gave up for "${q}": ${lastErr?.message || lastErr}`);
        return [];
    }

    async _headCheck() {
        try {
            const base = this._apiBase().replace(/\/api\/movies$/, '') || 'https://free-udemy-courses-bot.onrender.com';
            const res = await axios.head(base, { timeout: 8000, validateStatus: () => true });
            return res.status >= 200 && res.status < 400;
        } catch {
            return false;
        }
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
