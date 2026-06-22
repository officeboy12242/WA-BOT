/**
 * Fetch GitHub repos — trending, popular, and hidden gems (fresh each request).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

const TRENDING_URL = 'https://github.com/trending?since=daily';
const SEARCH_URL = 'https://api.github.com/search/repositories';

export const GITHUB_REPO_CATEGORIES = {
    trending: { label: '🔥 TRENDING', emoji: '🔥' },
    popular: { label: '⭐ POPULAR', emoji: '⭐' },
    underrated: { label: '💎 HIDDEN GEM', emoji: '💎' },
};

/** Slot order: mix categories across the day's 5 posts */
export const GITHUB_SLOT_CATEGORIES = ['trending', 'popular', 'underrated', 'trending', 'popular'];

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

const API_HEADERS = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'whatsapp-course-bot',
};

function parseStarCount(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
}

function isoDaysAgo(days) {
    const d = new Date(Date.now() - days * 86400000);
    return d.toISOString().split('T')[0];
}

function mapApiItem(item, category) {
    return {
        owner: item.owner?.login || '',
        name: item.name || '',
        fullName: item.full_name || '',
        url: item.html_url || '',
        description: item.description || 'No description',
        language: item.language || '—',
        starsToday: '',
        totalStars: item.stargazers_count != null ? String(item.stargazers_count) : '',
        forks: item.forks_count != null ? String(item.forks_count) : '',
        category,
    };
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
        $(article).find(`a[href="${href}/stargazers"]`).first().text(),
    );
    const forks = parseStarCount(
        $(article).find(`a[href="${href}/forks"]`).first().text(),
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
        category: 'trending',
    };
}

export function dedupeRepos(repos) {
    const seen = new Set();
    return (repos || []).filter((repo) => {
        const key = repo.fullName?.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

class GitHubTrendingService {
    constructor(count = 5) {
        this.count = count;
    }

    async fetchFromTrendingPage(limit = 15, since = 'daily', category = 'trending') {
        const url = `https://github.com/trending?since=${since}`;
        const resp = await axios.get(url, {
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
            if (repos.length >= limit) return false;
            const repo = parseRepoFromArticle($, article);
            if (repo?.fullName) {
                repo.category = category;
                repos.push(repo);
            }
        });

        return repos;
    }

    async searchRepos(query, { sort = 'stars', order = 'desc', limit = 15, category = 'popular' } = {}) {
        const resp = await axios.get(SEARCH_URL, {
            params: {
                q: query,
                sort,
                order,
                per_page: Math.min(limit, 30),
            },
            headers: API_HEADERS,
            timeout: 15000,
        });

        return (resp.data?.items || []).slice(0, limit).map((item) => mapApiItem(item, category));
    }

    /** Hot repos this week (GitHub weekly trending) */
    async fetchPopular(limit = 15) {
        const weekly = await this.fetchFromTrendingPage(limit, 'weekly', 'popular');
        if (weekly.length >= 3) {
            return weekly;
        }

        const since = isoDaysAgo(14);
        return this.searchRepos(
            `stars:>2500 pushed:>${since} fork:false archived:false`,
            { sort: 'stars', order: 'desc', limit, category: 'popular' },
        );
    }

    /** Active repos with modest stars — underrated / hidden gems */
    async fetchUnderrated(limit = 15) {
        const since = isoDaysAgo(30);
        return this.searchRepos(
            `stars:80..2500 forks:>5 pushed:>${since} fork:false archived:false`,
            { sort: 'updated', order: 'desc', limit, category: 'underrated' },
        );
    }

    async fetchCategory(category, limit = 15) {
        switch (category) {
            case 'popular':
                return dedupeRepos(await this.fetchPopular(limit));
            case 'underrated':
                return dedupeRepos(await this.fetchUnderrated(limit));
            case 'trending':
            default:
                return dedupeRepos(await this.fetchFromTrendingPage(limit, 'daily', 'trending'));
        }
    }

    /** Fresh mixed pool for manual /github preview (one per category, then extras) */
    async fetchMixedPool() {
        const perCategory = Math.max(3, Math.ceil(this.count / 3) + 2);
        const [trending, popular, underrated] = await Promise.allSettled([
            this.fetchCategory('trending', perCategory),
            this.fetchCategory('popular', perCategory),
            this.fetchCategory('underrated', perCategory),
        ]);

        const pick = (result) => (result.status === 'fulfilled' ? result.value : []);
        const merged = dedupeRepos([
            ...pick(trending),
            ...pick(popular),
            ...pick(underrated),
        ]);

        if (merged.length) {
            logger.info(
                `GitHub pool: ${pick(trending).length} trending, ${pick(popular).length} popular, `
                + `${pick(underrated).length} hidden gem(s)`,
            );
        }

        return merged.slice(0, this.count * 2);
    }

    /** Fresh fetch for one scheduled slot — tries primary category then fallbacks */
    async fetchForSlot(slotIndex) {
        const primary = GITHUB_SLOT_CATEGORIES[slotIndex] || 'trending';
        const fallbacks = ['trending', 'popular', 'underrated'].filter(
            (c, i, arr) => c !== primary && arr.indexOf(c) === i,
        );
        const order = [primary, ...fallbacks];

        for (const category of order) {
            try {
                const repos = await this.fetchCategory(category, 20);
                if (repos.length) {
                    logger.info(`GitHub slot ${slotIndex + 1}: ${repos.length} ${category} repo(s)`);
                    return repos;
                }
            } catch (err) {
                logger.warn(`GitHub ${category} fetch failed: ${err.message}`);
            }
        }

        return [];
    }

    /** @deprecated use fetchMixedPool */
    async fetchTrending() {
        return this.fetchMixedPool();
    }
}

export default GitHubTrendingService;
