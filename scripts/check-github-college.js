/**
 * Self-check: Saturday college/resume GitHub posts.
 *
 * - Formatter includes COLLEGE header + Why now
 * - LLM topic JSON parse + fallback topics
 * - Saturday detection (IST) switches fetchForSlot to college
 * - Awesome skip reason on Saturday
 * - Live GitHub search with fallback topics (no LLM required)
 *
 * Run: node scripts/check-github-college.js
 */
import assert from 'node:assert/strict';
import { formatGitHubRepoMessage } from '../src/utils/githubFormatter.js';
import { isSaturdayInTimezone, weekdayShortInTimezone } from '../src/utils/newsScheduler.js';
import GitHubTrendingService, {
    COLLEGE_FALLBACK_TOPICS,
    parseCollegeTopicsJson,
    topicToWhyNow,
} from '../src/services/GitHubTrendingService.js';

let failures = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => {
    console.error(`✖ ${msg}`);
    failures += 1;
};

// --- format ---
{
    const text = formatGitHubRepoMessage(
        {
            fullName: 'demo/hospital-mern',
            description: 'Hospital management for final year',
            language: 'JavaScript',
            totalStars: '1200',
            forks: '400',
            url: 'https://github.com/demo/hospital-mern',
            category: 'college',
            whyNow: 'MERN · Hospital · Final-year',
        },
        2,
        5,
    );
    try {
        assert.match(text, /COLLEGE \/ RESUME PROJECT/);
        assert.match(text, /Why now:.*MERN/);
        assert.match(text, /https:\/\/github\.com\/demo\/hospital-mern/);
        assert.ok(!text.includes('GITHUB TRENDING'));
        ok('formatter college + why now');
    } catch (err) {
        fail(`formatter: ${err.message}`);
    }
}

// --- topic helpers ---
{
    try {
        const parsed = parseCollegeTopicsJson(`Here you go:
{"topics":["FastAPI Python","MERN e-commerce","Flutter Firebase","RAG LangChain","Django hospital"],"why_now":"AI + classic CRUD"}`);
        assert.equal(parsed.topics.length, 5);
        assert.match(parsed.whyNow, /AI/);
        assert.match(topicToWhyNow('RAG chatbot LangChain'), /RAG/);
        assert.ok(COLLEGE_FALLBACK_TOPICS.length >= 8);
        ok('topic parse + fallback list');
    } catch (err) {
        fail(`topics: ${err.message}`);
    }
}

// --- Saturday detection ---
{
    // 2026-09-12 is a Saturday UTC; noon IST still Saturday
    const sat = new Date('2026-09-12T06:30:00Z');
    const mon = new Date('2026-09-08T06:30:00Z');
    try {
        assert.equal(weekdayShortInTimezone(sat, 'Asia/Kolkata'), 'Sat');
        assert.equal(isSaturdayInTimezone(sat, 'Asia/Kolkata'), true);
        assert.equal(isSaturdayInTimezone(mon, 'Asia/Kolkata'), false);
        ok('IST Saturday detection');
    } catch (err) {
        fail(`weekday: ${err.message}`);
    }
}

// --- fetchForSlot routes to college on Saturday (mocked search) ---
{
    const svc = new GitHubTrendingService(5, {
        timezone: 'Asia/Kolkata',
        collegeSaturday: true,
        llm: null,
    });
    const sat = new Date('2026-09-12T06:30:00Z');
    const mon = new Date('2026-09-08T06:30:00Z');

    let collegeCalls = 0;
    let trendingCalls = 0;
    svc.fetchCollege = async () => {
        collegeCalls += 1;
        return [
            {
                fullName: 'x/college-demo',
                url: 'https://github.com/x/college-demo',
                category: 'college',
                whyNow: 'Demo',
            },
        ];
    };
    svc.fetchFromTrendingPage = async () => {
        trendingCalls += 1;
        return [{ fullName: 'x/trend', url: 'https://github.com/x/trend', category: 'trending' }];
    };
    svc.fetchPopular = async () => [];
    svc.fetchUnderrated = async () => [];

    try {
        assert.equal(svc.isCollegeSaturday(sat), true);
        assert.equal(svc.isCollegeSaturday(mon), false);
        const satRepos = await svc.fetchForSlot(0, sat);
        assert.equal(collegeCalls, 1);
        assert.equal(satRepos[0]?.category, 'college');
        const monRepos = await svc.fetchForSlot(0, mon);
        assert.ok(trendingCalls >= 1, 'weekday should hit trending path');
        assert.equal(monRepos[0]?.category, 'trending');
        ok('fetchForSlot Saturday=college, weekday=trending');
    } catch (err) {
        fail(`fetchForSlot: ${err.message}`);
    }
}

// --- live GitHub search with fallback topics (optional network) ---
{
    const svc = new GitHubTrendingService(3, {
        timezone: 'Asia/Kolkata',
        collegeSaturday: true,
        llm: null,
    });
    try {
        const repos = await svc.fetchCollege(3, {
            slotIndex: 0,
            now: new Date('2026-09-12T06:30:00Z'),
        });
        if (!repos.length) {
            fail('live college search returned 0 repos (rate limit?)');
        } else {
            assert.equal(repos[0].category, 'college');
            assert.ok(repos[0].url?.includes('github.com'));
            assert.ok(repos[0].whyNow);
            console.log('sample:', repos[0].fullName, '|', repos[0].whyNow);
            console.log('--- preview ---');
            console.log(formatGitHubRepoMessage(repos[0], 1, 5));
            ok(`live college search (${repos.length} repos)`);
        }
    } catch (err) {
        fail(`live search: ${err.message}`);
    }
}

if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\ngithub college check ok');
