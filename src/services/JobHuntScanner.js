/**
 * Job discovery + LLM scoring (ported from autopilot-jobhunt, Node).
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

const DEFAULT_SENIORITY = 'senior OR staff OR principal OR lead';
const DEFAULT_KEYWORDS =
    '"data scientist" OR "ML engineer" OR "machine learning engineer" OR "AI engineer" OR MLOps OR "deep learning" OR "software engineer" OR backend OR fullstack';

const SCORE_PROMPT = `You are evaluating job postings for a candidate. Output ONLY a JSON array, no other text.

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
Set worth_applying=true only if score >= {min_score}.
Include ALL jobs. Output ONLY the JSON array.`;

function isJobUrl(url) {
    return JOB_URL_RE.test(url) || ATS_JOB_RE.test(url);
}

function isAtsListing(url) {
    return ATS_LISTING_RE.test(url);
}

function loadCompanies() {
    const path = resolve(__dirname, '../data/jobHuntCompanies.json');
    return JSON.parse(readFileSync(path, 'utf8'));
}

function buildCandidateProfile(candidate = {}) {
    const lines = [`- ${candidate.name || 'Candidate'}`];
    if (candidate.profile) lines.push(`- ${candidate.profile}`);
    if (candidate.seeking) lines.push(`- Seeking: ${candidate.seeking}`);
    if (candidate.notSuitable) lines.push(`- NOT suitable: ${candidate.notSuitable}`);
    return lines.join('\n');
}

function buildSearchQuery(domain, candidate = {}) {
    const seniority = candidate.searchSeniority || DEFAULT_SENIORITY;
    const keywords = candidate.searchKeywords || DEFAULT_KEYWORDS;
    return `site:${domain} (${seniority}) (${keywords})`;
}

function parseJsonArray(raw) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']') + 1;
    if (start < 0 || end <= start) return [];
    return JSON.parse(raw.slice(start, end));
}

/** Closed / 404 ATS pages (Lever, Greenhouse, etc.) */
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
        /sorry,? we couldn.?t find/.test(blob)
    );
}

function resultForUrl(results, url) {
    const list = results || [];
    const exact = list.find((r) => r.url === url || r.final_url === url || r.request_url === url);
    if (exact) return exact;
    // TinyFish sometimes returns only final_url after redirects
    const path = String(url).replace(/\/$/, '');
    return list.find((r) => {
        const u = String(r.url || r.final_url || '').replace(/\/$/, '');
        return u === path || u.endsWith(path.split('/').slice(-2).join('/'));
    });
}

export class JobHuntScanner {
    constructor(config, mongoDb) {
        this.config = config;
        this.mongoDb = mongoDb;
        this.tf = new TinyFishClient(config.TINYFISH_API_KEY, {
            fetchDelayMs: config.JOB_HUNT_FETCH_DELAY_MS || 2500,
            searchDelayMs: config.JOB_HUNT_SEARCH_DELAY_MS || 13000,
        });
        this.llm = new JobHuntLlmService(config);
        this.companies = loadCompanies();
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
        logger.info(`Job hunt scanner ready (${this.companies.length} companies)`);
    }

    isBusy() {
        return this._scanning;
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
            title: url.split('/').pop()?.replace(/[-_]/g, ' ') || 'Role',
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
                // Need real JD text to score — skip empty shells
                if (text.trim().length < 80) {
                    deadUrls.push(job.url);
                    continue;
                }

                job.content = text.slice(0, 3000);
                job.title = title || job.title;
                if (r.final_url && r.final_url !== job.url) job.url = r.final_url;
                enriched.push(job);
            }
        }
        // Remember dead links so search doesn't keep rediscovering them
        if (deadUrls.length) await this.markSeen(deadUrls);
        return enriched;
    }

    async scoreJobs(jobs, resume, candidate) {
        if (!jobs.length) return [];
        const minScore = candidate.minScore ?? 60;
        const jobsText = jobs
            .map(
                (j, i) =>
                    `JOB ${i + 1}:\nCompany: ${j.company} | Location: ${j.location}\n` +
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

    /**
     * Full or partial scan. Calls onProgress optionally.
     */
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
        const companies = this.companies.slice(0, maxCompanies || this.companies.length);
        const seenUrls = await this.getSeenUrls();
        const allScored = [];
        const errors = [];
        const limitWarnings = [];
        let companiesWithJobs = 0;

        await this._runs.insertOne({
            started_at: startedAt,
            status: 'running',
            company_total: companies.length,
        });

        try {
            for (let i = 0; i < companies.length; i++) {
                const company = companies[i];
                try {
                    onProgress?.(`Scanning ${company.name} (${i + 1}/${companies.length})…`);
                    logger.info(`JobHunt [${i + 1}/${companies.length}] ${company.name}`);

                    let newJobs = await this.discoverCompany(company, seenUrls, candidate);
                    if (!newJobs.length) continue;

                    newJobs = await this.fetchDetails(newJobs);
                    await this.markSeen(newJobs.map((j) => j.url));
                    newJobs.forEach((j) => seenUrls.add(j.url));

                    const scored = [];
                    for (let b = 0; b < newJobs.length; b += 10) {
                        const batch = newJobs.slice(b, b + 10);
                        const batchScored = await this.scoreJobs(batch, resume, candidate);
                        scored.push(...batchScored);
                        limitWarnings.push(...this.llm.takeLimitWarnings());
                    }

                    if (scored.length) {
                        companiesWithJobs += 1;
                        allScored.push(...scored);
                    }
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
                        companies_with_jobs: companiesWithJobs,
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
                companiesScanned: companies.length,
                companiesWithJobs,
                scanDate,
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
        return this._jobs.find({}).sort({ created_at: -1, score: -1 }).limit(limit).toArray();
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

    /**
     * Re-fetch JD pages and drop closed/404 links (also marks them dead in Mongo).
     */
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
                return jobs; // keep list if TinyFish is down
            }
            for (const job of batch) {
                const r = resultForUrl(resp.results, job.url);
                const text = r?.text ? String(r.text) : '';
                const title = r?.title || job.title || '';
                const statusCode = r?.status_code ?? r?.status ?? null;
                if (!r || isDeadJobPage(text, title, statusCode) || text.trim().length < 80) {
                    if (job._id) deadIds.push(job._id);
                    if (job.url) deadUrls.push(job.url);
                    logger.info(`JobHunt revalidate drop: ${job.company} — ${job.url}`);
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
