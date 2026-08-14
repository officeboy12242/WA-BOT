/**
 * Price Tracker — search a product across Indian e-commerce sites and rank the
 * cheapest offers with links, plus past price history.
 *
 * Sources (all plain-HTTP, no browser):
 *   - Amazon.in  — product page via mobile UA (desktop UA gets a bot wall)
 *   - Flipkart   — search page embeds a JSON state blob
 *   - Myntra     — search page embeds a JSON state blob
 *   - Ajio       — search page embeds product JSON
 *   - Snapdeal   — server-rendered product tiles
 *   - pricehistory.app — past Amazon price history (lowest/avg/highest/current)
 *
 * Every fetch is best-effort with a timeout; one dead site never blocks the
 * rest. Parsers are exported separately so the test suite can run them on
 * fixtures with zero network.
 */

import { logger } from '../utils/logger.js';

const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MOBILE_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const DEFAULT_TIMEOUT_MS = 12_000;

/** Fetch with timeout; returns { status, text } or throws on network error. */
async function fetchText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': DESKTOP_UA, ...headers },
            redirect: 'follow',
            signal: ctrl.signal,
            method,
            body,
        });
        const text = await res.text();
        return { status: res.status, text, finalUrl: res.url };
    } finally {
        clearTimeout(timer);
    }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** @param {string} input @returns {string|null} Amazon ASIN like B0BSLKJPXV */
export function extractAmazonAsin(input) {
    if (!input) return null;
    const m = String(input).match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$|\?)/i)
        || String(input).match(/\b(B0[A-Z0-9]{8})\b/);
    return m ? m[1].toUpperCase() : null;
}

export function cleanPrice(raw) {
    if (raw == null) return null;
    // "₹1,573.00", "1573.00", "4,499" — strip currency/commas/whitespace, keep
    // the decimal so a trailing ".00" does not become two extra zeros.
    const cleaned = String(raw).replace(/[₹,\s]/g, '').trim();
    const n = parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Shorten a product title to ~70 chars for the card. */
export function shortTitle(title, max = 70) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Dedupe a brand prefix that already appears in the product name ("Puma Puma"). */
export function dedupeBrand(brand, name) {
    const b = String(brand || '').trim();
    const n = String(name || '').trim();
    if (!b || !n) return [b, n].filter(Boolean).join(' ').trim();
    if (n.toLowerCase().startsWith(b.toLowerCase())) return n;
    return `${b} ${n}`;
}

/** Words too generic to prove a product match (drop from scoring). */
const GENERIC_WORDS = new Set([
    'sneaker', 'sneakers', 'shoe', 'shoes', 'casual', 'comfort', 'comfortable',
    'sports', 'sport', 'running', 'walking', 'lifestyle', 'fashion', 'men',
    'men\'s', 'women', 'women\'s', 'kids', 'unisex', 'slip', 'flip', 'flops',
    'sandals', 'slippers', 'online', 'price', 'best', 'buy', 'new', 'for',
    'with', 'and', 'the', 'white', 'black', 'blue', 'green', 'grey', 'matte',
    'silver', 'gold', 'red', 'color', 'multicolor', 'pair', 'size', 'man',
]);

/**
 * Distinctive tokens: query words minus generic descriptors. Used to decide
 * whether an offer is actually the same product the user asked about.
 */
export function distinctiveTokens(query) {
    const words = String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9'-]+/)
        .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
        .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
    const tokens = new Set(words);
    // Emit hyphenated compounds AND their parts: "camp-glacier" is a much
    // stronger model signal than "camp" or "glacier" alone, but a store that
    // writes "Camp Glacier" (space) can still match on the parts.
    for (const w of words) {
        if (!w.includes('-')) continue;
        for (const part of w.split('-')) {
            if (part.length > 2 && !GENERIC_WORDS.has(part)) tokens.add(part);
        }
    }
    return [...tokens];
}

/**
 * Naive relevance: the query's DISTINCTIVE tokens should mostly appear. An
 * unrelated cheap product (different brand, no model word) scores ~0 even if
 * it shares "sneakers" with the query.
 */
export function relevanceScore(title, query) {
    const t = String(title || '').toLowerCase();
    const q = distinctiveTokens(query);
    if (!q.length) return 1;
    const hits = q.filter((w) => t.includes(w)).length;
    return hits / q.length;
}

/* ─────────────────────────── Amazon.in ─────────────────────────── */

/**
 * Parse an Amazon.in product page (mobile HTML). Extracts title, current price,
 * MRP, image, rating and availability — all best-effort.
 */
export function parseAmazonProduct(html) {
    const out = { title: null, price: null, mrp: null, image: null, rating: null, availability: null };
    if (!html) return out;

    const jsonTitle = html.match(/"title"\s*:\s*"([^"]{8,160})"/);
    const ogTitle = html.match(/<meta name="title" content="Buy ([^"]+?)(?:\s*\|| at Amazon)/);
    const h1 = html.match(/<span id="productTitle"[^>]*>\s*([^<]+?)\s*<\/span>/);
    out.title = (jsonTitle && jsonTitle[1])
        || (ogTitle && ogTitle[1].trim())
        || (h1 && h1[1].trim())
        || null;
    if (out.title) out.title = out.title.replace(/\s+/g, ' ').trim();

    // Mobile pages carry priceAmount as a JSON number (1573.00)
    const priceAmount = html.match(/"priceAmount"\s*:\s*(\d+(?:\.\d+)?)/);
    const displayPrice = html.match(/"displayPrice"\s*:\s*"([^"]+)"/);
    out.price = cleanPrice(priceAmount && priceAmount[1]) || cleanPrice(displayPrice && displayPrice[1]);

    // The M.R.P. block is the reliable MRP marker on mobile pages; the generic
    // a-text-price spans also show deal savings, so anchor on the label first.
    const mrpLabel = html.match(/M\.R\.P\.:[\s\S]{0,300}?₹([\d,]+)/);
    const mrpJson = html.match(/"listPriceAmount"\s*:\s*(\d+(?:\.\d+)?)/)
        || html.match(/"wasPrice"\s*:\s*(\d+)/);
    const strikePrice = html.match(/class="a-price a-text-price apex-basisprice-value"[^>]*>[\s\S]{0,300}?₹([\d,]+)/)
        || html.match(/class="a-price a-text-price"[^>]*>[\s\S]{0,200}?₹([\d,]+)/);
    out.mrp = cleanPrice(mrpLabel && mrpLabel[1])
        || cleanPrice(mrpJson && mrpJson[1])
        || cleanPrice(strikePrice && strikePrice[1]);

    const img = html.match(/id="landingImage"[^>]*src="([^"]+)"/)
        || html.match(/"landingImageUrl"\s*:\s*"([^"]+)"/)
        || html.match(/"hiResImageUrl"\s*:\s*"([^"]+)"/)
        || html.match(/<meta property="og:image" content="([^"]+)"/);
    if (img && img[1] && !img[1].includes('data:image')) out.image = img[1];

    const rating = html.match(/"ratingValue"\s*:\s*"([\d.]+)"/)
        || html.match(/id="acrPopover"[^>]*title="([\d.]+)"/);
    out.rating = rating ? parseFloat(rating[1]) : null;

    const avail = html.match(/id="availability"[^>]*>[\s\S]{0,300}?<span[^>]*>\s*([^<]+?)\s*<\/span>/);
    out.availability = avail ? avail[1].trim() : null;

    return out;
}

/** Fetch an Amazon.in product page by ASIN (mobile UA dodges the desktop wall). */
export async function fetchAmazonProduct(asin, { timeoutMs } = {}) {
    const { status, text } = await fetchText(`https://www.amazon.in/dp/${asin}`, {
        headers: {
            'User-Agent': MOBILE_UA,
            'Accept-Language': 'en-IN,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeoutMs,
    });
    if (status !== 200) {
        throw new Error(`Amazon returned HTTP ${status}`);
    }
    const parsed = parseAmazonProduct(text);
    if (!parsed.title && !parsed.price) {
        // A 200 from a bot-wall page has neither — treat as blocked.
        throw new Error('Amazon page blocked or unavailable');
    }
    return { ...parsed, asin, url: `https://www.amazon.in/dp/${asin}` };
}

/* ─────────────────────────── Flipkart ─────────────────────────── */

/** @returns {string|null} A Flipkart product or short-link URL inside input. */
export function extractFlipkartUrl(input) {
    const m = String(input || '').match(/https?:\/\/(?:www\.|dl\.)?flipkart\.com\/[^\s"'<>]+/i);
    return m ? m[0].replace(/[),;]+$/, '') : null;
}

/**
 * Flipkart product URLs carry heavy tracking params (fm/lid/_refId/…) that
 * break pricehistory.app's lookup. Keep only the canonical pid and path.
 */
export function sanitizeFlipkartUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        const pid = u.searchParams.get('pid');
        if (pid) u.search = `pid=${pid}`;
        else u.search = '';
        return u.href;
    } catch {
        return String(url || '');
    }
}

/** Flipkart product id (pid) from a product URL, if present. */
export function extractFlipkartPid(url) {
    if (!url) return null;
    try {
        return new URL(url).searchParams.get('pid');
    } catch {
        return null;
    }
}

/**
 * Resolve a Flipkart URL to its pid. Full product URLs carry the pid already;
 * dl.flipkart.com/s/… short links need a redirect follow to reveal it.
 */
export async function resolveFlipkartPid(url, { timeoutMs } = {}) {
    const direct = extractFlipkartPid(url);
    if (direct) return direct;
    try {
        const { finalUrl } = await fetchText(url, {
            headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' },
            timeoutMs: timeoutMs || 10_000,
        });
        return extractFlipkartPid(sanitizeFlipkartUrl(finalUrl));
    } catch {
        return null;
    }
}

/**
 * Parse a Flipkart product page (mobile HTML). The schema.org data lives in
 * the JS state blob with escaped \u002f slashes: name, price+currency,
 * aggregateRating and availability, plus finalPrice/mrp in the price block.
 */
export function parseFlipkartProduct(html) {
    const out = { title: null, price: null, mrp: null, rating: null, availability: null };
    if (!html) return out;

    const name = html.match(/"name"\s*:\s*"([^"]{8,160})"/);
    if (name) out.title = name[1].replace(/\\u002f/g, '/').replace(/\s+/g, ' ').trim();

    // Price sits next to the INR currency marker in the schema block.
    const price = html.match(/"price"\s*:\s*(\d+(?:\.\d+)?)[^}]{0,80}?"priceCurrency"\s*:\s*"INR"/)
        || html.match(/"priceCurrency"\s*:\s*"INR"[^}]{0,80}?"price"\s*:\s*(\d+(?:\.\d+)?)/);
    out.price = cleanPrice(price && price[1]);

    // MRP from the pricing state blob (finalPrice/mrp/nepPrice group).
    const mrp = html.match(/"mrp"\s*:\s*(\d+)/);
    out.mrp = cleanPrice(mrp && mrp[1]);

    // Anchor on the aggregateRating block — bare "ratingValue":1 markers
    // (e.g. in review data) would otherwise win.
    const rating = html.match(/"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*([\d.]+)/);
    out.rating = rating ? parseFloat(rating[1]) : null;

    const avail = html.match(/"availability"\s*:\s*"([^"]+)"/);
    const availText = avail ? avail[1].replace(/\\u002f/g, '/') : '';
    out.availability = availText.includes('InStock') ? 'In Stock' : null;

    return out;
}

/**
 * Fetch a Flipkart product page by URL. Short links (dl.flipkart.com/s/…) are
 * followed to the real product page; the returned URL is the clean canonical
 * form (path + pid only) which also works for pricehistory.app.
 */
export async function fetchFlipkartProduct(url, { timeoutMs } = {}) {
    const { status, text, finalUrl } = await fetchText(url, {
        headers: {
            'User-Agent': MOBILE_UA,
            'Accept-Language': 'en-IN,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeoutMs,
    });
    if (status !== 200) {
        throw new Error(`Flipkart returned HTTP ${status}`);
    }
    const parsed = parseFlipkartProduct(text);
    if (!parsed.title && !parsed.price) {
        throw new Error('Flipkart page blocked or unavailable');
    }
    const cleanUrl = sanitizeFlipkartUrl(finalUrl || url);
    return { ...parsed, pid: extractFlipkartPid(cleanUrl), url: cleanUrl };
}

/**
 * Parse Flipkart search results. The page embeds a JSON state blob with
 * "titles" and "pricing" objects; we harvest product id, title, price and
 * build a product URL from the first itm link seen.
 */
export function parseFlipkartSearch(html) {
    const results = [];
    if (!html) return results;

    // Map pid -> real product href from the page (the itm links carry the slug).
    const hrefByPid = new Map();
    const hrefRe = /href="(\/[^"]*?\/p\/itm[a-zA-Z0-9]+[^"]*?pid=([A-Z0-9]{10,})[^"]*)"/g;
    let hm;
    while ((hm = hrefRe.exec(html)) !== null) {
        if (!hrefByPid.has(hm[2])) hrefByPid.set(hm[2], hm[1].replace(/&amp;/g, '&'));
    }

    const pidRe = /"id"\s*:\s*"([A-Z0-9]{10,})"/g;
    let m;
    const seen = new Set();
    while ((m = pidRe.exec(html)) !== null) {
        const pid = m[1];
        if (seen.has(pid)) continue;
        seen.add(pid);
        // Titles/pricing come AFTER the id in the JSON blob — scan forward only
        // so a compact fixture (or adjacent product) cannot bleed in.
        const chunk = html.slice(m.index, m.index + 2500);

        const superTitle = chunk.match(/"superTitle"\s*:\s*"([^"]+)"/);
        const title = chunk.match(/"title"\s*:\s*"([^"]+)"/);
        const fullTitle = [superTitle && superTitle[1], title && title[1]]
            .filter(Boolean)
            .join(' ')
            .trim();

        // Prefer Special Price (the real selling price) over the struck MRP.
        let price = null;
        const special = chunk.match(/"name"\s*:\s*"Special Price"[\s\S]{0,400}?"value"\s*:\s*(\d+)/);
        if (special) price = cleanPrice(special[1]);
        if (!price) {
            const selling = chunk.match(/"name"\s*:\s*"Selling Price"[\s\S]{0,400}?"value"\s*:\s*(\d+)/);
            if (selling) price = cleanPrice(selling[1]);
        }
        if (!price) {
            const plain = chunk.match(/"value"\s*:\s*(\d{3,7})/);
            if (plain) price = cleanPrice(plain[1]);
        }

        if (!fullTitle || !price) continue;

        // Prefer the real href from the page (it carries the correct slug + pid);
        // fall back to a pid-only URL. Trim the long tracking params so the
        // link stays readable in the card.
        const realHref = hrefByPid.get(pid);
        let url = realHref
            ? `https://www.flipkart.com${realHref}`
            : `https://www.flipkart.com/product/p?pid=${pid}`;
        url = url.replace(/&(?:marketplace|q|store|srno|otracker|fm|iid|ppt|ppn|ssid|qH|ov_redirect|lid)=[^&]*/g, '');

        const rating = chunk.match(/"rating"\s*:\s*([\d.]+)/);
        results.push({
            title: shortTitle(fullTitle),
            price,
            url,
            site: 'Flipkart',
            rating: rating ? parseFloat(rating[1]) : null,
        });
        if (results.length >= 8) break;
    }
    return results;
}

/* ─────────────────────────── Amazon search ─────────────────────────── */

/**
 * Parse Amazon.in search results (mobile HTML). Each result sits in a
 * data-asin block carrying an alt-title and an a-price-whole price.
 */
export function parseAmazonSearch(html) {
    const results = [];
    if (!html) return results;

    const blocks = html.split('data-asin="');
    const seen = new Set();
    for (let i = 1; i < blocks.length && results.length < 8; i++) {
        const b = blocks[i];
        const asin = b.slice(0, 12).match(/^([A-Z0-9]{10})/);
        const title = b.match(/alt="([^"]{15,160})"/) || b.match(/"title":"([^"]{15,160})"/);
        const price = b.match(/a-price-whole[^>]*>\s*([\d,]+)/) || b.match(/"priceAmount"\s*:\s*(\d+)/);
        if (!asin || !title || !price) continue;
        const p = cleanPrice(price[1]);
        if (!p) continue;
        if (seen.has(asin[1])) continue;
        seen.add(asin[1]);
        results.push({
            title: shortTitle(title[1]),
            price: p,
            url: `https://www.amazon.in/dp/${asin[1]}`,
            site: 'Amazon',
        });
    }
    return results;
}

export async function searchAmazon(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(`https://www.amazon.in/s?k=${encodeURIComponent(query)}`, {
        headers: {
            'User-Agent': MOBILE_UA,
            'Accept-Language': 'en-IN,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeoutMs,
    });
    if (status !== 200) throw new Error(`Amazon search returned HTTP ${status}`);
    return parseAmazonSearch(text);
}

export async function searchFlipkart(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(
        `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`,
        { timeoutMs }
    );
    if (status !== 200) throw new Error(`Flipkart returned HTTP ${status}`);
    return parseFlipkartSearch(text);
}

/* ─────────────────────────── Myntra ─────────────────────────── */

/**
 * Parse Myntra search results from the embedded JSON state. Field order varies
 * between pages (landingPageUrl sits before productName, price after), so each
 * productName anchors a window we scan for the brand / price / url living in
 * the same product object.
 */
export function parseMyntraSearch(html) {
    const results = [];
    if (!html) return results;

    const nameRe = /"productName"\s*:\s*"([^"]+)"/g;
    let m;
    const seen = new Set();
    while ((m = nameRe.exec(html)) !== null) {
        // price sits a couple KB after productName on Myntra's page — take a
        // generous forward window but stop at the first price seen.
        const chunk = html.slice(Math.max(0, m.index - 1200), m.index + 4500);
        const brand = chunk.match(/"brand"\s*:\s*"([^"]+)"/);
        const priceMatch = chunk.match(/"price"\s*:\s*(\d+)/);
        if (!priceMatch) continue;
        const price = cleanPrice(priceMatch[1]);
        if (!price) continue;
        let url = (chunk.match(/"landingPageUrl"\s*:\s*"([^"]+)"/) || [])[1] || '';
        url = url.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&');
        if (!url.startsWith('http')) url = `https://www.myntra.com/${url.replace(/^\//, '')}`;
        const title = dedupeBrand(brand && brand[1], m[1]);
        const key = `${title}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: shortTitle(title), price, url, site: 'Myntra' });
        if (results.length >= 8) break;
    }
    return results;
}

export async function searchMyntra(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(
        `https://www.myntra.com/${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'en-IN,en;q=0.9' }, timeoutMs }
    );
    if (status !== 200) throw new Error(`Myntra returned HTTP ${status}`);
    return parseMyntraSearch(text);
}

/* ─────────────────────────── Ajio ─────────────────────────── */

/** Parse Ajio search results — product JSON with name / price / url. */
export function parseAjioSearch(html) {
    const results = [];
    if (!html) return results;

    // Each product object begins with a "name", then a "/.../p/..." url and a
    // price object with "value". Anchor on "name" and scan FORWARD only, so the
    // window never bleeds into the previous product's fields.
    const nameRe = /"name"\s*:\s*"([^"]{6,140})"/g;
    let m;
    const seen = new Set();
    while ((m = nameRe.exec(html)) !== null) {
        const chunk = html.slice(m.index, m.index + 2500);
        const urlMatch = chunk.match(/"url"\s*:\s*"([^"]*\/p\/[^"]+)"/);
        const value = chunk.match(/"value"\s*:\s*(\d+)/);
        if (!urlMatch || !value) continue;
        const price = cleanPrice(value[1]);
        if (!price) continue;
        const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `https://www.ajio.com${urlMatch[1]}`;
        const key = `${m[1]}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: shortTitle(m[1]), price, url, site: 'Ajio' });
        if (results.length >= 8) break;
    }
    return results;
}

export async function searchAjio(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(
        `https://www.ajio.com/search/?text=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-IN,en;q=0.9' }, timeoutMs }
    );
    if (status !== 200) throw new Error(`Ajio returned HTTP ${status}`);
    return parseAjioSearch(text);
}

/* ─────────────────────────── Snapdeal ─────────────────────────── */

/** Parse Snapdeal search tiles (server-rendered). */
export function parseSnapdealSearch(html) {
    const results = [];
    if (!html) return results;

    // Product cards carry data-price and a product link + title nearby.
    // Snapdeal tiles: <a class="dp-widget-link" href=".../product/..."> <p
    // class="product-title">Name</p> ... <span ... data-price="290">Rs. 290</span>
    // The title and link sit BEFORE the price marker in each card, so scan a
    // backward window from each data-price.
    const priceRe = /data-price\s*=\s*"(\d+)"/g;
    let m;
    const seen = new Set();
    while ((m = priceRe.exec(html)) !== null) {
        const price = cleanPrice(m[1]);
        if (!price) continue;
        const before = html.slice(Math.max(0, m.index - 1400), m.index);
        const link = before.match(/href="(https:\/\/www\.snapdeal\.com\/product\/[^"]+)"/);
        const titleMatch = before.match(/class="product-title[^"]*"[^>]*>\s*([^<]{8,120})/)
            || before.match(/title="([^"]{8,120})"/);
        const title = (titleMatch && (titleMatch[1] || titleMatch[2])) || null;
        if (!title || !link) continue;
        const key = `${title}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: shortTitle(title), price, url: link[1], site: 'Snapdeal' });
        if (results.length >= 8) break;
    }
    return results;
}

export async function searchSnapdeal(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(
        `https://www.snapdeal.com/search?keyword=${encodeURIComponent(query)}`,
        { timeoutMs }
    );
    if (status !== 200) throw new Error(`Snapdeal returned HTTP ${status}`);
    return parseSnapdealSearch(text);
}

/* ─────────────────────────── Tata CLiQ ─────────────────────────── */

/**
 * Parse Tata CLiQ search results — the page carries a schema.org ItemList
 * JSON-LD block with name / url / brand / price per product.
 */
export function parseTataCliqSearch(html) {
    const results = [];
    if (!html) return results;

    const listRe = /"@type"\s*:\s*"ItemList"[\s\S]*?\]<\/script>/;
    const listBlock = html.match(listRe);
    const source = (listBlock && listBlock[0]) || html;

    const itemRe = /\{"@type"\s*:\s*"ListItem"\s*,\s*"name"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"([^"]+)"[\s\S]{0,600}?"price"\s*:\s*([\d.]+)/g;
    let m;
    const seen = new Set();
    while ((m = itemRe.exec(source)) !== null) {
        const title = m[1];
        const urlPath = m[2];
        const price = cleanPrice(m[3]);
        if (!title || !price || !urlPath) continue;
        const url = urlPath.startsWith('http') ? urlPath : `https://www.tatacliq.com${urlPath}`;
        const key = `${title}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: shortTitle(title), price, url, site: 'Tata CLiQ' });
        if (results.length >= 8) break;
    }
    return results;
}

export async function searchTataCliq(query, { timeoutMs } = {}) {
    const { status, text } = await fetchText(
        `https://www.tatacliq.com/search/?searchCategory=all&text=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-IN,en;q=0.9' }, timeoutMs }
    );
    if (status !== 200) throw new Error(`Tata CLiQ returned HTTP ${status}`);
    return parseTataCliqSearch(text);
}

/* ─────────────────────────── pricehistory.app ─────────────────────────── */

/**
 * Past price history for an Amazon ASIN via pricehistory.app's free lookup.
 * Returns { title, lowest, average, highest, mrp, current, currentDate, url }.
 */
export function parsePriceHistoryMeta(html) {
    const out = {};
    if (!html) return out;
    const desc = html.match(/<meta name="description" content="([^"]+)"/);
    if (!desc) return out;
    const text = desc[1];

    const lowest = text.match(/Lowest Price:\s*₹([\d,]+)/i);
    const average = text.match(/Average Price:\s*₹([\d,]+)/i);
    const highest = text.match(/Highest Price:\s*₹([\d,]+)/i);
    const mrp = text.match(/MRP:\s*₹([\d,]+)/i);
    // Store-agnostic: "Amazon Price in India on …", "Flipkart Price in India on …"
    const current = text.match(/(?:Amazon|Flipkart|Myntra|Ajio|Snapdeal|Tata\s?CLiQ) Price in India on ([\d/]+):\s*₹([\d,]+)/i);
    if (lowest) out.lowest = cleanPrice(lowest[1]);
    if (average) out.average = cleanPrice(average[1]);
    if (highest) out.highest = cleanPrice(highest[1]);
    if (mrp) out.mrp = cleanPrice(mrp[1]);
    if (current) {
        out.current = cleanPrice(current[2]);
        out.currentDate = current[1];
    }
    return out;
}

/**
 * Past price history for a product URL (Amazon ASIN or a supported store link
 * like Flipkart's clean product URL / dl short link) via pricehistory.app.
 * Returns { title, lowest, average, highest, mrp, current, currentDate, url }.
 */
export async function fetchPriceHistory(urlOrAsin, { timeoutMs = 15_000 } = {}) {
    // Accept an Amazon ASIN for back-compat; otherwise use the URL as-is.
    const productUrl = /^https?:/i.test(String(urlOrAsin))
        ? urlOrAsin
        : `https://www.amazon.in/dp/${urlOrAsin}`;
    // Step 1: search API resolves a URL to a product code. The endpoint wants
    // browser-like headers (Origin/Referer/X-Requested-With) or it serves HTML,
    // and it is flaky — retry a couple of times before giving up.
    const searchHeaders = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: 'https://pricehistory.app',
        Referer: 'https://pricehistory.app/',
    };
    let code = null;
    let name = null;
    for (let attempt = 0; attempt < 3 && !code; attempt++) {
        // No-www — the www host serves the SPA shell instead of JSON.
        const search = await fetchText('https://pricehistory.app/api/search', {
            method: 'POST',
            headers: searchHeaders,
            body: JSON.stringify({ url: productUrl }),
            timeoutMs,
        });
        try {
            const j = JSON.parse(search.text);
            if (j && j.status) {
                code = j.code;
                name = j.name;
            }
        } catch {
            // not JSON — probably the HTML shell; retry
        }
        if (!code) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!code) return null;

    // Step 2: the product page's meta description carries the history stats.
    // The www host serves the SPA shell — only the no-www host returns the full
    // server-rendered page, so use it directly (no redirect).
    let meta = {};
    for (let attempt = 0; attempt < 3 && !Object.keys(meta).length; attempt++) {
        const page = await fetchText(`https://pricehistory.app/p/${code}`, { timeoutMs });
        meta = parsePriceHistoryMeta(page.text);
        if (!Object.keys(meta).length) {
            await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
    }
    if (!Object.keys(meta).length) return null;

    return { ...meta, code, name: name || code, url: `https://pricehistory.app/p/${code}` };
}

/* ─────────────────────────── orchestration ─────────────────────────── */

/** Canonical URL key — strip tracking params so the same product fetched from
 * the product page and again via search collapses to one offer. */
export function normalizeOfferUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.href.replace(/\/+$/, '').toLowerCase();
    } catch {
        return String(url).split('?')[0].replace(/\/+$/, '').toLowerCase();
    }
}

/** Drop duplicate offers (same store + canonical URL), keeping the first. */
export function dedupeOffers(offers) {
    const seen = new Set();
    const out = [];
    for (const o of offers) {
        const key = `${o.site}::${normalizeOfferUrl(o.url)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
    }
    return out;
}

/** Make an Amazon title usable as a search query — drop the " | " separators. */
export function searchQueryOf(titleOrInput) {
    return String(titleOrInput || '').replace(/\s*\|\s*/g, ' ').trim();
}

/** Sort offers cheapest-first; keep a sensible cap per site. */
export function rankOffers(offers, { maxPerSite = 3, maxTotal = 8 } = {}) {
    const perSite = new Map();
    const kept = [];
    for (const o of [...offers].sort((a, b) => (a.price || Infinity) - (b.price || Infinity))) {
        const n = perSite.get(o.site) || 0;
        if (n >= maxPerSite) continue;
        perSite.set(o.site, n + 1);
        kept.push(o);
        if (kept.length >= maxTotal) break;
    }
    return kept;
}

/**
 * Drop offers whose title shares no distinctive word with the query — stores
 * like Snapdeal return loosely-related cheap products that would otherwise top
 * the "cheapest" ranking with garbage. A single distinctive token match is
 * enough (e.g. "smashic" on Myntra), but generic words never count.
 */
export function filterRelevant(offers, query, minScore = 0.5) {
    const q = distinctiveTokens(query);
    if (!q.length) {
        // No distinctive tokens (e.g. a bare "sneakers" query) — fall back to
        // raw overlap so the command still returns something.
        return offers.filter((o) => relevanceScore(o.title, q) >= 0.3);
    }
    const nonBrand = q.filter((w) => !BRAND_WORDS.has(w));
    // A brand + generic-words query ("puma sneakers") can't narrow further —
    // keep anything sharing ≥1 token.
    if (!nonBrand.length) {
        return offers.filter((o) => relevanceScore(o.title, q) >= 0.3);
    }
    // Exact-product queries (brand + model) must match the most specific
    // (longest) non-brand token — the model word — so lookalikes that share
    // only the brand or a weak token never win the ranking.
    const modelToken = nonBrand.reduce((a, b) => (b.length > a.length ? b : a));
    return offers.filter((o) => {
        const t = String(o.title || '').toLowerCase();
        const hits = q.filter((w) => t.includes(w)).length;
        return hits / q.length >= minScore && t.includes(modelToken);
    });
}

/** Brand names are weak evidence — a "puma" match says nothing about model. */
const BRAND_WORDS = new Set([
    'puma', 'nike', 'adidas', 'reebok', 'fila', 'asics', 'skechers', 'crocs',
    'levis', 'wrangler', 'zara', 'uniqlo', 'h&m', 'hm', 'gucci', 'prada',
    'boat', 'samsung', 'sony', 'xiaomi', 'redmi', 'poco', 'realme', 'oppo',
    'vivo', 'iqoo', 'oneplus', 'apple', 'lg', 'panasonic', 'whirlpool',
    'lenovo', 'dell', 'hp', 'asus', 'acer', 'moto', 'motorola', 'nokia',
    'jbl', 'philips', 'fastrack', 'titan', 'casio', 'fossil', 'mi',
]);

/**
 * Run every site search in parallel; a failure on one site never fails the
 * whole lookup — it just comes back empty.
 */
export async function searchAll(query, { timeoutMs, siteTimeoutMs } = {}) {
    const sites = [
        searchAmazon(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
        searchFlipkart(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
        searchMyntra(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
        searchAjio(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
        searchSnapdeal(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
        searchTataCliq(query, { timeoutMs: siteTimeoutMs || timeoutMs }),
    ];
    const settled = await Promise.allSettled(sites);
    const results = [];
    settled.forEach((r) => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            results.push(...r.value);
        }
    });
    return filterRelevant(results, query);
}

/**
 * Core product lookup used by the handler.
 *
 * @param {string} input  Amazon link or a free-text product query
 * @returns {Promise<object>} normalized result
 */
export async function trackProduct(input, { timeoutMs } = {}) {
    const asin = extractAmazonAsin(input);
    const fkUrl = extractFlipkartUrl(input);

    // If it's a store link, fetch the product to learn its real title/price.
    let amazon = null;
    let flipkart = null;
    let history = null;
    let query = String(input || '').trim();

    if (asin) {
        try {
            amazon = await fetchAmazonProduct(asin, { timeoutMs });
            if (amazon.title) query = searchQueryOf(amazon.title);
        } catch (err) {
            logger.warn(`PriceTracker amazon fetch failed: ${err.message}`);
        }
        try {
            history = await fetchPriceHistory(asin);
        } catch (err) {
            logger.warn(`PriceTracker history failed: ${err.message}`);
        }
    } else if (fkUrl) {
        const cleanUrl = sanitizeFlipkartUrl(fkUrl);
        try {
            flipkart = await fetchFlipkartProduct(cleanUrl, { timeoutMs });
            if (flipkart.title) query = searchQueryOf(flipkart.title);
        } catch (err) {
            logger.warn(`PriceTracker flipkart fetch failed: ${err.message}`);
        }
        // History needs the CLEAN url (path + pid only) or a dl short link —
        // tracking params make pricehistory.app 404.
        try {
            history = await fetchPriceHistory(cleanUrl);
        } catch (err) {
            logger.warn(`PriceTracker history failed: ${err.message}`);
        }
    }

    if (!query) return { offers: [], amazon: null, flipkart: null, history: null, query: '', idKey: null };

    const offers = await searchAll(query, { timeoutMs });

    // The tracked product itself is an offer too.
    const allOffers = [];
    if (amazon?.price) {
        allOffers.push({
            title: amazon.title ? shortTitle(amazon.title) : null,
            price: amazon.price,
            url: amazon.url,
            site: 'Amazon',
            image: amazon.image,
            rating: amazon.rating,
        });
    }
    if (flipkart?.price) {
        allOffers.push({
            title: flipkart.title ? shortTitle(flipkart.title) : null,
            price: flipkart.price,
            url: flipkart.url,
            site: 'Flipkart',
            rating: flipkart.rating,
        });
    }
    allOffers.push(...offers);
    const deduped = dedupeOffers(allOffers);

    const idKey = asin ? `asin:${asin}` : flipkart?.pid ? `fk:${flipkart.pid}` : null;

    return {
        query,
        asin,
        flipkart,
        idKey,
        history,
        offers: rankOffers(deduped),
        rawOffers: deduped,
    };
}

/* ─────────────────────────── Mongo snapshots ─────────────────────────── */

export const PRICE_HISTORY_COLLECTION = 'price_history';

/**
 * Record today's offers for a product so past prices accumulate. The product
 * key is the ASIN when known, else a slug of the query.
 */
export function productKey(input, asin, { idKey } = {}) {
    if (idKey) return idKey;
    if (asin) return `asin:${asin}`;
    // Flipkart links get a pid key so history survives URL changes.
    const fkPid = extractFlipkartPid(extractFlipkartUrl(input));
    if (fkPid) return `fk:${fkPid}`;
    return `q:${String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)}`;
}

export async function savePriceSnapshots(db, { input, asin, idKey, query, offers }) {
    if (!db) return 0;
    const col = db.collection(PRICE_HISTORY_COLLECTION);
    const key = productKey(input, asin, { idKey });
    const day = new Date().toISOString().slice(0, 10);
    let saved = 0;
    for (const o of offers) {
        if (!o?.price || !o?.site) continue;
        // One snapshot per product + site + day.
        await col.updateOne(
            { productKey: key, site: o.site, day },
            {
                $setOnInsert: {
                    productKey: key,
                    query,
                    site: o.site,
                    price: o.price,
                    url: o.url,
                    title: o.title || query,
                    day,
                    checkedAt: new Date(),
                },
            },
            { upsert: true }
        );
        saved += 1;
    }
    return saved;
}

/**
 * Past snapshots for a product, newest first, capped per site. Returns a flat
 * list of { day, site, price, url, title }.
 */
export async function getPriceSnapshots(db, { input, asin, idKey, limitPerSite = 10 } = {}) {
    if (!db) return [];
    const col = db.collection(PRICE_HISTORY_COLLECTION);
    const key = productKey(input, asin, { idKey });
    const rows = await col
        .find({ productKey: key })
        .sort({ checkedAt: -1 })
        .limit(200)
        .toArray();
    const perSite = new Map();
    const out = [];
    for (const r of rows) {
        const n = perSite.get(r.site) || 0;
        if (n >= limitPerSite) continue;
        perSite.set(r.site, n + 1);
        out.push({
            day: r.day,
            site: r.site,
            price: r.price,
            url: r.url,
            title: r.title,
        });
    }
    return out;
}

export const priceTrackerService = {
    extractAmazonAsin,
    parseAmazonProduct,
    parseFlipkartSearch,
    parseAmazonSearch,
    parseMyntraSearch,
    parseAjioSearch,
    parseSnapdealSearch,
    parseTataCliqSearch,
    parsePriceHistoryMeta,
    rankOffers,
    relevanceScore,
    shortTitle,
    cleanPrice,
    productKey,
    trackProduct,
    searchAll,
    fetchAmazonProduct,
    fetchPriceHistory,
    savePriceSnapshots,
    getPriceSnapshots,
    PRICE_HISTORY_COLLECTION,
};

export default priceTrackerService;
