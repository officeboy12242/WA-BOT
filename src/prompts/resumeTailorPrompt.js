/**
 * Prompts for full-resume JD rewrite (two modes: exact vs related).
 * Layout locked to base resume section order/titles for PDF format match.
 */

import { buildLayoutLockBlock } from '../utils/resumeStructure.js';

export function buildResumeTailorSystemPrompt(mode = 'related') {
    const exact = mode === 'exact';

    const sharedRules = [
        'HARD FACTS (never break):',
        '- Keep real employers, companies, schools, degree names, and employment/education dates from the BASE RESUME.',
        '- Do NOT invent employers, companies, degrees, certifications, or employment periods that are absent from the base resume.',
        '- Tools/skills the candidate never had go ONLY in ===GAPS=== — never fake them into Experience.',
        '',
        'OUTPUT SCOPE:',
        '- Rewrite the COMPLETE resume end-to-end (summary, skills, every role, projects, education, certifications).',
        '- Never only edit the overview.',
        '- Prefer concrete bullets (action + scope + outcome).',
        '- Plain text only (no markdown).',
        '',
        'FORMAT / LAYOUT (critical for PDF export):',
        '- Obey the LAYOUT LOCK block in the user message.',
        '- Preserve BASE section titles and order exactly (including custom / non-English names — never force a fixed English outline).',
        '- Preserve name + contact/location header exactly.',
        '- Skills as "Category: items" lines when BASE uses that.',
        '- Experience roles: "Job Title<TAB>Month Year – Month Year" then company line, then – bullets — only if BASE uses that pattern; otherwise mirror BASE.',
        '',
        'Respond with exactly these sections and headings:',
        '===TAILORED_RESUME===',
        '(full resume body — all sections, layout-locked)',
        '===GAPS===',
        '(bullet list of JD must-haves not evidenced in BASE; or "None")',
        '===KEYWORDS===',
        '(comma-separated JD keywords woven through the rewrite)',
    ];

    if (exact) {
        return [
            'You completely rewrite resumes so the WHOLE document matches a job description as closely as possible.',
            'MODE: EXACT — maximum JD match, same visual structure as BASE.',
            '',
            'GOALS:',
            '- Mirror JD wording wherever BASE facts support it.',
            '- Reframe titles toward JD-aligned titles ONLY when BASE work scope supports it.',
            '- Rewrite nearly every experience bullet.',
            '- Missing requirements go in GAPS only.',
            '',
            ...sharedRules,
        ].join('\n');
    }

    return [
        'You fully rewrite resumes so the WHOLE document is strongly related to a job description.',
        'MODE: RELATED — thorough natural alignment, same visual structure as BASE.',
        '',
        'GOALS:',
        '- Rewrite all sections to relate clearly to the JD.',
        '- Emphasize transferable work; demote unrelated fluff.',
        '- Keep voice professional and believable.',
        '',
        ...sharedRules,
    ].join('\n');
}

export function buildCoverLetterSystemPrompt() {
    return [
        'Write a short professional cover letter for WhatsApp delivery.',
        'HARD RULES:',
        '- Ground every claim in the BASE RESUME and JOB DESCRIPTION.',
        '- Do not invent experience, metrics, or employers.',
        '- 250–400 words, plain text, no markdown headers.',
        'Respond with only the letter body.',
    ].join('\n');
}

export function buildTailorUserBlock(baseResume, jobDescription, mode = 'related') {
    const modeLine =
        mode === 'exact'
            ? 'REWRITE MODE: EXACT — full JD match, keep BASE layout/format locks.'
            : 'REWRITE MODE: RELATED — full related rewrite, keep BASE layout/format locks.';

    return [
        modeLine,
        '',
        buildLayoutLockBlock(baseResume),
        '',
        'BASE RESUME:',
        '---',
        String(baseResume || '').slice(0, 60_000),
        '---',
        '',
        'JOB DESCRIPTION:',
        '---',
        String(jobDescription || '').slice(0, 20_000),
        '---',
        '',
        'Produce the full layout-locked rewritten resume under ===TAILORED_RESUME=== now.',
    ].join('\n');
}

/** @returns {'exact'|'related'|null} */
export function parseRewriteMode(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^(1|exact|full|complete|max|e)\b/.test(t) || t === 'exact as per jd' || t.includes('exact')) {
        return 'exact';
    }
    if (/^(2|related|relatable|relate|soft|r)\b/.test(t) || t.includes('relat')) {
        return 'related';
    }
    return null;
}

/** @returns {'txt'|'pdf'|null} */
export function parseExportFormat(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^(1|txt|text|plain)\b/.test(t) || t === 'txt') {
        return 'txt';
    }
    if (/^(2|pdf)\b/.test(t) || t === 'pdf' || t.includes('pdf')) {
        return 'pdf';
    }
    // avoid matching "related" via includes('text')
    if (t.includes('text') && !t.includes('related')) {
        return 'txt';
    }
    return null;
}
