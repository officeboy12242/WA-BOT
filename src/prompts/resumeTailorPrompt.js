/**
 * Prompts for JD-grounded resume rewrite (facts only from saved resume).
 */

export function buildResumeTailorSystemPrompt() {
    return [
        'You rewrite resumes to better match a job description.',
        'HARD RULES:',
        '- Use ONLY facts that appear in the BASE RESUME (employers, titles, dates, education, real skills/projects).',
        '- NEVER invent employers, degrees, dates, metrics, tools, or achievements.',
        '- You MAY rephrase bullets, reorder sections, and emphasize JD-relevant existing skills.',
        '- Skills or requirements missing from the base resume go ONLY in the GAPS section — do not fake them into experience.',
        '- Output plain text suitable for a .txt resume file (no markdown tables).',
        '',
        'Respond with exactly these sections and headings:',
        '===TAILORED_RESUME===',
        '(full resume body)',
        '===GAPS===',
        '(bullet list of JD must-haves not evidenced in the base resume; or "None")',
        '===KEYWORDS===',
        '(comma-separated keywords/phrases mirrored honestly from base resume toward the JD)',
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

export function buildTailorUserBlock(baseResume, jobDescription) {
    return [
        'BASE RESUME:',
        '---',
        String(baseResume || '').slice(0, 60_000),
        '---',
        '',
        'JOB DESCRIPTION:',
        '---',
        String(jobDescription || '').slice(0, 20_000),
        '---',
    ].join('\n');
}
