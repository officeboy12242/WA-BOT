/**
 * Live test: HdHubBypassService — resolve many HDHub4u intermediate links in parallel.
 *
 *   node scripts/test-hdhub-bypass.js
 *
 * Shows that batching N links costs ~the time of one link (parallel + budgeted),
 * and that a full searchMovies() with enrichment stays within budget.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
import 'dotenv/config';

import { hdHubMoviesService } from '../src/services/HdHubMoviesService.js';
import { resolveManyLinks } from '../src/services/HdHubBypassService.js';
import { config } from '../src/config/config.js';

const budgetMs = config.MOVIE_HD_BYPASS_BUDGET_MS || 12_000;

function pad(s, n) {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

function printLinks(result) {
    console.log(`\n=== ${result.title}  [${result.source}]`);
    for (const l of result.links) {
        console.log(`  ${pad(l.label || '-', 14)} ${pad(l.size || '-', 18)} ${l.url.slice(0, 110)}`);
    }
}

async function timeBatch() {
    console.log('─'.repeat(70));
    console.log('PART 1 — batch resolve (6 links in parallel)');
    const urls = [
        'https://hubcdn.wiki/file/1EQ9EwtzCY4v4WaKSzwNy3b3N',
        'https://hubcloud.ist/drive/elc6e7ce2x1yffr',
        'hubdrive.pics/file/2042971242',
        'hubdrive.pics/file/2662851313',
        'https://hubcloud.ist/drive/elc6e7ce2x1yffr', // duplicate — must be deduped
        'https://nexdrive.you/genxfm842319838431274/',
   ].map((u) => (u.startsWith('http') ? u : `https://${u}`));

    const t0 = Date.now();
    const map = await resolveManyLinks(urls, { budgetMs, maxLinks: 6 });
    const dt = Date.now() - t0;
    console.log(`resolved ${map.size}/${urls.length} unique links in ${dt}ms (budget ${budgetMs}ms)`);
    for (const [src, links] of map) {
        console.log(`\n  ${src.slice(0, 70)}`);
        for (const l of links) console.log(`     → ${pad(l.label, 14)} ${l.url.slice(0, 105)}`);
    }
    if (dt > budgetMs + 2_500) {
        console.log(`\n⚠️  Batch took ${dt}ms — over budget+grace; parallelism may be broken`);
        process.exitCode = 1;
    }
}

async function timeFullSearch() {
    console.log('\n' + '─'.repeat(70));
    console.log('PART 2 — full searchMovies with bypass (real API query)');
    const query = process.argv[2] || 'awarapan 2';
    const t0 = Date.now();
    const results = await hdHubMoviesService.searchMovies(query, 4);
    const dt = Date.now() - t0;
    console.log(`searchMovies("${query}") → ${results.length} result(s) in ${dt}ms`);
    for (const r of results) printLinks(r);
    return dt;
}

(async () => {
    try {
        await timeBatch();
        const dt = await timeFullSearch();
        // healthy full search = API fetch (≤ hdTimeout) + bypass budget + slack
        const hdTimeout = config.MOVIE_HD_TIMEOUT_MS || 28_000;
        const slack = 4_000;
        if (dt > hdTimeout + (config.MOVIE_HD_BYPASS_BUDGET_MS || 12_000) + slack) {
            console.log(`\n⚠️  Full search ${dt}ms exceeded hdTimeout+budget+slack`);
            process.exitCode = 1;
        }
        console.log('\n✅ test done');
    } catch (err) {
        console.error('❌ test failed:', err?.stack || err);
        process.exitCode = 1;
    }
})();
