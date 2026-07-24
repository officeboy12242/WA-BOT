/**
 * ATS / recruiter resume scan prompts — strict JSON, no invented credentials.
 */

import { detectResumeLayoutProfile, extractSectionTitles } from '../utils/resumeStructure.js';

export const RESUME_ATS_SYSTEM_PROMPT = [
    'You are a senior technical recruiter and ATS (Applicant Tracking System) readiness reviewer.',
    'Score the resume using a rubric-based estimate — do NOT claim a specific vendor score (Workday, Greenhouse, etc.).',
    '',
    'HARD RULES:',
    '- Never invent employers, degrees, certifications, metrics, or skills not evidenced in the resume.',
    '- Be direct and practical; prioritize actionable fixes.',
    '- If a JOB DESCRIPTION is provided, also score role-fit; otherwise leave jobMatch null.',
    '- Return ONLY valid JSON matching the schema. No markdown fences, no commentary outside JSON.',
    '',
    'JSON SCHEMA:',
    '{',
    '  "overallScore": 0-100,',
    '  "verdict": "short recruiter verdict",',
    '  "interviewReady": true|false,',
    '  "atsLayout": "ats"|"classic"|"unknown",',
    '  "scores": {',
    '    "parseability": 0-100,',
    '    "contactInfo": 0-100,',
    '    "sectionStructure": 0-100,',
    '    "summary": 0-100,',
    '    "skills": 0-100,',
    '    "experienceImpact": 0-100,',
    '    "chronology": 0-100,',
    '    "education": 0-100,',
    '    "measurableAchievements": 0-100',
    '  },',
    '  "strengths": ["..."],',
    '  "redFlags": ["..."],',
    '  "missingSections": ["..."],',
    '  "formattingRisks": ["..."],',
    '  "weakBullets": ["example weak bullet or pattern"],',
    '  "suggestedKeywords": ["..."],',
    '  "fixes": {',
    '    "critical": ["..."],',
    '    "important": ["..."],',
    '    "optional": ["..."]',
    '  },',
    '  "jobMatch": null | {',
    '    "matchScore": 0-100,',
    '    "shortlistLikely": true|false,',
    '    "matchedKeywords": ["..."],',
    '    "missingKeywords": ["..."],',
    '    "requirementGaps": ["..."],',
    '    "notes": "one short paragraph"',
    '  },',
    '  "summary": "2-4 sentence recruiter summary"',
    '}',
].join('\n');

/**
 * @param {string} resumeText
 * @param {string} [jobDescription]
 */
export function buildAtsUserBlock(resumeText, jobDescription = '') {
    const base = String(resumeText || '').trim().slice(0, 60_000);
    const jd = String(jobDescription || '').trim().slice(0, 20_000);
    const layout = detectResumeLayoutProfile(base);
    const sections = extractSectionTitles(base).slice(0, 20);

    const lines = [
        `DETECTED_LAYOUT: ${layout?.style || 'unknown'} (headerAlign=${layout?.headerAlign || 'n/a'})`,
        `DETECTED_SECTIONS: ${sections.length ? sections.join(' | ') : '(none detected)'}`,
        '',
        '===RESUME===',
        base || '(empty)',
    ];

    if (jd) {
        lines.push('', '===JOB_DESCRIPTION===', jd);
        lines.push('', 'MODE: general ATS + JD match. Fill jobMatch.');
    } else {
        lines.push('', 'MODE: general ATS / recruiter scan only. Set jobMatch to null.');
    }

    return lines.join('\n');
}
