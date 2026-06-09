/**
 * Romantic good-morning messages for girlfriend — large pool, no authors, rare repeats.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import { generateRomanticMorningPool } from '../utils/romanticMorningPool.js';

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html',
};

const STATIC_PAGES = [
    'https://www.wishesmsg.com/good-morning-messages-for-girlfriend/',
    'https://www.wishesmsg.com/good-morning-messages-for-her/',
    'https://www.wishesmsg.com/good-morning-love-messages/',
    'https://www.wishesmsg.com/good-morning-messages-wishes-quotes/',
];

const HUB_URL = 'https://www.wishesmsg.com/good-morning-messages/';
const RECYCLE_AFTER_DAYS = 730;

let discoveredPageCache = null;
let discoveredPageCacheAt = 0;
const PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeText(text) {
    return text.trim().replace(/\s+/g, ' ');
}

function sanitizeMessage(text) {
    let t = normalizeText(text);
    t = t.replace(/<[^>]*>/g, '');
    t = t.replace(/^["']+|["']+$/g, '');
    t = t.replace(/\s*[—–-]\s*[A-Z][A-Za-z.\s]{1,50}$/u, '');
    return t.trim();
}

function isRomanticGoodMorning(text) {
    const t = sanitizeMessage(text);
    if (t.length < 35 || t.length > 280) {
        return false;
    }

    const skip =
        /messages for|quotes for|paragraphs|wishes for|feeling confused|here you|don't worry|get ready|picture the|cookie|privacy|comment|subscribe|read more|alt=|img |decoding=|category|table of contents|share on|click here|related posts/i;
    if (skip.test(t)) {
        return false;
    }

    const romantic =
        /love|sweetheart|sweetie|baby|babe|darling|beautiful|gorgeous|handsome|heart|kiss|hug|mine|girlfriend|princess|queen|angel|sunshine|soul|forever|miss you|thinking of you|lucky|adore|cutie|beloved|honey|dear|my girl|my love|you mean|only you|cherish|romantic|together|hold you|beside you|next to you|yours|treasure|precious/i;
    const morningish =
        /good morning|wake up|rise and shine|morning,|this morning|start your day|new day|may your day|wishing you|hope your|have a (beautiful|lovely|wonderful|great) (day|morning)/i;

    return romantic.test(t) && morningish.test(t);
}

/** Messages addressed to girlfriend, not boyfriend/friends/family. */
function isForGirlfriend(text) {
    const t = text.toLowerCase();
    if (
        /good morning handsome|my man\b|my king\b|my husband|for him\b|to my boyfriend|your boyfriend|dear friend|best friend|good morning bro|good morning dude|good morning sir|good morning dad|good morning mom|good morning mother|good morning father|for coworkers|for boss|for colleague/i.test(
            t
        )
    ) {
        return false;
    }
    if (/\bfor friends\b|\bto my friend\b|\bfriendship\b/i.test(t)) {
        return false;
    }
    return isRomanticGoodMorning(text);
}

class MorningMessageScraper {
    constructor(morningDb) {
        this.morningDb = morningDb;
        this.generatedPool = generateRomanticMorningPool();
        logger.info(`Romantic morning pool: ${this.generatedPool.length} generated lines ready`);
    }

    async discoverWishesMsgPages() {
        if (discoveredPageCache && Date.now() - discoveredPageCacheAt < PAGE_CACHE_TTL_MS) {
            return discoveredPageCache;
        }

        const pages = new Set(STATIC_PAGES);
        try {
            const resp = await axios.get(HUB_URL, { headers: HEADERS, timeout: 15000 });
            const $ = cheerio.load(resp.data);
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href') || '';
                if (
                    href.includes('wishesmsg.com') &&
                    href.includes('good-morning') &&
                    href.endsWith('/')
                ) {
                    pages.add(href.split('?')[0]);
                }
            });
        } catch (error) {
            logger.warn(`Morning hub discovery failed: ${error.message}`);
        }

        discoveredPageCache = [...pages];
        discoveredPageCacheAt = Date.now();
        logger.info(`Romantic morning scrape: ${discoveredPageCache.length} page(s) queued`);
        return discoveredPageCache;
    }

    async fetchRomanticPages() {
        const items = [];
        const pages = await this.discoverWishesMsgPages();

        for (const url of pages) {
            try {
                const resp = await axios.get(`${url}?t=${Date.now()}`, {
                    headers: HEADERS,
                    timeout: 15000,
                });
                const $ = cheerio.load(resp.data);
                $('article p, .entry-content p, .entry-content li, ol li, blockquote p').each(
                    (_, el) => {
                        const raw = normalizeText($(el).text());
                        if (isForGirlfriend(raw)) {
                            items.push(sanitizeMessage(raw));
                        }
                    }
                );
            } catch (error) {
                logger.warn(`Romantic morning scrape failed (${url}): ${error.message}`);
            }
        }

        return items;
    }

    async fetchAllCandidates() {
        const seen = new Set();
        const candidates = [];

        const add = (messages, source) => {
            for (const msg of messages) {
                const clean = sanitizeMessage(msg);
                if (!isForGirlfriend(clean)) {
                    continue;
                }
                const key = clean.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    candidates.push({ text: clean, source });
                }
            }
        };

        try {
            add(await this.fetchRomanticPages(), 'wishesmsg_romantic');
        } catch (error) {
            logger.warn(`Morning romantic scrape failed: ${error.message}`);
        }

        add(this.generatedPool, 'generated_romantic');

        logger.info(`Romantic morning candidates: ${candidates.length} unique message(s)`);
        return candidates;
    }

    async pickFreshMessage() {
        const sentHashes = new Set(await this.morningDb.getSentHashes());
        let candidates = (await this.fetchAllCandidates()).filter(
            (c) => !sentHashes.has(this.morningDb.hashMessage(c.text))
        );

        if (!candidates.length) {
            const removed = await this.morningDb.cleanupOld(RECYCLE_AFTER_DAYS);
            if (removed > 0) {
                logger.info(
                    `Morning messages: recycled ${removed} entries older than ${RECYCLE_AFTER_DAYS} days`
                );
            }
            const freshHashes = new Set(await this.morningDb.getSentHashes());
            candidates = (await this.fetchAllCandidates()).filter(
                (c) => !freshHashes.has(this.morningDb.hashMessage(c.text))
            );
        }

        if (!candidates.length) {
            return null;
        }

        return candidates[Math.floor(Math.random() * candidates.length)];
    }
}

export default MorningMessageScraper;
