/**
 * Self-check: UrlShortener must not reuse display links past short-link TTL.
 * Run: node scripts/check-vault-shortlink-cache.js
 */
import assert from 'assert';
import UrlShortener from '../src/utils/urlShortener.js';
import { isEphemeralDisplayUrl, sanitizeMovieResults } from '../src/services/MovieCacheService.js';

assert.equal(isEphemeralDisplayUrl('https://tinyurl.com/abc'), true);
assert.equal(isEphemeralDisplayUrl('https://is.gd/abc'), true);
assert.equal(isEphemeralDisplayUrl('https://bot.example/d/Ab12'), true);
assert.equal(isEphemeralDisplayUrl('https://drive.example/file/xyz'), false);

const cleaned = sanitizeMovieResults([
    {
        title: 'Test',
        source: 'Drive',
        links: [
            { quality: '720p', url: 'https://tinyurl.com/dead' },
            { quality: '1080p', url: 'https://host.example/real.mkv' },
        ],
    },
]);
assert.equal(cleaned.length, 1);
assert.equal(cleaned[0].links.length, 1);
assert.equal(cleaned[0].links[0].url, 'https://host.example/real.mkv');

const shortener = new UrlShortener();
let mintCount = 0;
shortener.setService({
    async shorten(longUrl) {
        mintCount += 1;
        return {
            url: `https://example.test/d/code${mintCount}`,
            code: `code${mintCount}`,
            expiresAt: Date.now() + 60_000,
        };
    },
});
shortener._toTinyUrl = async (u) => `https://tinyurl.com/fake${mintCount}`;

const a = await shortener.shorten('https://host.example/a.mkv');
const b = await shortener.shorten('https://host.example/a.mkv');
assert.equal(a, b);
assert.equal(mintCount, 1, 'second call should hit memory cache');

// Force expiry → must remint
const entry = shortener._cache.get('https://host.example/a.mkv');
entry.expiresAt = Date.now() - 1;
const c = await shortener.shorten('https://host.example/a.mkv');
assert.equal(mintCount, 2, 'expired cache must remint /d/ + TinyURL');
assert.notEqual(c, a);

// TinyURL failure must NOT fall back to a permanent drive TinyURL.
let driveTinyCalls = 0;
const shortener2 = new UrlShortener();
shortener2.setService({
    async shorten(longUrl) {
        return {
            url: 'https://bot.koyeb.app/d/expiring1',
            code: 'expiring1',
            expiresAt: Date.now() + 60_000,
        };
    },
});
shortener2._toDisplayShortUrl = async (u) => {
    if (u.includes('/d/')) return null;
    driveTinyCalls += 1;
    return 'https://tinyurl.com/permanent-drive';
};
const d = await shortener2.shorten('https://drive.example/file.mkv');
assert.equal(d, 'https://bot.koyeb.app/d/expiring1', 'display fail → keep expiring /d/ link');
assert.equal(driveTinyCalls, 0, 'must never TinyURL the raw drive URL');

// Koyeb: TinyURL blocks .koyeb.app — zip1.io / clck.ru wrap /d/ links.
const shortener3 = new UrlShortener();
shortener3.setService({
    async shorten() {
        return {
            url: 'https://bot.koyeb.app/d/koyeb1',
            code: 'koyeb1',
            expiresAt: Date.now() + 60_000,
        };
    },
});
shortener3._toDisplayShortUrl = async (u) => {
    if (u.includes('koyeb.app/d/')) return 'https://zip1.io/koyebshort';
    return null;
};
const k = await shortener3.shorten('https://drive.example/k.mkv');
assert.equal(k, 'https://zip1.io/koyebshort', 'Koyeb /d/ → zip1.io when TinyURL blocked');

console.log('OK vault shortlink cache + sanitize');
