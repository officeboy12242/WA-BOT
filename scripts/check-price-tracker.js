/**
 * Unit checks for the price tracker (/price). Pure — no network. The parsers
 * run against small realistic snippets of each store's page so the scrapers
 * can be tuned without hitting retail sites (which rate-limit aggressively).
 *
 * Run: node scripts/check-price-tracker.js
 */
import {
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
    filterRelevant,
    relevanceScore,
    distinctiveTokens,
    cleanPrice,
    shortTitle,
    dedupeBrand,
    productKey,
    savePriceSnapshots,
    getPriceSnapshots,
    normalizeOfferUrl,
    dedupeOffers,
    searchQueryOf,
    PRICE_HISTORY_COLLECTION,
} from '../src/services/PriceTrackerService.js';
import { COMMAND_REGISTRY } from '../src/commands/registry.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };

/* ─────────────────────────── ASIN extraction ─────────────────────────── */
ok(extractAmazonAsin('https://www.amazon.in/Puma-Unisex-Adult-Smashic-White-Matte-Sneaker/dp/B0BSLKJPXV/ref=sr_1_1_sspa') === 'B0BSLKJPXV',
    'long Amazon.in product URL yields the ASIN');
ok(extractAmazonAsin('https://www.amazon.in/dp/B0BSLKJPXV') === 'B0BSLKJPXV', 'short dp URL yields the ASIN');
ok(extractAmazonAsin('https://amazon.in/gp/product/B0BSLKJPXV') === 'B0BSLKJPXV', 'gp/product URL yields the ASIN');
ok(extractAmazonAsin('B0BSLKJPXV') === 'B0BSLKJPXV', 'bare ASIN passes through');
ok(extractAmazonAsin('puma smashic sneakers') === null, 'free text has no ASIN');
ok(extractAmazonAsin(null) === null, 'null safe');
ok(extractAmazonAsin('https://flipkart.com/foo') === null, 'non-Amazon URL has no ASIN');

/* ─────────────────────────── price cleaning ─────────────────────────── */
ok(cleanPrice('₹1,573.00') === 1573, '"₹1,573.00" cleans to 1573 (not 157300)');
ok(cleanPrice('1573.00') === 1573, '"1573.00" cleans to 1573');
ok(cleanPrice('₹4,499') === 4499, '"₹4,499" cleans to 4499');
ok(cleanPrice(' 1,575 ') === 1575, 'whitespace + comma handled');
ok(cleanPrice('0') === null, 'zero price is null');
ok(cleanPrice('abc') === null, 'non-numeric is null');
ok(cleanPrice(null) === null, 'null safe');

/* ─────────────────────────── Amazon parser ─────────────────────────── */
const amazonHtml = `
<html><head><title>Buy Puma | Smashic Comfort Casual Sneakers at Amazon.in</title></head>
<body>
<span id="productTitle">Puma | Smashic Comfort Casual Sneakers</span>
<span class="a-price a-text-price apex-basisprice-value"><span class="a-offscreen">₹4,499</span></span>
<img id="landingImage" src="https://m.media-amazon.com/images/I/abc.jpg"/>
<span id="acrPopover" title="4.5 out of 5 stars"></span>
<div data-a11y-ids="mobile_buybox_group_1">{"priceAmount":1573.00,"displayPrice":"₹1,573.00"}</div>
</body></html>`;
const am = parseAmazonProduct(amazonHtml);
ok(am.title === 'Puma | Smashic Comfort Casual Sneakers', 'Amazon parser reads the product title');
ok(am.price === 1573, 'Amazon parser reads the current price');
ok(am.mrp === 4499, 'Amazon parser reads the MRP');
ok(am.image === 'https://m.media-amazon.com/images/I/abc.jpg', 'Amazon parser reads the image');
ok(parseAmazonProduct('') .title === null, 'empty HTML yields null fields');
ok(parseAmazonProduct(null).price === null, 'null HTML safe');

// mobile JSON variant (no #productTitle, price as JSON number)
const amazonMobile = `{"title":"Puma | Smashic Comfort Casual Sneakers","mobile_buybox_group_1":[{"priceAmount":1573.00,"displayPrice":"₹1,573.00"}]}`;
const amMob = parseAmazonProduct(amazonMobile);
ok(amMob.price === 1573, 'JSON priceAmount variant parses (float to int)');
ok(amMob.title.includes('Smashic'), 'JSON title variant parses');

/* ─────────────────────────── Flipkart parser ─────────────────────────── */
const flipkartHtml = `
<a href="/puma-smashic-sneakers-men/p/itm87648841321a5?pid=SHOGHKSABXRFFCZP&amp;lid=LSTSHOGHKSABXRFFCZPZZHLLX&amp;marketplace=FLIPKART&amp;q=puma+smashic"></a>
{"id":"SHOGHKSABXRFFCZP","titles":{"superTitle":"PUMA","title":"Smashic Sneakers For Men"},
 "pricing":{"prices":[{"name":"Selling Price","value":4499},{"name":"Special Price","value":1575}]}}
<a href="/other/p/itmZZZ?pid=SHOH8UHV4XVPTFUW"></a>
{"id":"SHOH8UHV4XVPTFUW","titles":{"superTitle":"PUMA","title":"Smashic Wmn Running Shoes"},
 "pricing":{"prices":[{"name":"Selling Price","value":3999}]}}`;
const fk = parseFlipkartSearch(flipkartHtml);
ok(fk.length === 2, 'Flipkart parser finds both products');
ok(fk[0].price === 1575, 'Flipkart prefers the Special Price over Selling Price');
ok(fk[0].site === 'Flipkart', 'Flipkart results tagged with site');
ok(fk[0].url.includes('itm87648841321a5') && fk[0].url.includes('pid=SHOGHKSABXRFFCZP'),
    'Flipkart URL uses the real href with pid');
ok(!fk[0].url.includes('marketplace='), 'Flipkart URL drops the tracking params');
ok(fk[1].price === 3999, 'no Special Price falls back to Selling Price');
ok(parseFlipkartSearch('<html>nothing</html>').length === 0, 'empty page yields nothing');
ok(parseFlipkartSearch('').length === 0, 'null page yields nothing');

/* ─────────────────────────── Amazon search parser ─────────────────────────── */
const amazonSearchHtml = `<div class="s-main-slot">
<div data-asin="B0BSLKJPXV" data-index="1">
<img alt="Puma | Smashic Comfort Casual Sneakers" src="x"/>
<span class="a-price-whole">1,573</span>
</div>
<div data-asin="B0FYPSRGHN" data-index="2">
<img alt="Puma | Smashic Comfort Casual Sneakers" src="x"/>
<span class="a-price-whole">3,599</span>
</div>
<div data-asin="B0FD43KWLW" data-index="3">
<img alt="Puma Unisex-Adult Court Curves Sneaker" src="x"/>
<span class="a-price-whole">2,299</span>
</div>
</div>`;
const amz = parseAmazonSearch(amazonSearchHtml);
ok(amz.length === 3, 'Amazon search parser finds the result blocks');
ok(amz[0].price === 1573, 'Amazon search parser reads the price');
ok(amz[0].url === 'https://www.amazon.in/dp/B0BSLKJPXV', 'Amazon search builds the ASIN link');
ok(amz[0].site === 'Amazon', 'Amazon search results tagged with site');
ok(parseAmazonSearch('').length === 0, 'empty Amazon search page yields nothing');
ok(parseAmazonSearch('<div data-asin="B0XXXXXX"></div>').length === 0, 'block without title+price skipped');

/* ─────────────────────────── Tata CLiQ parser ─────────────────────────── */
const tataHtml = `{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
{"@type":"ListItem","name":"Puma Women's Smashic Pearl White Sneakers","url":"/puma-womens-smashic-pearl-white-sneakers/p-mp000000016287608","position":1,"brand":{"@type":"Organization","name":"Puma"},"offers":{"@type":"Offer","priceCurrency":"INR","price":1574.65}},
{"@type":"ListItem","name":"Smashic Unisex Sneakers","url":"/smashic-unisex-sneakers/p-mp000000016283447","position":2,"brand":{"@type":"Organization","name":"Puma"},"offers":{"@type":"Offer","priceCurrency":"INR","price":1709.62}}
]}</script>`;
const tc = parseTataCliqSearch(tataHtml);
ok(tc.length === 2, 'Tata CLiQ parser finds the ItemList products');
ok(tc[0].price === 1575, 'Tata CLiQ rounds a decimal price to rupees');
ok(tc[0].url === 'https://www.tatacliq.com/puma-womens-smashic-pearl-white-sneakers/p-mp000000016287608',
    'Tata CLiQ builds the product URL');
ok(tc[0].site === 'Tata CLiQ', 'Tata CLiQ results tagged with site');
ok(tc[1].price === 1710, 'second Tata CLiQ product parsed');
ok(parseTataCliqSearch('').length === 0, 'empty Tata CLiQ page yields nothing');
ok(parseTataCliqSearch('<html>no list</html>').length === 0, 'page without ItemList yields nothing');

/* ─────────────────────────── Myntra parser ─────────────────────────── */
const myntraHtml = `{"products":[{"landingPageUrl":"casual-shoes\\u002Fpuma\\u002Fpuma-smashic-women-comfort-casual-sneakers\\u002F21766804\\u002Fbuy",
"productName":"Puma Smashic Women Comfort Casual Sneakers","brand":"Puma","mrp":4499,"price":1574},
{"landingPageUrl":"casual-shoes\\u002Fpuma\\u002Fpuma-smashic-comfort-casual-sneakers\\u002F32443480\\u002Fbuy",
"productName":"Puma Smashic Comfort Casual Sneakers","brand":"Puma","mrp":4499,"price":2249}]}`;
const my = parseMyntraSearch(myntraHtml);
ok(my.length === 2, 'Myntra parser finds both products');
ok(my[0].price === 1574, 'Myntra parser reads the price');
ok(my[0].url === 'https://www.myntra.com/casual-shoes/puma/puma-smashic-women-comfort-casual-sneakers/21766804/buy',
    'Myntra URL unescapes \\u002F and builds the absolute link');
ok(my[0].title === 'Puma Smashic Women Comfort Casual Sneakers', 'Myntra dedupes a repeated brand prefix');
ok(my[1].site === 'Myntra', 'Myntra results tagged with site');
ok(parseMyntraSearch('').length === 0, 'empty Myntra page yields nothing');

/* ─────────────────────────── Ajio parser ─────────────────────────── */
const ajioHtml = `{"products":[{"name":"Smashic Women's Comfort Casual Sneakers","url":"/puma-smashic-women-s-comfort-casual-sneakers/p/465640211_white","price":{"currencyIso":"INR","value":1575}},
{"name":"Smashic Comfort Casual Sneakers","url":"/puma-smashic-comfort-casual-sneakers/p/702044000_beige","price":{"currencyIso":"INR","value":3599}}]}`;
const aj = parseAjioSearch(ajioHtml);
ok(aj.length === 2, 'Ajio parser finds both products');
ok(aj[0].price === 1575, 'Ajio parser reads the price value');
ok(aj[0].url === 'https://www.ajio.com/puma-smashic-women-s-comfort-casual-sneakers/p/465640211_white',
    'Ajio URL builds the absolute link');
ok(aj[0].site === 'Ajio', 'Ajio results tagged with site');
ok(parseAjioSearch('').length === 0, 'empty Ajio page yields nothing');

/* ─────────────────────────── Snapdeal parser ─────────────────────────── */
const snapdealHtml = `
<div class="product-tuple">
<a class="dp-widget-link" href="https://www.snapdeal.com/product/hotstyle-boxer-black-mens-sneakers/658063277532">
<p class="product-title" title="hotstyle BOXER Black Men's Sneakers">hotstyle BOXER Black Men's Sneakers</p>
<span class="lfloat product-price" data-price="290">Rs. 290</span>
</a></div>
<div class="product-tuple">
<a class="dp-widget-link" href="https://www.snapdeal.com/product/puma-mens-smashic/999999999999">
<p class="product-title">Puma Men's Smashic</p>
<span class="lfloat product-price" data-price="1574">Rs. 1,574</span>
</a></div>`;
const sd = parseSnapdealSearch(snapdealHtml);
ok(sd.length === 2, 'Snapdeal parser finds both products');
ok(sd[0].price === 290, 'Snapdeal parser reads the price');
ok(sd[0].title === "hotstyle BOXER Black Men's Sneakers", 'Snapdeal parser reads the title');
ok(sd[0].url === 'https://www.snapdeal.com/product/hotstyle-boxer-black-mens-sneakers/658063277532',
    'Snapdeal parser reads the product link');
ok(sd[1].site === 'Snapdeal', 'Snapdeal results tagged with site');
ok(parseSnapdealSearch('').length === 0, 'empty Snapdeal page yields nothing');

/* ─────────────────────────── pricehistory.app meta ─────────────────────────── */
const phMeta = parsePriceHistoryMeta(`<meta name="description" content="Get Price History of Puma | Smashic Comfort Casual Sneakers. Lowest Price: ₹1350 | Average Price: ₹1822 | Highest Price: ₹2699 | MRP: ₹4499 |Amazon Price in India on 14/08/2026: ₹1569.">`);
ok(phMeta.lowest === 1350, 'history lowest parsed');
ok(phMeta.average === 1822, 'history average parsed');
ok(phMeta.highest === 2699, 'history highest parsed');
ok(phMeta.mrp === 4499, 'history MRP parsed');
ok(phMeta.current === 1569 && phMeta.currentDate === '14/08/2026', 'history current + date parsed');
ok(parsePriceHistoryMeta('<html></html>').lowest === undefined, 'page without meta yields nothing');

/* ─────────────────────────── relevance ─────────────────────────── */
ok(distinctiveTokens('Puma | Smashic Comfort Casual Sneakers').includes('puma'), 'brand is a distinctive token');
ok(distinctiveTokens('Puma | Smashic Comfort Casual Sneakers').includes('smashic'), 'model is a distinctive token');
ok(!distinctiveTokens('Puma | Smashic Comfort Casual Sneakers').includes('sneakers'),
    'generic words are excluded from distinctive tokens');
ok(distinctiveTokens('Puma | Smashic Comfort Casual Sneakers').length >= 2, 'query yields brand + model tokens');
ok(relevanceScore('Puma Smashic Sneakers For Men', 'Puma | Smashic Comfort Casual Sneakers') >= 0.5,
    'same brand+model scores relevant');
ok(relevanceScore('hotstyle BOXER Black Men\'s Sneakers', 'Puma | Smashic Comfort Casual Sneakers') === 0,
    'unrelated brand scores 0 despite sharing "sneakers"');
ok(relevanceScore('Puma Smashic Women Comfort Casual Sneakers', 'Puma | Smashic Comfort Casual Sneakers') >= 0.5,
    'Myntra-style title (no bar) scores relevant');
ok(relevanceScore('Ethik Men Smashic Ace Lace-Ups', 'Puma | Smashic Comfort Casual Sneakers') === 0.5,
    'same model different brand scores partial');

const offers = [
    { title: 'hotstyle BOXER Black Men\'s Sneakers', price: 290, site: 'Snapdeal', url: 'x' },
    { title: 'Puma Smashic Sneakers For Men', price: 1575, site: 'Flipkart', url: 'x' },
    { title: 'Puma Smashic Women Comfort Casual Sneakers', price: 1574, site: 'Myntra', url: 'x' },
];
const relevant = filterRelevant(offers, 'Puma | Smashic Comfort Casual Sneakers');
ok(relevant.length === 2, 'filter drops the unrelated cheap product');
ok(!relevant.some((o) => o.title.startsWith('hotstyle')), 'knockoff never tops the ranking');

/* Brand-only matches (other Puma models) must not pass an exact-product query. */
const brandOnly = filterRelevant(
    [
        { title: 'Puma Unisex-Adult Court Curves Sneaker', price: 2299, site: 'Amazon', url: 'x' },
        { title: 'Smashic Unisex Sneakers', price: 1710, site: 'Tata CLiQ', url: 'x' },
    ],
    'Puma | Smashic Comfort Casual Sneakers'
);
ok(brandOnly.length === 1 && brandOnly[0].title.startsWith('Smashic'),
    'brand-only match is dropped when the query has a model word');
ok(filterRelevant(
    [{ title: 'Puma Other Sneaker', price: 999, site: 'X', url: 'x' }],
    'puma sneakers'
).length === 1, 'brand + generic query still passes brand-only offers');

/* ─────────────────────────── ranking ─────────────────────────── */
const ranked = rankOffers([
    { site: 'Snapdeal', price: 400 }, { site: 'Amazon', price: 1573 },
    { site: 'Flipkart', price: 1575 }, { site: 'Flipkart', price: 1500 },
    { site: 'Flipkart', price: 1499 }, { site: 'Flipkart', price: 1400 },
]);
ok(ranked[0].price === 400, 'cheapest offer ranks first');
ok(ranked.filter((o) => o.site === 'Flipkart').length <= 3, 'per-site cap respected');
ok(ranked.length <= 8, 'total cap respected');
ok(rankOffers([]).length === 0, 'empty offers safe');
const capped = rankOffers([{ site: 'A', price: 1 }, { site: 'B', price: 2 }], { maxTotal: 1 });
ok(capped.length === 1, 'maxTotal cap respected');

/* ─────────────────────────── misc helpers ─────────────────────────── */
ok(shortTitle('x'.repeat(100)).length <= 70, 'long titles are shortened');
ok(shortTitle('short').length === 5, 'short titles untouched');
ok(dedupeBrand('Puma', 'Puma Smashic Women') === 'Puma Smashic Women', 'dedupe drops repeated brand');
ok(dedupeBrand('Nike', 'Air Max') === 'Nike Air Max', 'different brand is joined');

/* ─────────────────────────── URL dedupe + query cleanup ─────────────────────────── */
ok(normalizeOfferUrl('https://www.amazon.in/dp/B0BSLKJPXV?th=1&psc=1#x')
    === 'https://www.amazon.in/dp/b0bslkjpxv', 'tracking params stripped from URL key');
ok(normalizeOfferUrl('https://www.flipkart.com/p/itm123?pid=SHOGHK')
    === 'https://www.flipkart.com/p/itm123', 'flipkart pid param stripped');
ok(dedupeOffers([
    { site: 'Amazon', url: 'https://www.amazon.in/dp/B0BSLKJPXV?th=1&psc=1', price: 1573 },
    { site: 'Amazon', url: 'https://www.amazon.in/dp/B0BSLKJPXV', price: 1573 },
    { site: 'Ajio', url: 'https://www.ajio.com/x/p/1', price: 1210 },
]).length === 2, 'product-page + search duplicates collapse to one offer');
ok(dedupeOffers([
    { site: 'Amazon', url: 'https://www.amazon.in/dp/B0BSLK7CTP', price: 1569 },
    { site: 'Amazon', url: 'https://www.amazon.in/dp/B0BSLKJPXV', price: 1573 },
]).length === 2, 'different ASINs are both kept');
ok(searchQueryOf('Puma | Smashic Comfort Casual Sneakers') === 'Puma Smashic Comfort Casual Sneakers',
    'pipe separators cleaned from search query');
ok(productKey('https://www.amazon.in/dp/B0BSLKJPXV', 'B0BSLKJPXV') === 'asin:B0BSLKJPXV', 'ASIN product key');
ok(productKey('puma smashic sneakers', null) === 'q:puma-smashic-sneakers', 'query product key is slugged');
ok(PRICE_HISTORY_COLLECTION === 'price_history', 'collection name is stable');

/* ─────────────────────────── Mongo snapshots ─────────────────────────── */
const fakeCol = {
    rows: [],
    async updateOne(filter, update, opts) {
        const existing = this.rows.find((r) =>
            Object.entries(filter).every(([k, v]) => r[k] === v)
        );
        if (existing) return { upsertedId: null };
        const doc = { ...filter, ...update.$setOnInsert };
        this.rows.push(doc);
        return { upsertedId: doc };
    },
    find(q) {
        const rows = this.rows.filter((r) =>
            Object.entries(q).every(([k, v]) => r[k] === v)
        );
        const cursor = {
            sort: () => cursor,
            limit: () => cursor,
            toArray: async () => rows,
        };
        return cursor;
    },
};
const fakeDb = { collection: (name) => { if (name !== PRICE_HISTORY_COLLECTION) throw new Error('wrong collection'); return fakeCol; } };

await savePriceSnapshots(fakeDb, {
    input: 'https://www.amazon.in/dp/B0BSLKJPXV',
    asin: 'B0BSLKJPXV',
    query: 'Puma Smashic',
    offers: [{ site: 'Amazon', price: 1573, url: 'a', title: 'Puma' }],
});
ok(fakeCol.rows.length === 1, 'one snapshot saved');
ok(fakeCol.rows[0].productKey === 'asin:B0BSLKJPXV', 'snapshot keyed by ASIN');
ok(fakeCol.rows[0].day.length === 10, 'snapshot carries a day stamp');
await savePriceSnapshots(fakeDb, {
    input: 'https://www.amazon.in/dp/B0BSLKJPXV',
    asin: 'B0BSLKJPXV',
    query: 'Puma Smashic',
    offers: [{ site: 'Amazon', price: 1500, url: 'a', title: 'Puma' }],
});
ok(fakeCol.rows.length === 1, 'same product+site+day does not double-save');
await savePriceSnapshots(fakeDb, {
    input: 'puma smashic',
    asin: null,
    query: 'puma smashic',
    offers: [{ site: 'Flipkart', price: 1575, url: 'f', title: 'Puma' }],
});
ok(fakeCol.rows.length === 2, 'a different product key saves separately');
ok(await savePriceSnapshots(null, { input: 'x', asin: null, query: 'x', offers: [] }) === 0,
    'no db: save is a no-op');

const snapshots = await getPriceSnapshots(fakeDb, { input: 'https://www.amazon.in/dp/B0BSLKJPXV', asin: 'B0BSLKJPXV' });
ok(snapshots.length === 1 && snapshots[0].site === 'Amazon', 'snapshots read back');
ok(await getPriceSnapshots(null, { input: 'x', asin: null }).then((r) => r.length === 0),
    'no db: history read is a no-op');

/* ─────────────────────────── command wiring ─────────────────────────── */
const cmd = COMMAND_REGISTRY.find((c) => c.key === 'price');
ok(Boolean(cmd), '/price registered');
ok(cmd?.names.includes('/price'), '/price name present');
ok(cmd?.scope === 'any', '/price works in DMs and groups');
ok(cmd?.role === 'anyone', '/price available to everyone');
const names = COMMAND_REGISTRY.flatMap((c) => c.names);
ok(names.filter((n) => n === '/price').length === 1, '/price is not a duplicate name');

console.log(`\ncheck-price-tracker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
