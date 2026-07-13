/**
 * Job discovery + LLM scoring.
 * Default mode: India boards (Naukri → Indeed → LinkedIn) to stay within TinyFish limits.
 * Optional mode: company career pages (jobHuntCompanies.json).
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { TinyFishClient } from './TinyFishClient.js';
import { JobHuntLlmService } from './JobHuntLlmService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JOB_URL_RE =
    /\/(job|jobs|opening|openings|position|positions|vacancy|vacancies|role|roles|apply)\/[a-zA-Z0-9_%@.-]{4,}/i;
const ATS_JOB_RE =
    /(greenhouse\.io\/.+\/jobs\/\d+|lever\.co\/[^/]+\/[a-f0-9-]{36}|myworkdayjobs\.com\/[^?#]+|smartrecruiters\.com\/[^/]+\/[A-Z0-9]+|ashbyhq\.com\/[^/]+\/[a-f0-9-]{32,})/i;
const ATS_LISTING_RE =
    /^https?:\/\/(jobs\.lever\.co|boards\.greenhouse\.io|apply\.workable\.com|jobs\.smartrecruiters\.com)\/[^/?#]+\/?(\?.*)?$/i;

const INDIA_BOARD_URL_RE =
    /(?:naukri\.com\/(?:job-listings-|[^?\s]*job)|(?:in\.|www\.)?indeed\.(?:co\.in|com)\/(?:viewjob|rc\/clk|jobs\/)|linkedin\.com\/jobs\/(?:view|collections|search))/i;

const DEFAULT_SENIORITY = 'senior OR mid OR engineer OR developer';
const DEFAULT_KEYWORDS =
    '"software engineer" OR backend OR fullstack OR "node.js" OR python OR "full stack" OR "software developer"';
const INDIA_LOC =
    '(India OR Bangalore OR Bengaluru OR Hyderabad OR Pune OR Mumbai OR Chennai OR Noida OR Gurugram OR Gurgaon OR Remote OR "work from home")';

const SCORE_PROMPT = `You are evaluating job postings for a candidate in India. Prefer India / remote-India roles. Output ONLY a JSON array, no other text.

CANDIDATE:
{candidate_profile}

RESUME SUMMARY:
{resume_summary}

JOBS TO SCORE:
{jobs_text}

For each job output:
{
  "job_number": 1,
  "score": 0-100,
  "title": "extracted job title",
  "stack": "key tech from JD (comma-separated, max 6 items)",
  "location_remote": "location + remote policy",
  "reason": "one sentence why this fits or doesn't fit the candidate",
  "worth_applying": true/false
}

Scoring: 80-100 near-perfect; 60-79 good fit; 40-59 partial; <40 poor.
Down-rank non-India / overseas-only roles unless explicitly remote-friendly for India.
Set worth_applying=true only if score >= {min_score}.
Include ALL jobs. Output ONLY the JSON array.`;

function isJobUrl(url) {
    return JOB_URL_RE.test(url) || ATS_JOB_RE.test(url) || INDIA_BOARD_URL_RE.test(url);
}

function isAtsListing(url) {
    return ATS_LISTING_RE.test(url);
}

function isIndiaBoardUrl(url, board) {
    if (!url || !INDIA_BOARD_URL_RE.test(url)) return false;
    const u = String(url).toLowerCase();
    if (board?.id === 'naukri') return u.includes('naukri.com');
    if (board?.id === 'indeed') return u.includes('indeed.');
    if (board?.id === 'linkedin') return u.includes('linkedin.com/jobs');
    return true;
}

function loadJson(rel) {
    return JSON.parse(readFileSync(resolve(__dirname, rel), 'utf8'));
}

function buildCandidateProfile(candidate = {}) {
    const lines = [`- ${candidate.name || 'Candidate'}`];
    if (candidate.profile) lines.push(`- ${candidate.profile}`);
    if (candidate.seeking) lines.push(`- Seeking: ${candidate.seeking}`);
    if (candidate.notSuitable) lines.push(`- NOT suitable: ${candidate.notSuitable}`);
    lines.push('- Preference: India locations / India-remote first');
    return lines.join('\n');
}

function buildSearchQuery(domain, candidate = {}) {
    const seniority = candidate.searchSeniority || DEFAULT_SENIORITY;
    const keywords = candidate.searchKeywords || DEFAULT_KEYWORDS;
    return `site:${domain} (${seniority}) (${keywords})`;
}

function buildIndiaQueries(board, candidate = {}) {
    const seniority = candidate.searchSeniority || DEFAULT_SENIORITY;
    const keywords = candidate.searchKeywords || DEFAULT_KEYWORDS;
    const domain = board.domain;
    // 2 focused queries per board — keeps TinyFish search count tiny
    return [
        `site:${domain} (${keywords}) ${INDIA_LOC}`,
        `site:${domain} (${seniority}) (${keywords}) India`,
    ];
}

function parseJsonArray(raw) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']') + 1;
    if (start < 0 || end <= start) return [];
    return JSON.parse(raw.slice(start, end));
}

function isDeadJobPage(text = '', title = '', statusCode = null) {
    if (statusCode === 404 || statusCode === 410) return true;
    const blob = `${title}\n${text}`.toLowerCase();
    if (!blob.trim()) return true;
    return (
        /couldn't find anything here/.test(blob) ||
        /404 error/.test(blob) ||
        /page not found/.test(blob) ||
        /job posting you're looking for might have closed/.test(blob) ||
        /this job (is )?(no longer|has been) (available|open|active)/.test(blob) ||
        /position has been filled/.test(blob) ||
        /job (has been )?(closed|removed|expired|deleted)/.test(blob) ||
        /no longer accepting applications/.test(blob) ||
        /sorry,? we couldn.?t find/.test(blob) ||
        /this job has expired/.test(blob)
    );
}

function resultForUrl(results, url) {
    const list = results || [];
    const exact = list.find((r) => r.url === url || r.final_url === url || r.request_url === url);
    if (exact) return exact;
    const path = String(url).replace(/\/$/, '');
    return list.find((r) => {
        const u = String(r.url || r.final_url || '').replace(/\/$/, '');
        return u === path || u.endsWith(path.split('/').slice(-2).join('/'));
    });
}

function guessTitleFromUrl(url, searchTitle) {
    if (searchTitle && String(searchTitle).trim().length > 3) return String(searchTitle).trim();
    try {
        const last = decodeURIComponent(url.split('/').pop() || '')
            .replace(/[-_+]/g, ' ')
            .replace(/\?.*/, '');
        return last.slice(0, 120) || 'Role';
    } catch {
        return 'Role';
    }
}

export class JobHuntScanner {
    constructor(config, mongoDb) {
        this.config = config;
        this.mongoDb = mongoDb;
        this.tf = new TinyFishClient(config.TINYFISH_API_KEY, {
            fetchDelayMs: config.JOB_HUNT_FETCH_DELAY_MS || 2500,
            searchDelayMs: config.JOB_HUNT_SEARCH_DELAY_MS || 8000,
        });
        this.llm = new JobHuntLlmService(config);
        this.companies = loadJson('../data/jobHuntCompanies.json');
        this.indiaBoards = loadJson('../data/jobHuntIndiaBoards.json');
        this.mode = String(config.JOB_HUNT_MODE || 'india').toLowerCase() === 'companies' ? 'companies' : 'india';
        this.maxJobsPerScan = Math.max(5, Math.min(40, config.JOB_HUNT_MAX_JOBS || 20));
        this.maxPerBoard = Math.max(3, Math.min(15, config.JOB_HUNT_MAX_PER_BOARD || 8));
        this._seen = null;
        this._jobs = null;
        this._runs = null;
        this._scanning = false;
    }

    async init() {
        this._seen = this.mongoDb.collection('job_hunt_seen');
        this._jobs = this.mongoDb.collection('job_hunt_jobs');
        this._runs = this.mongoDb.collection('job_hunt_runs');
        await Promise.all([
            this._seen.createIndex({ url: 1 }, { unique: true }),
            this._jobs.createIndex({ scan_date: -1, score: -1 }),
            this._jobs.createIndex({ url: 1 }),
            this._runs.createIndex({ started_at: -1 }),
        ]);
        const src =
            this.mode === 'india'
                ? `India boards: ${this.indiaBoards.map((b) => b.name).join(' → ')}`
                : `${this.companies.length} companies`;
        logger.info(`Job hunt scanner ready (${this.mode}) — ${src}`);
    }

    isBusy() {
        return this._scanning;
    }

    getSourceLabel() {
        if (this.mode === 'india') {
            return this.indiaBoards.map((b) => b.name).join(' · ');
        }
        return `${this.companies.length} companies`;
    }

    async getSeenUrls() {
        const rows = await this._seen.find({}, { projection: { url: 1 } }).toArray();
        return new Set(rows.map((r) => r.url));
    }

    async markSeen(urls) {
        if (!urls?.length) return;
        const ops = urls.map((url) => ({
            updateOne: {
                filter: { url },
                update: { $setOnInsert: { url, first_seen_at: new Date() } },
                upsert: true,
            },
        }));
        await this._seen.bulkWrite(ops, { ordered: false }).catch(() => {});
    }

    async discoverIndiaBoards(seenUrls, candidate, onProgress = null) {
        const found = [];
        const boards = [...this.indiaBoards].sort((a, b) => (a.priority || 99) - (b.priority || 99));

        for (const board of boards) {
            onProgress?.(`Searching ${board.name} (India)…`);
            logger.info(`JobHunt board: ${board.name}`);
            const perBoard = new Map();
            const queries = buildIndiaQueries(board, candidate);

            for (const query of queries) {
                if (perBoard.size >= this.maxPerBoard) break;
                try {
                    const search = await this.tf.search(query);
                    for (const r of search.results || []) {
                        const url = r.url || r.link;
                        if (!url || seenUrls.has(url) || perBoard.has(url)) continue;
                        if (!isIndiaBoardUrl(url, board)) continue;
                        perBoard.set(url, {
                            url,
                            title: guessTitleFromUrl(url, r.title || r.name),
                            snippet: r.snippet || r.description || '',
                            company: board.name,
                            source: board.id,
                            location: board.location,
                            region: 'IN',
                        });
                        if (perBoard.size >= this.maxPerBoard) break;
                    }
                } catch (err) {
                    if (err.code === 'TINYFISH_LIMIT') throw err;
                    logger.warn(`JobHunt ${board.name} search failed: ${err.message}`);
                }
            }

            found.push(...perBoard.values());
            if (found.length >= this.maxJobsPerScan) break;
        }

        return found.slice(0, this.maxJobsPerScan);
    }

    async discoverCompany(company, seenUrls, candidate) {
        const found = new Set();

        const page = await this.tf.getContents([company.careers_url], { format: 'markdown', links: true });
        const links = page.results?.[0]?.links || [];
        for (const link of links) {
            if (isJobUrl(link) && !seenUrls.has(link)) found.add(link);
        }
        const atsPages = [...new Set(links.filter(isAtsListing))].slice(0, 5);
        if (atsPages.length) {
            const ats = await this.tf.getContents(atsPages, { format: 'markdown', links: true });
            for (const r of ats.results || []) {
                for (const link of r.links || []) {
                    if (isJobUrl(link) && !seenUrls.has(link)) found.add(link);
                }
            }
        }

        const query = buildSearchQuery(company.search_domain, candidate);
        const search = await this.tf.search(query);
        for (const r of search.results || []) {
            const url = r.url || r.link;
            if (url && isJobUrl(url) && !seenUrls.has(url)) found.add(url);
        }

        return [...found].map((url) => ({
            url,
            title: guessTitleFromUrl(url),
            snippet: '',
            company: company.name,
            location: company.location,
            region: company.region,
        }));
    }

    async fetchDetails(jobs) {
        const enriched = [];
        const deadUrls = [];
        for (let i = 0; i < jobs.length; i += 10) {
            const batch = jobs.slice(i, i + 10);
            const resp = await this.tf.getContents(
                batch.map((j) => j.url),
                { format: 'markdown' },
            );
            const errByUrl = new Map();
            for (const e of resp.errors || []) {
                const u = e.url || e.request_url;
                if (u) errByUrl.set(u, e);
            }
            for (const job of batch) {
                const r = resultForUrl(resp.results, job.url);
                const err = errByUrl.get(job.url);
                const statusCode = r?.status_code ?? r?.status ?? err?.status_code ?? err?.status ?? null;
                const text = r?.text ? String(r.text) : '';
                const title = r?.title || job.title || '';

                if (!r || isDeadJobPage(text, title, statusCode)) {
                    deadUrls.push(job.url);
                    logger.info(`JobHunt drop dead/404: ${job.company} — ${job.url}`);
                    continue;
                }
                if (text.trim().length < 80) {
                    // Keep search snippet as weak content for India boards behind login walls
                    if ((job.snippet || '').trim().length >= 40) {
                        job.content = String(job.snippet).slice(0, 1500);
                        enriched.push(job);
                    } else {
                        deadUrls.push(job.url);
                    }
                    continue;
                }

                job.content = text.slice(0, 3000);
                job.title = title || job.title;
                if (r.final_url && r.final_url !== job.url) job.url = r.final_url;
                enriched.push(job);
            }
        }
        if (deadUrls.length) await this.markSeen(deadUrls);
        return enriched;
    }

    async scoreJobs(jobs, resume, candidate) {
        if (!jobs.length) return [];
        const minScore = candidate.minScore ?? 60;
        const jobsText = jobs
            .map(
                (j, i) =>
                    `JOB ${i + 1}:\nCompany/Source: ${j.company} | Location: ${j.location}\n` +
                    `Title: ${j.title}\nURL: ${j.url}\n` +
                    `Content:\n${(j.content || j.snippet || '').slice(0, 1500)}`,
            )
            .join('\n\n');

        const prompt = SCORE_PROMPT.replace('{candidate_profile}', buildCandidateProfile(candidate))
            .replace('{resume_summary}', String(resume || '').slice(0, 2500))
            .replace('{jobs_text}', jobsText)
            .replace('{min_score}', String(minScore));

        const { text, provider, model } = await this.llm.chat({
            user: prompt,
            temperature: 0.1,
            maxTokens: 5000,
        });
        logger.info(`JobHunt scored batch via ${provider}/${model}`);

        let scored;
        try {
            scored = parseJsonArray(text);
        } catch (err) {
            logger.warn(`JobHunt score JSON parse failed: ${err.message}`);
            return [];
        }

        const results = [];
        for (const item of scored) {
            if (!item?.worth_applying) continue;
            const idx = Number(item.job_number) - 1;
            if (idx < 0 || idx >= jobs.length) continue;
            const job = { ...jobs[idx] };
            job.score = Number(item.score) || 0;
            job.extracted_title = item.title || job.title;
            job.stack = item.stack || '';
            job.location_remote = item.location_remote || job.location;
            job.reason = item.reason || '';
            job.worth_applying = true;
            results.push(job);
        }
        return results.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    async _scoreAndCollect(newJobs, seenUrls, resume, candidate, allScored, limitWarnings) {
        if (!newJobs.length) return 0;
        newJobs = await this.fetchDetails(newJobs);
        await this.markSeen(newJobs.map((j) => j.url));
        newJobs.forEach((j) => seenUrls.add(j.url));

        let scoredCount = 0;
        for (let b = 0; b < newJobs.length; b += 10) {
            const batch = newJobs.slice(b, b + 10);
            const batchScored = await this.scoreJobs(batch, resume, candidate);
            allScored.push(...batchScored);
            scoredCount += batchScored.length;
            limitWarnings.push(...this.llm.takeLimitWarnings());
        }
        return scoredCount;
    }

    async runScan({
        candidate,
        resume,
        maxCompanies = null,
        onProgress = null,
        abortOnTinyFishLimit = true,
    } = {}) {
        if (this._scanning) {
            throw new Error('A job hunt scan is already running');
        }
        if (!this.tf.isConfigured()) {
            throw new Error('TINYFISH_API_KEY not configured');
        }

        this._scanning = true;
        const startedAt = new Date();
        const seenUrls = await this.getSeenUrls();
        const allScored = [];
        const errors = [];
        const limitWarnings = [];
        let sourcesWithJobs = 0;
        const mode = this.mode;

        const sourceTotal = mode === 'india' ? this.indiaBoards.length : this.companies.slice(0, maxCompanies || this.companies.length).length;

        await this._runs.insertOne({
            started_at: startedAt,
            status: 'running',
            mode,
            company_total: sourceTotal,
        });

        try {
            if (mode === 'india') {
                onProgress?.('India boards: Naukri → Indeed → LinkedIn…');
                logger.info(`JobHunt India mode — max ${this.maxJobsPerScan} jobs (${this.maxPerBoard}/board)`);
                try {
                    let newJobs = await this.discoverIndiaBoards(seenUrls, candidate, onProgress);
                    logger.info(`JobHunt India discovered ${newJobs.length} URLs`);
                    const n = await this._scoreAndCollect(
                        newJobs,
                        seenUrls,
                        resume,
                        candidate,
                        allScored,
                        limitWarnings,
                    );
                    if (n > 0) sourcesWithJobs = 1;
                } catch (err) {
                    errors.push(`India boards: ${err.message}`);
                    logger.error(`JobHunt India failed — ${err.message}`);
                    if (abortOnTinyFishLimit && err.code === 'TINYFISH_LIMIT') {
                        limitWarnings.push(`TinyFish: rate/quota limit — scan stopped early (${err.message})`);
                    }
                    if (err.code === 'JOB_HUNT_LLM_EXHAUSTED') {
                        limitWarnings.push(...this.llm.takeLimitWarnings());
                        limitWarnings.push(`LLM: all providers exhausted — ${err.message}`);
                    }
                }
            } else {
                const companies = this.companies.slice(0, maxCompanies || this.companies.length);
                for (let i = 0; i < companies.length; i++) {
                    const company = companies[i];
                    try {
                        onProgress?.(`Scanning ${company.name} (${i + 1}/${companies.length})…`);
                        logger.info(`JobHunt [${i + 1}/${companies.length}] ${company.name}`);
                        let newJobs = await this.discoverCompany(company, seenUrls, candidate);
                        if (!newJobs.length) continue;
                        const n = await this._scoreAndCollect(
                            newJobs,
                            seenUrls,
                            resume,
                            candidate,
                            allScored,
                            limitWarnings,
                        );
                        if (n > 0) sourcesWithJobs += 1;
                    } catch (err) {
                        const msg = `${company.name}: ${err.message}`;
                        errors.push(msg);
                        logger.error(`JobHunt company failed — ${msg}`);
                        if (abortOnTinyFishLimit && err.code === 'TINYFISH_LIMIT') {
                            limitWarnings.push(`TinyFish: rate/quota limit — scan stopped early (${err.message})`);
                            errors.push('TinyFish rate limit — scan stopped early');
                            break;
                        }
                        if (err.code === 'JOB_HUNT_LLM_EXHAUSTED') {
                            limitWarnings.push(...this.llm.takeLimitWarnings());
                            limitWarnings.push(`LLM: all providers exhausted — ${err.message}`);
                            errors.push('All LLMs exhausted — scan stopped early');
                            break;
                        }
                    }
                }
            }

            const minScore = candidate.minScore ?? 60;
            const topN = candidate.topN ?? 5;
            const scanDate = startedAt.toISOString().slice(0, 10);
            const passing = allScored
                .filter((j) => (j.score || 0) >= minScore)
                .sort((a, b) => (b.score || 0) - (a.score || 0));

            if (passing.length) {
                await this._jobs.insertMany(
                    passing.map((j) => ({
                        ...j,
                        scan_date: scanDate,
                        mode,
                        created_at: new Date(),
                    })),
                );
            }

            const topJobs = passing.slice(0, topN);
            limitWarnings.push(...this.llm.takeLimitWarnings());
            const uniqueWarnings = [...new Set(limitWarnings)];

            await this._runs.updateOne(
                { started_at: startedAt },
                {
                    $set: {
                        status: 'done',
                        finished_at: new Date(),
                        jobs_found: passing.length,
                        top_count: topJobs.length,
                        companies_with_jobs: sourcesWithJobs,
                        errors,
                        limit_warnings: uniqueWarnings,
                    },
                },
            );

            return {
                topJobs,
                allJobs: passing,
                errors,
                limitWarnings: uniqueWarnings,
                companiesScanned: sourceTotal,
                companiesWithJobs: sourcesWithJobs,
                scanDate,
                mode,
            };
        } catch (err) {
            await this._runs.updateOne(
                { started_at: startedAt },
                { $set: { status: 'failed', finished_at: new Date(), error: err.message } },
            );
            throw err;
        } finally {
            this._scanning = false;
        }
    }

    async getLatestTop(limit = 5) {
        return this._jobs.find({ dead: { $ne: true } }).sort({ created_at: -1, score: -1 }).limit(limit).toArray();
    }

    async getLatestScanJobs(limit = 20) {
        const latest = await this._jobs.findOne({ dead: { $ne: true } }, { sort: { created_at: -1 } });
        if (!latest?.scan_date) {
            const any = await this._jobs.findOne({}, { sort: { created_at: -1 } });
            if (!any?.scan_date) return [];
            return this._jobs
                .find({ scan_date: any.scan_date, dead: { $ne: true } })
                .sort({ score: -1 })
                .limit(limit)
                .toArray();
        }
        return this._jobs
            .find({ scan_date: latest.scan_date, dead: { $ne: true } })
            .sort({ score: -1 })
            .limit(limit)
            .toArray();
    }

    async revalidateJobs(jobs = []) {
        if (!jobs.length || !this.tf.isConfigured()) return jobs;
        const live = [];
        const deadIds = [];
        const deadUrls = [];

        for (let i = 0; i < jobs.length; i += 10) {
            const batch = jobs.slice(i, i + 10);
            let resp;
            try {
                resp = await this.tf.getContents(
                    batch.map((j) => j.url),
                    { format: 'markdown' },
                );
            } catch (err) {
                logger.warn(`JobHunt revalidate fetch failed: ${err.message}`);
                return jobs;
            }
            for (const job of batch) {
                const r = resultForUrl(resp.results, job.url);
                const text = r?.text ? String(r.text) : '';
                const title = r?.title || job.title || '';
                const statusCode = r?.status_code ?? r?.status ?? null;
                // LinkedIn/Naukri often login-wall — keep if we already scored it and page isn't clearly 404
                const clearlyDead = isDeadJobPage(text, title, statusCode);
                if (clearlyDead && !(job.snippet || job.content)) {
                    if (job._id) deadIds.push(job._id);
                    if (job.url) deadUrls.push(job.url);
                    logger.info(`JobHunt revalidate drop: ${job.company} — ${job.url}`);
                    continue;
                }
                if (clearlyDead && text.trim().length > 0 && !/(naukri|indeed|linkedin)/i.test(job.url || '')) {
                    if (job._id) deadIds.push(job._id);
                    if (job.url) deadUrls.push(job.url);
                    continue;
                }
                live.push(job);
            }
        }

        if (deadIds.length) {
            await this._jobs.updateMany({ _id: { $in: deadIds } }, { $set: { dead: true, dead_at: new Date() } });
        }
        if (deadUrls.length) await this.markSeen(deadUrls);
        return live;
    }
}

export default JobHuntScanner;
