/**
 * Self-check: UrlShortener must not reuse display links past short-link TTL.
 * Run: node scripts/check-vault-shortlink-cache.js
 */
import assert from 'assert';
import UrlShortener from '../src/utils/urlShortener.js';
import { isEphemeralDisplayUrl, sanitizeMovieResults } from '../src/services/MovieCacheService.js';

assert.equal(isEphemeralDisplayUrl('https://tinyurl.com/abc'), true);
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

console.log('OK vault shortlink cache + sanitize');
