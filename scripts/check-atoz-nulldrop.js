import { hdHubMoviesService } from '../src/services/HdHubMoviesService.js';

const results = await hdHubMoviesService.searchMovies('ek din 2026', 10);
const atoz = results.filter((r) => /^atoz$/i.test(String(r.source || '')));
if (!atoz.length) {
    console.error('FAIL: no atoz result');
    process.exit(1);
}

const links = atoz[0].links || [];
const nullDrop = links.filter((l) => /null-drop\.onrender\.com/i.test(l.url));
const telegram = links.filter((l) => /t\.me\//i.test(l.url));

console.log('atoz links', links.length);
console.log('null-drop', nullDrop.length);
console.log('telegram', telegram.length);
for (const l of nullDrop) {
    console.log(' -', l.size, l.url);
}

if (nullDrop.length < 5) {
    console.error(`FAIL: expected >=5 NullDrop, got ${nullDrop.length}`);
    process.exit(1);
}
if (telegram.length) {
    console.error(`FAIL: telegram should be dropped when NullDrop present, got ${telegram.length}`);
    process.exit(1);
}
// NullDrop must come first
if (!/null-drop/i.test(links[0]?.url || '')) {
    console.error('FAIL: NullDrop should be first');
    process.exit(1);
}
console.log('atoz nulldrop check ok');
