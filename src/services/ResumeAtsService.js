/**
 * ATS / recruiter resume analysis via AssistLlmRouter.
 */

import AssistLlmRouter from './AssistLlmRouter.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { extractJsonObject } from '../interviewQuestion/interviewQuestion.service.js';
import { RESUME_ATS_SYSTEM_PROMPT, buildAtsUserBlock } from '../prompts/resumeAtsPrompt.js';

function clampScore(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
}

function asStringList(v, max = 12) {
    if (!Array.isArray(v)) return [];
    return v
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, max);
}

function asBool(v, fallback = false) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1 || v === '1') return true;
    if (v === 'false' || v === 0 || v === '0') return false;
    return fallback;
}

/**
 * Validate + clamp model output into a stable report object.
 * @param {object} raw
 * @param {{ hasJd?: boolean }} opts
 */
export function normalizeAtsResult(raw, { hasJd = false } = {}) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Invalid ATS analysis object');
    }

    const scoresIn = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
    const scores = {
        parseability: clampScore(scoresIn.parseability, 50),
        contactInfo: clampScore(scoresIn.contactInfo, 50),
        sectionStructure: clampScore(scoresIn.sectionStructure, 50),
        summary: clampScore(scoresIn.summary, 50),
        skills: clampScore(scoresIn.skills, 50),
        experienceImpact: clampScore(scoresIn.experienceImpact, 50),
        chronology: clampScore(scoresIn.chronology, 50),
        education: clampScore(scoresIn.education, 50),
        measurableAchievements: clampScore(scoresIn.measurableAchievements, 50),
    };

    let overallScore = clampScore(raw.overallScore, NaN);
    if (!Number.isFinite(overallScore)) {
        const vals = Object.values(scores);
        overallScore = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    const layout = String(raw.atsLayout || 'unknown').toLowerCase();
    const atsLayout = layout === 'ats' || layout === 'classic' ? layout : 'unknown';

    const fixesIn = raw.fixes && typeof raw.fixes === 'object' ? raw.fixes : {};
    const fixes = {
        critical: asStringList(fixesIn.critical, 8),
        important: asStringList(fixesIn.important, 8),
        optional: asStringList(fixesIn.optional, 8),
    };

    let jobMatch = null;
    if (hasJd && raw.jobMatch && typeof raw.jobMatch === 'object') {
        jobMatch = {
            matchScore: clampScore(raw.jobMatch.matchScore, 0),
            shortlistLikely: asBool(raw.jobMatch.shortlistLikely, false),
            matchedKeywords: asStringList(raw.jobMatch.matchedKeywords, 16),
            missingKeywords: asStringList(raw.jobMatch.missingKeywords, 16),
            requirementGaps: asStringList(raw.jobMatch.requirementGaps, 10),
            notes: String(raw.jobMatch.notes || '').trim().slice(0, 600),
        };
    }

    return {
        overallScore,
        verdict: String(raw.verdict || 'Needs work').trim().slice(0, 200) || 'Needs work',
        interviewReady: asBool(raw.interviewReady, overallScore >= 70),
        atsLayout,
        scores,
        strengths: asStringList(raw.strengths, 8),
        redFlags: asStringList(raw.redFlags, 8),
        missingSections: asStringList(raw.missingSections, 8),
        formattingRisks: asStringList(raw.formattingRisks, 8),
        weakBullets: asStringList(raw.weakBullets, 6),
        suggestedKeywords: asStringList(raw.suggestedKeywords, 16),
        fixes,
        jobMatch,
        summary: String(raw.summary || '').trim().slice(0, 900),
    };
}

function scoreEmoji(n) {
    if (n >= 80) return '🟢';
    if (n >= 60) return '🟡';
    return '🔴';
}

function bulletBlock(title, items, limit = 5) {
    const list = (items || []).slice(0, limit);
    if (!list.length) return '';
    return `*${title}*\n${list.map((x) => `• ${x}`).join('\n')}\n\n`;
}

/**
 * WhatsApp-friendly recruiter report.
 * @param {ReturnType<typeof normalizeAtsResult>} analysis
 * @param {{ fileName?: string, hasJd?: boolean }} meta
 */
export function formatAtsReport(analysis, { fileName = '', hasJd = false } = {}) {
    const a = analysis;
    const lines = [];
    lines.push('┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓');
    lines.push('┃    📋 *ATS / RECRUITER SCAN* ┃');
    lines.push('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛');
    lines.push('');
    if (fileName) lines.push(`📄 _${fileName}_`);
    lines.push(`${scoreEmoji(a.overallScore)} *Overall ATS readiness:* ${a.overallScore}/100`);
    lines.push(`🗣️ *Verdict:* ${a.verdict}`);
    lines.push(`🎯 *Interview-ready:* ${a.interviewReady ? 'Yes' : 'Not yet'}`);
    lines.push(`📐 *Layout family:* ${a.atsLayout}`);
    lines.push('');

    lines.push('*Score breakdown*');
    const s = a.scores;
    lines.push(`• Parseability ${s.parseability} · Contact ${s.contactInfo} · Structure ${s.sectionStructure}`);
    lines.push(`• Summary ${s.summary} · Skills ${s.skills} · Impact ${s.experienceImpact}`);
    lines.push(`• Chronology ${s.chronology} · Education ${s.education} · Metrics ${s.measurableAchievements}`);
    lines.push('');

    if (a.summary) {
        lines.push(`*Recruiter summary*\n${a.summary}`);
        lines.push('');
    }

    lines.push(bulletBlock('Strengths', a.strengths));
    lines.push(bulletBlock('Red flags', a.redFlags));
    lines.push(bulletBlock('Missing sections', a.missingSections));
    lines.push(bulletBlock('Formatting risks', a.formattingRisks));
    lines.push(bulletBlock('Weak / generic bullets', a.weakBullets, 4));

    if (a.fixes.critical.length) lines.push(bulletBlock('🚨 Critical fixes', a.fixes.critical));
    if (a.fixes.important.length) lines.push(bulletBlock('⚠️ Important fixes', a.fixes.important));
    if (a.fixes.optional.length) lines.push(bulletBlock('💡 Optional polish', a.fixes.optional));

    if (a.suggestedKeywords.length) {
        lines.push(`*Suggested keywords*\n${a.suggestedKeywords.slice(0, 12).join(', ')}`);
        lines.push('');
    }

    if (hasJd && a.jobMatch) {
        const j = a.jobMatch;
        lines.push('─────────────────────────────');
        lines.push(`${scoreEmoji(j.matchScore)} *JD match:* ${j.matchScore}/100`);
        lines.push(`📌 *Shortlist likely:* ${j.shortlistLikely ? 'Yes' : 'Unlikely'}`);
        if (j.notes) lines.push(j.notes);
        lines.push('');
        if (j.matchedKeywords.length) {
            lines.push(`*Matched:* ${j.matchedKeywords.slice(0, 12).join(', ')}`);
            lines.push('');
        }
        lines.push(bulletBlock('Missing vs JD', j.missingKeywords, 10));
        lines.push(bulletBlock('Requirement gaps', j.requirementGaps, 8));
    }

    lines.push('─────────────────────────────');
    lines.push('_Rubric estimate for education — not a vendor ATS guarantee._');
    lines.push('Next: `/resume` to rewrite for a JD · `/tailor` if profile saved');

    return lines.filter((x) => x !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export default class ResumeAtsService {
    constructor(cfg = config, resumeStore = null) {
        this.cfg = cfg;
        this.resumeStore = resumeStore;
        this.llm = new AssistLlmRouter(cfg);
    }

    isConfigured() {
        return this.llm.isConfigured();
    }

    /**
     * @param {{ resumeText: string, jobDescription?: string }} opts
     */
    async analyze({ resumeText, jobDescription = '' }) {
        if (!this.isConfigured()) {
            throw new Error('No LLM configured (set GEMINI / GROQ / NVIDIA / OPENROUTER key)');
        }
        const base = String(resumeText || '').trim();
        if (base.length < 40) {
            throw new Error('Resume text too short for ATS scan');
        }

        const jd = String(jobDescription || '').trim();
        const hasJd = jd.length >= 20;

        const { text, provider, model } = await this.llm.completeChat({
            systemPrompt: RESUME_ATS_SYSTEM_PROMPT,
            history: [],
            userBlock: buildAtsUserBlock(base, hasJd ? jd : ''),
            maxTokens: 3500,
            temperature: 0.25,
            maxChars: 24_000,
        });

        const parsed = extractJsonObject(text);
        const analysis = normalizeAtsResult(parsed, { hasJd });
        logger.info(
            `Resume ATS scan via ${provider}/${model} · overall ${analysis.overallScore}` +
                (hasJd ? ` · JD match ${analysis.jobMatch?.matchScore}` : '')
        );
        return { analysis, provider, model, hasJd };
    }

    /**
     * OCR fallback for scanned PDFs / image resumes via Gemini.
     * @param {{ buffer: Buffer, fileName?: string, mimetype?: string }} opts
     */
    async ocrResume({ buffer, fileName = '', mimetype = '' }) {
        if (!this.llm.geminiKey) {
            throw new Error(
                'Could not extract text locally, and Gemini OCR is unavailable (set GEMINI_API_KEY).'
            );
        }
        let mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
        if (!mime || mime === 'application/octet-stream') {
            const name = String(fileName || '').toLowerCase();
            if (name.endsWith('.png')) mime = 'image/png';
            else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
            else if (name.endsWith('.webp')) mime = 'image/webp';
            else if (Buffer.isBuffer(buffer)) {
                if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') mime = 'application/pdf';
                else if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg';
                else if (buffer[0] === 0x89 && buffer[1] === 0x50) mime = 'image/png';
                else mime = 'application/pdf';
            } else {
                mime = 'application/pdf';
            }
        }

        const { text, provider, model } = await this.llm.extractMediaText({
            buffer,
            mimeType: mime,
            maxChars: 80_000,
        });
        const cleaned = String(text || '').trim();
        if (cleaned.length < 40) {
            throw new Error('OCR returned too little text from that resume');
        }
        logger.info(`Resume OCR via ${provider}/${model} · ${cleaned.length} chars`);
        return { text: cleaned, kind: 'ocr', provider, model };
    }
}
