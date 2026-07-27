/**
 * Self-check: ATS normalize + report formatting (no LLM).
 * Run: node scripts/check-resume-ats.js
 */
import assert from 'assert';
import AssistLlmRouter from '../src/services/AssistLlmRouter.js';
import { normalizeAtsResult, formatAtsReport } from '../src/services/ResumeAtsService.js';
import { buildAtsUserBlock } from '../src/prompts/resumeAtsPrompt.js';

const sample = {
    overallScore: 150,
    verdict: 'Solid mid-level profile',
    interviewReady: true,
    atsLayout: 'ats',
    scores: {
        parseability: 88,
        contactInfo: 90,
        sectionStructure: 80,
        summary: 70,
        skills: 75,
        experienceImpact: 65,
        chronology: 85,
        education: 80,
        measurableAchievements: 55,
    },
    strengths: ['Clear contact block', 'Relevant stack listed'],
    redFlags: ['Few quantified outcomes'],
    missingSections: [],
    formattingRisks: ['Tables may confuse parsers'],
    weakBullets: ['Responsible for various tasks'],
    suggestedKeywords: ['REST APIs', 'Node.js', 'MongoDB'],
    fixes: {
        critical: ['Add metrics to 3 top bullets'],
        important: ['Tighten summary to 4 lines'],
        optional: ['Move older roles shorter'],
    },
    jobMatch: {
        matchScore: -5,
        shortlistLikely: false,
        matchedKeywords: ['Node.js'],
        missingKeywords: ['Kubernetes'],
        requirementGaps: ['No cloud orchestration evidence'],
        notes: 'Close on backend core; weak on infra.',
    },
    summary: 'Readable ATS-style resume with room for stronger impact bullets.',
};

const general = normalizeAtsResult({ ...sample, jobMatch: null }, { hasJd: false });
assert.equal(general.overallScore, 100, 'overallScore clamped to 100');
assert.equal(general.jobMatch, null);

const withJd = normalizeAtsResult(sample, { hasJd: true });
assert.equal(withJd.jobMatch.matchScore, 0, 'matchScore clamped from -5');
assert.equal(withJd.jobMatch.shortlistLikely, false);

const report = formatAtsReport(withJd, { fileName: 'cv.pdf', hasJd: true });
assert.match(report, /ATS \/ RECRUITER SCAN/);
assert.match(report, /Overall ATS readiness:\* 100\/100/);
assert.match(report, /JD match:\* 0\/100/);
assert.match(report, /Critical fixes/);
assert.match(report, /Kubernetes/);

const block = buildAtsUserBlock('A'.repeat(50) + '\nPROFILE SUMMARY\nBuilt APIs', 'Need Node.js and Kubernetes experience for backend role');
assert.match(block, /===RESUME===/);
assert.match(block, /===JOB_DESCRIPTION===/);
assert.match(block, /MODE: general ATS \+ JD match/);

const blockNoJd = buildAtsUserBlock('A'.repeat(50) + '\nSKILLS\nNode');
assert.match(blockNoJd, /jobMatch to null/);

// OpenRouter always appended as last-resort when keyed, even if omitted from provider list
const router = new AssistLlmRouter({
    ASSIST_LLM_PROVIDERS: 'gemini,groq',
    GEMINI_API_KEY: '',
    GROQ_API_KEY: '',
    NVIDIA_API_KEY: '',
    OPENROUTER_API_KEY: 'test-or-key',
    OPENROUTER_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
});
assert.ok(router.providerOrder.includes('openrouter'), 'openrouter should be last-resort');
assert.deepEqual(
    router.providerOrder.filter((p) => p === 'openrouter'),
    ['openrouter'],
    'openrouter should appear once'
);

console.log('OK resume ATS normalize + format');
