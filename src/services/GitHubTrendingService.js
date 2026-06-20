/**
 * Fetch daily trending GitHub repositories (scrape + API fallback).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

const TRENDING_URL = 'https://github.com/trending?since=daily';

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

function parseStarCount(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function parseRepoFromArticle($, article) {
    const link = $(article).find('h2 a').first();
    const href = link.attr('href') || '';
    const fullName = link.text().replace(/\s+/g, ' ').trim();
    if (!href || !fullName) return null;

    const parts = fullName.split('/').map((p) => p.trim()).filter(Boolean);
    const owner = parts[0] || '';
    const name = parts[1] || parts[0] || '';
    const description = $(article).find('p.col-9, p[class*="color-fg-muted"]').first().text().trim();
    const language = $(article).find('[itemprop="programmingLanguage"]').first().text().trim();

    let starsToday = '';
    $(article).find('span.d-inline-block').each((_, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (/stars?\s+today/i.test(text)) {
            starsToday = parseStarCount(text);
        }
    });

    const totalStars = parseStarCount(
        $(article).find(`a[href="${href}/stargazers"]`).first().text()
    );
    const forks = parseStarCount(
        $(article).find(`a[href="${href}/forks"]`).first().text()
    );

    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        url: `https://github.com${href}`,
        description: description || 'No description',
        language: language || '—',
        starsToday: starsToday || '',
        totalStars: totalStars || '',
        forks: forks || '',
    };
}

class GitHubTrendingService {
    constructor(count = 5) {
        this.count = count;
    }

    async fetchFromTrendingPage() {
        const resp = await axios.get(TRENDING_URL, {
            headers: DEFAULT_HEADERS,
            timeout: 20000,
            validateStatus: (status) => status < 500,
        });

        if (resp.status !== 200 || !resp.data) {
            logger.warn(`GitHub trending page returned HTTP ${resp.status}`);
            return [];
        }

        const $ = cheerio.load(resp.data);
        const repos = [];

        $('article.Box-row').each((_, article) => {
            if (repos.length >= this.count) return false;
            const repo = parseRepoFromArticle($, article);
            if (repo?.fullName) repos.push(repo);
        });

        return repos;
    }

    async fetchFromSearchApi() {
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const url = 'https://api.github.com/search/repositories';
        const resp = await axios.get(url, {
            params: {
                q: `created:>${yesterday}`,
                sort: 'stars',
                order: 'desc',
                per_page: this.count,
            },
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'whatsapp-course-bot',
            },
            timeout: 15000,
        });

        return (resp.data?.items || []).slice(0, this.count).map((item) => ({
            owner: item.owner?.login || '',
            name: item.name || '',
            fullName: item.full_name || '',
            url: item.html_url || '',
            description: item.description || 'No description',
            language: item.language || '—',
            starsToday: '',
            totalStars: item.stargazers_count ? String(item.stargazers_count) : '',
            forks: item.forks_count ? String(item.forks_count) : '',
        }));
    }

    async fetchTrending() {
        try {
            const scraped = await this.fetchFromTrendingPage();
            if (scraped.length >= Math.min(3, this.count)) {
                logger.info(`GitHub trending: ${scraped.length} repo(s) from trending page`);
                return scraped.slice(0, this.count);
            }
        } catch (err) {
            logger.warn(`GitHub trending scrape failed: ${err.message}`);
        }

        try {
            const fromApi = await this.fetchFromSearchApi();
            if (fromApi.length) {
                logger.info(`GitHub trending: ${fromApi.length} repo(s) from search API fallback`);
                return fromApi;
            }
        } catch (err) {
            logger.warn(`GitHub search API fallback failed: ${err.message}`);
        }

        return [];
    }
}

export default GitHubTrendingService;
