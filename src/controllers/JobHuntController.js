/**
 * Job Hunt controller — nightly scan + WhatsApp alerts (owner DM + groups).
 */

import { logger } from '../utils/logger.js';
import { JobHuntScanner } from '../services/JobHuntScanner.js';
import { TinyFishClient } from '../services/TinyFishClient.js';
import { JobHuntLlmService } from '../services/JobHuntLlmService.js';
import {
    formatJobHuntDigest,
    formatJobHuntLimitAlert,
    formatJobHuntDraft,
    formatJobHuntStatus,
} from '../utils/jobHuntFormatter.js';
import { normalizePhoneNumber } from '../utils/permissions.js';

class JobHuntController {
    constructor(groupManager, config, mongoDb, botSettings = null) {
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.botSettings = botSettings;
        this.scanner = new JobHuntScanner(config, mongoDb);
        this._sock = null;
        this.enabled = config.JOB_HUNT_ENABLED !== false;
    }

    async init() {
        await this.scanner.init();
        logger.info('Job hunt controller ready');
    }

    setSock(sock) {
        this._sock = sock;
    }

    getCandidate() {
        return {
            name: this.config.JOB_HUNT_CANDIDATE_NAME || 'Candidate',
            profile: this.config.JOB_HUNT_PROFILE || '',
            seeking: this.config.JOB_HUNT_SEEKING || 'Remote / hybrid tech roles',
            notSuitable: this.config.JOB_HUNT_NOT_SUITABLE || 'Pure junior / non-technical',
            searchSeniority: this.config.JOB_HUNT_SEARCH_SENIORITY || '',
            searchKeywords: this.config.JOB_HUNT_SEARCH_KEYWORDS || '',
            minScore: this.config.JOB_HUNT_MIN_SCORE || 60,
            topN: this.config.JOB_HUNT_TOP_N || 5,
            relocationNote: this.config.JOB_HUNT_RELOCATION_NOTE || '',
        };
    }

    async getResumeText() {
        if (this.botSettings?.getJobHuntResume) {
            const stored = await this.botSettings.getJobHuntResume();
            if (stored?.trim()) return stored.trim();
        }
        return (
            this.config.JOB_HUNT_RESUME ||
            `# ${this.getCandidate().name}\n\n${this.getCandidate().profile || 'Experienced engineer.'}\n\n` +
                `_Set full resume with /jobhunt resume <text> or JOB_HUNT_RESUME env._`
        );
    }

    async isOwnerDmEnabled() {
        if (this.botSettings?.getJobHuntDmEnabled) {
            const v = await this.botSettings.getJobHuntDmEnabled();
            if (v != null) return v;
        }
        return this.config.JOB_HUNT_OWNER_DM !== false;
    }

    async setOwnerDmEnabled(enabled) {
        if (this.botSettings?.setJobHuntDmEnabled) {
            await this.botSettings.setJobHuntDmEnabled(enabled);
        }
    }

    _ownerJids() {
        return (this.config.OWNER_NUMBERS || [])
            .map((n) => normalizePhoneNumber(String(n)))
            .filter(Boolean)
            .map((n) => `${n}@s.whatsapp.net`);
    }

    async _broadcast(sock, text) {
        const targets = [];
        if (await this.isOwnerDmEnabled()) {
            targets.push(...this._ownerJids());
        }
        const groups = await this.groupManager.getJobHuntGroups();
        for (const g of groups) {
            if (g.group_id) targets.push(g.group_id);
        }
        const unique = [...new Set(targets)];
        for (const jid of unique) {
            try {
                await sock.sendMessage(jid, { text });
                await new Promise((r) => setTimeout(r, 600));
            } catch (err) {
                logger.warn(`JobHunt notify failed ${jid}: ${err.message}`);
            }
        }
        return unique.length;
    }

    async runAndNotify(sock = this._sock, { maxCompanies = null } = {}) {
        if (!sock) throw new Error('WhatsApp socket not ready');
        if (!this.enabled) throw new Error('Job hunt disabled (JOB_HUNT_ENABLED=false)');

        const candidate = this.getCandidate();
        const resume = await this.getResumeText();
        const max = maxCompanies ?? this.config.JOB_HUNT_MAX_COMPANIES ?? null;

        await this._broadcast(
            sock,
            `💼 *Job Hunt scan started*\n🏢 Companies: ${max || this.scanner.companies.length}\n_This can take 30–90 min — results will be sent here._`,
        );

        const result = await this.scanner.runScan({
            candidate,
            resume,
            maxCompanies: max,
        });

        if (result.limitWarnings?.length || result.errors?.length) {
            await this._broadcast(
                sock,
                formatJobHuntLimitAlert(result.limitWarnings || [], result.errors || []),
            );
        }

        const digest = formatJobHuntDigest(result.topJobs, { scanDate: result.scanDate });
        const sent = await this._broadcast(sock, digest);
        logger.info(
            `JobHunt done — ${result.topJobs.length} top / ${result.allJobs.length} total → ${sent} chat(s)`,
        );
        return result;
    }

    async draftForIndex(index1Based) {
        const jobs = await this.scanner.getLatestScanJobs(20);
        const idx = Number(index1Based) - 1;
        if (!jobs.length) throw new Error('No scan results yet. Run `/jobhunt scan` first.');
        if (idx < 0 || idx >= jobs.length) {
            throw new Error(`Job #${index1Based} not found (have ${jobs.length} in latest scan).`);
        }
        const job = jobs[idx];
        const candidate = this.getCandidate();
        const resume = await this.getResumeText();

        let jd = job.content || '';
        if (this.config.TINYFISH_API_KEY) {
            try {
                const tf = new TinyFishClient(this.config.TINYFISH_API_KEY);
                const resp = await tf.getContents([job.url], { format: 'markdown' });
                if (resp.results?.[0]?.text) jd = String(resp.results[0].text).slice(0, 4000);
            } catch (err) {
                logger.warn(`JobHunt draft fetch JD failed: ${err.message}`);
            }
        }
        if (!jd) jd = `${job.title}\n${job.reason || ''}\n${job.stack || ''}`;

        const llm = new JobHuntLlmService(this.config);
        const coverRes = await llm.chat({
            user:
                `Write a one-page cover letter for ${candidate.name} applying to this role.\n` +
                `Rules: direct, confident; no "I am excited to apply"; concrete JD fit.\n` +
                (candidate.relocationNote ? `- ${candidate.relocationNote}\n` : '') +
                `\nJOB DESCRIPTION:\n${jd.slice(0, 3500)}\n\nRESUME:\n${resume.slice(0, 2500)}\n\nOutput ONLY the cover letter.`,
            temperature: 0.3,
        });

        const bulletsRes = await llm.chat({
            user:
                `From this resume, write 6–10 tailored bullet points for the JD. Keep facts truthful — no invention.\n` +
                `Output Markdown bullets only.\n\nJD:\n${jd.slice(0, 3000)}\n\nRESUME:\n${resume.slice(0, 2500)}`,
            temperature: 0.2,
        });

        const warnings = llm.takeLimitWarnings();
        return {
            message: formatJobHuntDraft(job, {
                cover: coverRes.text,
                resumeBullets: bulletsRes.text,
                provider: `${coverRes.provider}/${coverRes.model}`,
            }),
            warnings,
            job,
        };
    }

    async getStatus() {
        const groups = await this.groupManager.getJobHuntGroups();
        const dm = await this.isOwnerDmEnabled();
        const lastRun = await this.scanner._runs?.findOne({}, { sort: { started_at: -1 } });
        return formatJobHuntStatus({
            enabledDm: dm,
            groupCount: groups.length,
            companyCount: this.scanner.companies.length,
            minScore: this.getCandidate().minScore,
            topN: this.getCandidate().topN,
            busy: this.scanner.isBusy(),
            lastRun,
        });
    }
}

export default JobHuntController;
