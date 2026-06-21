/**
 * PronoobDrive Scraper Service
 * Scrapes movie download links from self-hosted Render instances.
 * Rotates through configured base URLs with health checks.
 */

import https from 'https';
import http from 'http';
import { logger } from '../utils/logger.js';
import { audioFromFilename } from '../utils/movieMetadata.js';

const DEFAULT_BASE_URL = 'https://pronoobdrive-7w2p.onrender.com';
const REQUEST_TIMEOUT = 15000;
const HEALTH_TIMEOUT = 8000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_PARSED_CARDS = 20;

const CARD_RE =
    /<!-- Card\s+-->\s*<div title="\s*[^|]+\|\s*([^"]+?)\s*"[^>]*>[\s\S]*?<a href="(Sct\/\d+\/[^"]+)"[\s\S]*?<button title="([^"]+?)\.m3u"/g;

function decodeHtmlEntities(str) {
    return str
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
}

function normalizeBaseUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
        const parsed = new URL(u);
        return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, '');
    } catch {
        return '';
    }
}

function driveSourceLabel(baseUrl, urlCount) {
    if (urlCount <= 1) return 'Drive';
    try {
        const host = new URL(baseUrl).hostname.replace(/\.onrender\.com$/i, '');
        return `Drive (${host})`;
    } catch {
        return 'Drive';
    }
}

function qualityFromFilename(name) {
    const n = name.toLowerCase();
    if (n.includes('2160p') || n.includes('4k')) return '4K';
    if (n.includes('1080p')) return '1080p';
    if (n.includes('1440p')) return '1440p';
    if (n.includes('720p') && n.includes('hevc')) return '720p HEVC';
    if (n.includes('720p')) return '720p';
    if (n.includes('480p')) return '480p';
    return '';
}

function titleFromFilename(raw) {
    let name = raw
        .replace(/^@\S+\s*[-–]\s*/, '')
        .replace(/\.[^.]+$/, '');

    name = name.replace(/[._]/g, ' ').replace(/\s{2,}/g, ' ').trim();

    const cutPoint = name.search(
        /\b(1080p|1440p|720p|480p|2160p|4K|HDRip|WEBRip|WEB-DL|BluRay|HDTC|HQRip|HEVC|x264|x265|H 264|H 265|DD|DDP|AAC|Atmos|SONYLIV|AMZN|Youtube)\b/i,
    );
    if (cutPoint > 3) {
        name = name.substring(0, cutPoint).trim();
    }

    name = name.replace(/[\[\(]\s*$/, '').trim();
    return name || raw;
}

class PronoobDriveService {
    constructor() {
        this.name = 'Drive';
        this._settings = null;
        this._urls = [DEFAULT_BASE_URL];
        this._rotateIndex = 0;
        this._lastHealthyUrl = null;
    }

    setSettings(botSettings) {
        this._settings = botSettings;
    }

    async loadUrls() {
        if (this._settings) {
            const stored = (await this._settings.getDriveSources())
                .map(normalizeBaseUrl)
                .filter(Boolean);
            if (stored.length) {
                this._urls = [...new Set(stored)];
                return;
            }
        }
        this._urls = [DEFAULT_BASE_URL];
    }

    getUrls() {
        return [...this._urls];
    }

    async addUrl(rawUrl) {
        const url = normalizeBaseUrl(rawUrl);
        if (!url) throw new Error('Invalid URL');
        await this.loadUrls();
        if (this._urls.includes(url)) {
            return { added: false, urls: this._urls };
        }
        this._urls.push(url);
        if (this._settings) {
            await this._settings.setDriveSources(this._urls);
        }
        return { added: true, urls: this._urls };
    }

    async removeUrl(indexOneBased) {
        await this.loadUrls();
        const idx = indexOneBased - 1;
        if (idx < 0 || idx >= this._urls.length) {
            throw new Error('Invalid index');
        }
        const removed = this._urls.splice(idx, 1);
        if (!this._urls.length) {
            this._urls = [DEFAULT_BASE_URL];
        }
        if (this._settings) {
            await this._settings.setDriveSources(
                this._urls.length === 1 && this._urls[0] === DEFAULT_BASE_URL ? [] : this._urls,
            );
        }
        this._rotateIndex = 0;
        return { removed: removed[0], urls: this._urls };
    }

    _orderedUrlsForRotation() {
        if (!this._urls.length) return [DEFAULT_BASE_URL];
        const ordered = [];
        for (let i = 0; i < this._urls.length; i++) {
            ordered.push(this._urls[(this._rotateIndex + i) % this._urls.length]);
        }
        return ordered;
    }

    _headCheck(baseUrl) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => {
                if (!settled) {
                    settled = true;
                    resolve(ok);
                }
            };
            try {
                const url = new URL(`${baseUrl}/Sct`);
                const mod = url.protocol === 'https:' ? https : http;
                const req = mod.request(
                    { hostname: url.hostname, port: url.port, path: url.pathname, method: 'HEAD' },
                    (res) => {
                        res.resume();
                        finish(res.statusCode >= 200 && res.statusCode < 400);
                    },
                );
                req.on('error', () => finish(false));
                req.setTimeout(HEALTH_TIMEOUT, () => {
                    req.destroy();
                    finish(false);
                });
                req.end();
            } catch {
                finish(false);
            }
        });
    }

    async _pickHealthyBase() {
        await this.loadUrls();
        const candidates = this._orderedUrlsForRotation();

        for (let i = 0; i < candidates.length; i++) {
            const base = candidates[i];
            const ok = await this._headCheck(base);
            if (ok) {
                this._lastHealthyUrl = base;
                const foundAt = this._urls.indexOf(base);
                if (foundAt >= 0) {
                    this._rotateIndex = (foundAt + 1) % this._urls.length;
                }
                logger.info(`Drive source OK: ${base}`);
                return base;
            }
            logger.warn(`Drive source down: ${base}`);
        }

        return null;
    }

    async testAllSources() {
        await this.loadUrls();
        const results = [];
        for (let i = 0; i < this._urls.length; i++) {
            const url = this._urls[i];
            const ok = await this._headCheck(url);
            results.push({ index: i + 1, url, ok });
        }
        return results;
    }

    _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const mod = url.protocol === 'https:' ? https : http;
            let settled = false;
            const done = (val) => { if (!settled) { settled = true; resolve(val); } };
            const fail = (err) => { if (!settled) { settled = true; reject(err); } };

            const req = mod.request(
                { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' },
                (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const redirect = new URL(res.headers.location, urlStr).href;
                        res.resume();
                        return this._fetch(redirect).then(done, fail);
                    }
                    let size = 0;
                    const chunks = [];
                    res.on('data', (c) => {
                        if (settled) return;
                        size += c.length;
                        if (size > MAX_RESPONSE_BYTES) {
                            res.destroy();
                            done({ status: res.statusCode, data: Buffer.concat(chunks).toString() });
                            return;
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => done({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
                    res.on('error', () => done({ status: res.statusCode, data: Buffer.concat(chunks).toString() }));
                },
            );
            req.on('error', fail);
            req.setTimeout(REQUEST_TIMEOUT, () => { req.destroy(); fail(new Error('Request timeout')); });
            req.end();
        });
    }

    _parseHtml(html, baseUrl) {
        const files = [];
        let match;
        CARD_RE.lastIndex = 0;
        while ((match = CARD_RE.exec(html)) !== null) {
            const size = match[1].trim();
            const relUrl = match[2];
            const rawFilename = decodeHtmlEntities(match[3]);
            files.push({
                rawFilename,
                title: titleFromFilename(rawFilename),
                quality: qualityFromFilename(rawFilename),
                size,
                url: `${baseUrl}/${relUrl}`,
            });
            if (files.length >= MAX_PARSED_CARDS) break;
        }
        return files;
    }

    async _searchSingleBase(baseUrl, query, maxResults, sourceLabel) {
        const searchUrl = `${baseUrl}/Sct?search=${encodeURIComponent(query)}`;
        let status;
        let data;
        try {
            ({ status, data } = await this._fetch(searchUrl));
        } catch (err) {
            throw new Error(`unreachable: ${err.message}`);
        }

        if (status !== 200) {
            throw new Error(`HTTP ${status}`);
        }

        const files = this._parseHtml(data, baseUrl);
        if (!files.length) return [];

        const groups = new Map();
        for (const file of files) {
            const key = file.title.toLowerCase();
            if (!groups.has(key)) {
                groups.set(key, { title: file.title, links: [] });
            }
            const label = file.quality ? `${file.quality} • ${file.size}` : file.size;
            groups.get(key).links.push({
                size: label,
                audio: audioFromFilename(file.rawFilename),
                url: file.url,
            });
        }

        const results = [];
        for (const [, group] of groups) {
            results.push({ title: group.title, source: sourceLabel, links: group.links });
            if (results.length >= maxResults) break;
        }

        return results;
    }

    async searchMovies(query, maxResults = 5) {
        try {
            await this.loadUrls();
            const urlCount = this._urls.length || 1;
            const urls = this._orderedUrlsForRotation();

            for (let i = 0; i < urls.length; i++) {
                const baseUrl = urls[i];
                const sourceLabel = driveSourceLabel(baseUrl, urlCount);
                try {
                    const results = await this._searchSingleBase(baseUrl, query, maxResults, sourceLabel);
                    if (results.length > 0) {
                        logger.info(`Drive ${baseUrl}: ${results.length} result(s) for "${query}"`);
                        return results;
                    }
                    logger.warn(`Drive ${baseUrl}: no results for "${query}"${i < urls.length - 1 ? ', trying next source' : ''}`);
                } catch (err) {
                    logger.warn(`Drive ${baseUrl} unavailable (${err.message})${i < urls.length - 1 ? ', trying next source' : ''}`);
                }
            }

            return [];
        } catch (err) {
            logger.error(`PronoobDrive searchMovies error: ${err.message}`);
            return [];
        } finally {
            if (this._urls.length) {
                this._rotateIndex = (this._rotateIndex + 1) % this._urls.length;
            }
        }
    }

    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = async () => {
            await this.loadUrls();
            const urls = this.getUrls();
            if (!urls.length) return;

            await Promise.allSettled(urls.map(async (base) => {
                const ok = await this._headCheck(base);
                if (ok) {
                    logger.info(`🏓 Drive keep-alive OK (${base})`);
                } else {
                    logger.warn(`🏓 Drive keep-alive failed (${base})`);
                }
            }));
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

export const pronoobDriveService = new PronoobDriveService();
export default PronoobDriveService;
