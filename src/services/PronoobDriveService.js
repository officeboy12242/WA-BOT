/**
 * PronoobDrive Scraper Service
 * Scrapes movie download links from the self-hosted Render index page.
 * Uses the server-side search at /Sct?search=QUERY for each request.
 */

import https from 'https';
import http from 'http';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://pronoobdrive-7w2p.onrender.com';
const REQUEST_TIMEOUT = 15000;
const MAX_RESPONSE_BYTES = 512 * 1024; // abort if response exceeds 512KB
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
    }

    /** GET with response size limit to prevent OOM on broad queries. */
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

    _parseHtml(html) {
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
                url: `${BASE_URL}/${relUrl}`,
            });
            if (files.length >= MAX_PARSED_CARDS) break;
        }
        return files;
    }

    async searchMovies(query, maxResults = 5) {
        try {
            const searchUrl = `${BASE_URL}/Sct?search=${encodeURIComponent(query)}`;
            const { status, data } = await this._fetch(searchUrl);

            if (status !== 200) {
                logger.warn(`PronoobDrive search returned status ${status}`);
                return [];
            }

            const files = this._parseHtml(data);
            if (!files.length) return [];

            const groups = new Map();
            for (const file of files) {
                const key = file.title.toLowerCase();
                if (!groups.has(key)) {
                    groups.set(key, { title: file.title, links: [] });
                }
                const label = file.quality ? `${file.quality} • ${file.size}` : file.size;
                groups.get(key).links.push({ size: label, url: file.url });
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

    /** Lightweight HEAD ping to keep Render awake without downloading HTML. */
    startKeepAlive(intervalMs = 4 * 60 * 1000) {
        this.stopKeepAlive();
        const ping = () => {
            const url = new URL(`${BASE_URL}/Sct`);
            const req = https.request(
                { hostname: url.hostname, path: url.pathname, method: 'HEAD' },
                (res) => {
                    res.resume();
                    logger.info(`🏓 Drive keep-alive ping OK (${res.statusCode})`);
                },
            );
            req.on('error', () => logger.warn('🏓 Drive keep-alive ping failed (will retry)'));
            req.setTimeout(10000, () => req.destroy());
            req.end();
        };
        ping();
        this._keepAliveTimer = setInterval(ping, intervalMs);
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
