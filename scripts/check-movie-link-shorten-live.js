/**
 * Live self-check: Koyeb → Render /d/ base → TinyURL display shorten.
 * Run: node scripts/check-movie-link-shorten-live.js
 */
import assert from 'node:assert/strict';
import dotenv from 'dotenv';

dotenv.config();

const { config } = await import('../src/config/config.js');
const { connectMongo, closeMongo } = await import('../src/db/mongo.js');
const { shortLinkService } = await import('../src/services/ShortLinkService.js');
const { default: UrlShortener, DISPLAY_SHORT_RE } = await import('../src/utils/urlShortener.js');
const {
    bootstrapMovieLinkPublicBase,
    _resetLearnedPublicBaseForTests,
} = await import('../src/utils/publicBaseUrl.js');

_resetLearnedPublicBaseForTests();

// Simulate Koyeb runtime (TinyURL blocks .koyeb.app)
process.env.KOYEB_PUBLIC_DOMAIN = process.env.KOYEB_PUBLIC_DOMAIN || 'whatsapp-bot-test.koyeb.app';
delete process.env.MOVIE_LINK_PUBLIC_URL;
delete process.env.RENDER_EXTERNAL_URL;

const base = await bootstrapMovieLinkPublicBase();
assert.ok(base, 'movie link base should resolve on Koyeb');
assert.match(base, /onrender\.com$/i, 'Koyeb should route /d/ through Render for TinyURL');
assert.doesNotMatch(base, /koyeb\.app$/i, 'must not mint /d/ on blocked koyeb host');

const db = await connectMongo({ uri: config.MONGODB_URI, dbName: config.MONGODB_DB_NAME });
await shortLinkService.init(db);
const shortener = new UrlShortener();
shortener.setService(shortLinkService);

const driveUrl = `https://example.test/movie-live-${Date.now()}.mkv`;
const out = await shortener.shorten(driveUrl);

assert.ok(DISPLAY_SHORT_RE.test(out), `expected display short URL, got: ${out}`);
assert.doesNotMatch(out, /koyeb\.app/i, 'display URL must not be raw koyeb /d/');
assert.notEqual(out, driveUrl, 'must not return raw drive URL');

console.log('check-movie-link-shorten-live: ok');
console.log(`  movie /d/ base: ${base}`);
console.log(`  display url:  ${out}`);

await closeMongo();
