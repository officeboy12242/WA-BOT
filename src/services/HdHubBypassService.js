/**
 * HDHub4u direct-link bypass service.
 *
 * Resolves intermediate pages returned by the movies API into DIRECT download links:
 *   - hubcdn.<tld>/file/ID  → reurl b64 → hubcdn.club/dl/?link=<R2 r2.dev URL>
 *   - hubcloud.<tld>/drive/ID → a#download → gamerxyt.com/hubcloud.php → final servers
 *   - hubdrive.<tld>/file/ID → hubcloud /drive page (same as above)
 *   - nexdrive.you/genxfmID → ad-lockered (fast-dl.one / vgmlinks) — best-effort only
 *
 * Final servers surfaced (per user request): R2 cloudflarestorage (presigned + r2.dev),
 * 10Gbps, FSLv2, FuckingFast. Telegram and PixelDrain mirrors are skipped.
 *
 * All links are resolved IN PARALLEL with a hard time budget so multi-link bypasses
 * never add meaningful latency to a search.
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Keep unknown-origin redirects from leaking our request beyond the target host
const DEFAULT_HEADERS = {
    'User-Agent': UA,
    Referer: 'https://new6.hdhub4u.cl/',
};

function hostOf(urlStr) {
    try {
        return new URL(urlStr).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function decodeB64(s) {
    try {
        return Buffer.from(String(s), 'base64').toString('utf-8');
    } catch {
        return '';
    }
}

/** Bump any known-moved host to its current TLD before fetching. */
function canonicalizeHost(urlStr) {
    return String(urlStr || '')
        .replace(/\/\/hubcdn\.(wiki|club)\//i, '//hubcdn.wiki/');
}

/** GET a page as text (axios). */
async function fetchPage(urlStr, { referer, timeoutMs } = {}) {
    const { data } = await axios.get(urlStr, {
        timeout: timeoutMs,
        maxRedirects: 5,
        maxContentLength: 3 * 1024 * 1024,
        headers: { ...DEFAULT_HEADERS, ...(referer ? { Referer: referer } : {}) },
        validateStatus: (s) => s >= 200 && s < 400,
    });
    return typeof data === 'string' ? data : String(data);
}

/** Server classification from the hubcloud.php page (order = user priority). */
const SERVER_PATTERNS = [
    { key: 'r2', re: /\.cloudflarestorage\.com/i, label: 'R2 ⚡' },
    { key: '10gbps', re: /gpdl\.hubcloud\.|10\s*gbps/i, label: '10Gbps ⚡' },
    { key: 'fslv2', re: /lenin\.buzz|fslv?2/i, label: 'FSLv2 ⚡' },
    { key: 'fuckingfast', re: /fuckingfast/i, label: 'FuckingFast' },
];

function classifyServer(urlStr, labelText = '') {
    const hay = `${urlStr} ${labelText}`;
    for (const p of SERVER_PATTERNS) {
        if (p.re.test(hay)) return p;
    }
    return null;
}

function dedupeLinks(links) {
    const seen = new Set();
    const out = [];
    for (const l of links) {
        const k = String(l.url).replace(/[?#].*$/, '');
        if (!seen.has(k)) {
            seen.add(k);
            out.push(l);
        }
    }
    return out;
}

/**
 * hubcloud.php page → [{ label, url, serverKey }] for R2/10Gbps/PixelDrain/FuckingFast.
 * (Telegram / Watch Online / login / ads are filtered out.)
 */
function extractServerLinks(html) {
    const out = [];
    const anchorRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
        const href = m[1];
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/t\.me|telegram|watch online|login|winexch|a-ads|snvhost|tinyurl|one\.one\.one|google\./i.test(`${href} ${text}`)) continue;
        if (/hubcloud\.[a-z.]+\/(drive|tg)\//i.test(href)) continue;
        const cls = classifyServer(href, text);
        if (!cls) continue;
        out.push({ label: cls.label, serverKey: cls.key, url: href });
    }
    return out;
}

/** hubcdn.wiki /file/ page → direct R2 r2.dev URL hidden in the reurl b64 param. */
async function bypassHubcdn(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    const m = html.match(/reurl\s*=\s*"([^"]+)"/i);
    if (!m) return [];
    const decoded = decodeB64(m[1]);
    // decoded: https://hubcdn.club/dl/?link=https%3A%2F%2Fpub-….r2.dev%2F<hex>
    const inner = decoded.match(/link=([^&]+)/i);
    const target = inner ? decodeURIComponent(inner[1]) : (decoded.startsWith('http') ? decoded : '');
    if (!target || !/^https?:\/\//i.test(target)) return [];
    return [{ label: 'R2 ⚡', serverKey: 'r2', url: target }];
}

/** hubcloud.ist /drive/ page → the gamerxyt.com hubcloud.php URL. */
async function hubcloudDriveToPhp(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    const dn = html.match(/<a[^>]+id="download"[^>]+href="([^"]+)"/i);
    if (!dn) return null;
    const href = dn[1];
    if (!/^https?:\/\//i.test(href)) {
        return new URL(href, urlStr).href;
    }
    return href;
}

/** hubdrive.pics /file/ page → hubcloud /drive/ URL (or direct server links). */
async function bypassHubdrive(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    const out = [];
    // Some hubdrive pages already embed server links directly
    out.push(...extractServerLinks(html));
    if (out.length) return out;

    const m = html.match(/href="(https?:\/\/[^"]*hubcloud[^"]*)"/i);
    if (m) {
        const php = await hubcloudDriveToPhp(m[1], timeoutMs);
        if (php) {
            const html2 = await fetchPage(php, { referer: m[1], timeoutMs });
            out.push(...extractServerLinks(html2));
        }
    }
    return out;
}

/** hubcloud.ist /drive/ → hubcloud.php → final servers (2 hops). */
async function bypassHubcloud(urlStr, timeoutMs) {
    const php = await hubcloudDriveToPhp(urlStr, timeoutMs);
    if (!php) return [];
    const html2 = await fetchPage(php, { referer: urlStr, timeoutMs });
    return extractServerLinks(html2);
}

/**
 * nexdrive.you pages are ad-lockered (fast-dl.one / vgmlinks). Best-effort:
 * only return a link when the page embeds one of our target servers directly.
 */
async function bypassNexdrive(urlStr, timeoutMs) {
    const html = await fetchPage(urlStr, { timeoutMs });
    return extractServerLinks(html);
}

/** Build a per-link timeout from the global budget. */
function perAttemptTimeout(budgetMs) {
    return Math.max(3_000, Math.min(9_000, Math.floor(budgetMs)));
}

/** True when the URL host is one of the HDHub-family file pages we can bypass. */
export function isBypassableUrl(urlStr) {
    const host = hostOf(String(urlStr || ''));
    return /(^|\.)(hubcloud|hubdrive|hubcdn|hubstream|hdhubdrive|driveseed|hdstream4u|nexdrive)\.[a-z.]+$/i.test(host);
}

/** Resolve ONE intermediate link to direct server links. Never throws. */
async function resolveLink(rawUrl, budgetMs) {
    const urlStr = canonicalizeHost(String(rawUrl || ''));
    if (!/^https?:\/\//i.test(urlStr)) return [];
    const timeoutMs = perAttemptTimeout(budgetMs);
    const host = hostOf(urlStr);

    try {
        if (/hubcdn\./i.test(host)) return await bypassHubcdn(urlStr, timeoutMs);
        if (/hubdrive\.|hdstream4u\./i.test(host)) return await bypassHubdrive(urlStr, timeoutMs);
        if (/hubcloud\.|hubstream\.|driveseed\./i.test(host)) return await bypassHubcloud(urlStr, timeoutMs);
        if (/nexdrive\./i.test(host)) return await bypassNexdrive(urlStr, timeoutMs);
        // Unknown host → maybe it's already one of our final servers
        const cls = classifyServer(urlStr);
        return cls ? [{ label: cls.label, serverKey: cls.key, url: urlStr }] : [];
    } catch (err) {
        logger.warn(`[HdHubBypass] ${host} resolve failed: ${err?.message || err}`);
        return [];
    }
}

/**
 * Resolve many intermediate links at once (parallel) under a shared time budget.
 * @param {string[]} urls intermediate links from API results
 * @param {object} opts
 * @param {number} [opts.budgetMs] total wall-clock budget for the whole batch
 * @param {number} [opts.maxLinks] cap on how many links to resolve
 * @returns {Promise<Map<string, {label:string, url:string}[]>>} url → direct links
 */
export async function resolveManyLinks(urls, { budgetMs = 12_000, maxLinks = 8 } = {}) {
    const seen = new Set();
    const all = [];
    for (const u of urls || []) {
        const s = String(u);
        if (!/^https?:\/\//i.test(s) || seen.has(s)) continue;
        seen.add(s);
        all.push(s);
    }
    // Resolve real file pages first; ad-lockered nexdrive pages last (best-effort)
    const rank = (u) => (/nexdrive\./i.test(hostOf(u)) ? 1 : 0);
    const list = all.sort((a, b) => rank(a) - rank(b)).slice(0, maxLinks);
    if (!list.length) return new Map();

    const started = Date.now();
    const entries = list.map((u) => ({
        url: u,
        promise: Promise.race([
            resolveLink(u, budgetMs),
            new Promise((resolve) => setTimeout(() => resolve([]), budgetMs + 1_000)),
        ]),
    }));

    const settled = await Promise.allSettled(entries.map((e) => e.promise));
    const map = new Map();
    for (let i = 0; i < entries.length; i++) {
        const direct = settled[i].status === 'fulfilled' ? settled[i].value : [];
        if (direct.length) {
            map.set(entries[i].url, dedupeLinks(direct));
        }
    }

    logger.info(`[HdHubBypass] ${map.size}/${list.length} link(s) resolved in ${Date.now() - started}ms`);
    return map;
}

/**
 * Rewrite one result's links: attach direct server links to each quality entry,
 * keep unresolved links (other sources' mirrors, telegram, pages) untouched.
 * @param {object} result { title, source, links }
 * @param {Map<string, {label,url}[]>} resolvedMap
 */
export function applyResolvedLinks(result, resolvedMap) {
    if (!result || !resolvedMap?.size || !Array.isArray(result.links)) return result;

    const out = [];
    for (const link of result.links) {
        const direct = resolvedMap.get(String(link.url || ''));
        if (direct?.length) {
            for (const d of direct) {
                out.push({
                    ...link,
                    label: d.label,
                    url: d.url,
                    // keep size/quality/audio from the quality entry
                });
            }
        } else {
            out.push(link);
        }
    }
    return { ...result, links: out };
}

/** True if any link in the result is bypassable by this service. */
export function hasBypassableLinks(result) {
    return Array.isArray(result?.links) && result.links.some((l) => isBypassableUrl(String(l?.url || '')));
}


// Labels produced by the bypass for direct server links
const SERVER_LABEL_RE = /(R2|10Gbps|FSLv2|FuckingFast)/i;

/**
 * Cap an enriched link list for WhatsApp: at most 2 direct servers per quality,
 * dedupe exact URLs, cap total per result (servers win over mirrors).
 */
function trimEnrichedLinks(links, { maxPerResult = 14, maxServersPerQuality = 2 } = {}) {
    const seen = new Set();
    const out = [];
    let runCount = 0; // consecutive server links for the current quality entry

    for (const link of links) {
        const key = String(link?.url || '');
        if (!key || seen.has(key)) continue;
        const isServer = SERVER_LABEL_RE.test(String(link?.label || ''));

        if (isServer) {
            runCount += 1;
            if (runCount > maxServersPerQuality) continue;
        } else {
            runCount = 0;
        }

        seen.add(key);
        out.push(link);
    }

    if (out.length <= maxPerResult) return out;

    // Over cap: keep all direct server links first, then mirrors in original order
    const servers = out.filter((l) => SERVER_LABEL_RE.test(String(l?.label || '')));
    const mirrors = out.filter((l) => !SERVER_LABEL_RE.test(String(l?.label || '')));
    return [...servers.slice(0, maxPerResult), ...mirrors].slice(0, maxPerResult);
}

/**
 * Enrich ANY set of grouped results (HDHub API rows, ProNooB Drive vault rows, ...)
 * by resolving bypassable intermediate links in ONE parallel batch under budgetMs.
 * Non-bypassable results/links pass through untouched. Never throws.
 * @param {Array<{title:string, source?:string, links:Array<{url:string}>}>} results
 * @param {number} budgetMs wall-clock budget for the whole batch
 */
export async function enrichResultsWithDirectLinks(results, budgetMs = 8_000) {
    try {
        if (config.MOVIE_HD_BYPASS_ENABLED === false) return results;
        if (!budgetMs || budgetMs < 4_000) return results;
        if (!Array.isArray(results) || !results.length) return results;

        const maxLinks = config.MOVIE_HD_BYPASS_MAX_LINKS || 10;
        const candidates = [];
        for (const r of results) {
            for (const l of r?.links || []) {
                const u = String(l?.url || '');
                if (isBypassableUrl(u)) candidates.push(u);
            }
        }
        if (!candidates.length) return results;

        const started = Date.now();
        const resolvedMap = await resolveManyLinks(candidates, { budgetMs, maxLinks });
        if (!resolvedMap.size) return results;

        let touched = false;
        const enriched = results.map((r) => {
            const urls = (r?.links || []).map((l) => String(l?.url || ''));
            if (!urls.some((u) => resolvedMap.has(u))) return r;
            touched = true;
            const withDirect = applyResolvedLinks(r, resolvedMap);
            return { ...withDirect, links: trimEnrichedLinks(withDirect.links) };
        });

        logger.info(
            `[HdHubBypass] enriched ${resolvedMap.size} link(s) across ${enriched.length} result(s)`
            + ` in ${Date.now() - started}ms`,
        );
        return touched ? enriched : results;
    } catch (err) {
        logger.warn(`[HdHubBypass] enrich failed (non-fatal): ${err?.message || err}`);
        return results;
    }
}

export const hdHubBypassService = { resolveManyLinks, applyResolvedLinks, enrichResultsWithDirectLinks, hasBypassableLinks };
export default hdHubBypassService;
