/**
 * AtoZ Cinemas Scraper Service
 * Scrapes movie download links from atoz.cinemaz.workers.dev
 */

import https from 'https';
import { logger } from '../utils/logger.js';

const BASE_URL = 'https://atoz.cinemaz.workers.dev';
const REQUEST_TIMEOUT = 15000;
const TINYURL_API = 'https://tinyurl.com/api-create.php?url=';
const MAX_URL_CACHE_SIZE = 500;

class AtoZService {
    constructor() {
        this.name = 'AtoZ Cinemas';
        this._shortUrlCache = new Map();
    }

    /**
     * Shorten URL using TinyURL
     */
    async _shortenUrl(longUrl) {
        // Check cache first
        if (this._shortUrlCache.has(longUrl)) {
            return this._shortUrlCache.get(longUrl);
        }

        try {
            const result = await this._fetch(`${TINYURL_API}${encodeURIComponent(longUrl)}`);
            if (result.status === 200 && result.data.startsWith('https://tinyurl.com/')) {
                if (this._shortUrlCache.size >= MAX_URL_CACHE_SIZE) {
                    const oldest = this._shortUrlCache.keys().next().value;
                    this._shortUrlCache.delete(oldest);
                }
                this._shortUrlCache.set(longUrl, result.data);
                return result.data;
            }
        } catch (err) {
            logger.warn(`TinyURL shortening failed: ${err.message}`);
        }
        
        // Return original if shortening fails
        return longUrl;
    }

    /**
     * Make HTTPS request
     */
    async _fetch(urlStr) {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            req.on('error', reject);
            req.setTimeout(REQUEST_TIMEOUT, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            req.end();
        });
    }

    /**
     * Parse movie page HTML to extract file information
     */
    _parseMoviePage(html) {
        const files = [];
        
        // Extract file_ids, filenames, and sizes using regex patterns
        const fileIds = [...html.matchAll(/\\?"file_id\\?":\\?"([^"\\]+)\\?"/g)].map(m => m[1]);
        const filenames = [...html.matchAll(/\\?"file_name\\?":\\?"([^"\\]+)\\?"/g)].map(m => m[1]);
        const sizes = [...html.matchAll(/(\d+(?:\.\d+)?\s*(?:GB|MB))/gi)].map(m => m[1]);
        
        // Build file objects
        for (let i = 0; i < fileIds.length; i++) {
            const filename = filenames[i] || '';
            let quality = 'Unknown';
            
            // Determine quality from filename
            if (filename.includes('1080p')) quality = '1080p';
            else if (filename.includes('720p') && filename.toLowerCase().includes('hevc')) quality = '720p HEVC';
            else if (filename.includes('720p')) quality = '720p';
            else if (filename.includes('480p')) quality = '480p';
            else if (filename.includes('2160p') || filename.includes('4K')) quality = '4K';
            
            files.push({
                quality,
                filename,
                size: sizes[i] || 'N/A',
                file_id: fileIds[i],
                url: `${BASE_URL}/links/${fileIds[i]}`,
            });
        }
        
        return files;
    }

    /**
     * Search for movies on AtoZ Cinemas
     */
    async search(query) {
        try {
            const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
            const result = await this._fetch(searchUrl);
            
            if (result.status !== 200) {
                logger.warn(`AtoZ search returned status ${result.status}`);
                return [];
            }
            
            // Extract movie slugs from search results
            // Pattern matches movie slugs like: movie-name-2024-webrip-hindi-esubs
            const slugPattern = /href="\/([a-z0-9-]+-\d{4}-[^"]+)"/gi;
            const slugs = [...new Set([...result.data.matchAll(slugPattern)].map(m => m[1]))];
            
            return slugs;
        } catch (err) {
            logger.error(`AtoZ search error: ${err.message}`);
            return [];
        }
    }

    /**
     * Get movie details and file links by slug
     */
    async getMovieBySlug(slug) {
        try {
            const url = `${BASE_URL}/${slug}`;
            const result = await this._fetch(url);
            
            if (result.status !== 200) {
                logger.warn(`AtoZ movie page returned status ${result.status}`);
                return null;
            }
            
            // Extract title from page
            const titleMatch = result.data.match(/<title>([^<]+)<\/title>/i);
            let title = titleMatch ? titleMatch[1].replace(/\s*[-|].*$/, '').trim() : slug;
            
            // Clean up title
            title = title.replace(/\s*—\s*AtoZ\s*Cinemas/i, '').trim();
            
            const files = this._parseMoviePage(result.data);
            
            return {
                title,
                slug,
                pageUrl: url,
                files,
            };
        } catch (err) {
            logger.error(`AtoZ getMovie error: ${err.message}`);
            return null;
        }
    }

    /**
     * Search and get full movie results with files
     * Returns data in format compatible with MovieController
     */
    async searchMovies(query, maxResults = 5) {
        try {
            const slugs = await this.search(query);

            if (!slugs.length) {
                return [];
            }

            const movies = await Promise.all(
                slugs.slice(0, maxResults).map((slug) => this.getMovieBySlug(slug)),
            );

            const results = [];
            for (const movie of movies) {
                if (!movie || !movie.files.length) continue;
                results.push({
                    title: movie.title,
                    source: 'AtoZ',
                    links: movie.files.map((f) => ({
                        size: `${f.quality} • ${f.size}`,
                        url: f.url,
                    })),
                });
            }

            return results;
        } catch (err) {
            logger.error(`AtoZ searchMovies error: ${err.message}`);
            return [];
        }
    }
}

// Export singleton instance
export const atozService = new AtoZService();
export default AtoZService;
