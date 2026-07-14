/**
 * Normalize scraped resume text + detect section/header structure for layout-locked export.
 */

const KNOWN_SECTIONS = [
    'PROFILE SUMMARY',
    'PROFESSIONAL SUMMARY',
    'SUMMARY',
    'OBJECTIVE',
    'TECHNICAL SKILLS',
    'SKILLS',
    'CORE COMPETENCIES',
    'PROFESSIONAL EXPERIENCE',
    'WORK EXPERIENCE',
    'EXPERIENCE',
    'EMPLOYMENT',
    'PROJECTS',
    'EDUCATION',
    'CERTIFICATIONS',
    'CERTIFICATION',
    'ACHIEVEMENTS',
    'AWARDS',
    'LANGUAGES',
    'INTERESTS',
    'PUBLICATIONS',
];

/** Fix common pdf-parse merges: PROFILESUMMARY → PROFILE SUMMARY */
export function normalizeResumeExtract(raw) {
    let text = String(raw || '').replace(/\r\n/g, '\n');

    // Longest multi-word first — only unjam concatenations like PROFILESUMMARY
    // (never rewrite a lone SUMMARY inside PROFILE SUMMARY)
    const sectionsLongFirst = [...KNOWN_SECTIONS]
        .filter((s) => s.includes(' '))
        .sort((a, b) => b.length - a.length);
    for (const section of sectionsLongFirst) {
        const jammed = section.replace(/\s+/g, '');
        text = text.replace(new RegExp(jammed, 'gi'), `\n${section}\n`);
    }

    // Title stuck to month: Software EngineerJul 2023
    text = text.replace(
        /\b(Engineer|Developer|Intern|Manager|Analyst|Consultant|Lead|Architect|Scientist|Designer|Specialist)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/gi,
        '$1\t$2'
    );

    // Company|Meta City jammed
    text = text.replace(/\|/g, ' | ');
    text = text.replace(/\s+\|\s+/g, ' | ');

    // Bullet jammed only at line start: –Developed → – Developed
    text = text.replace(/(^|\n)([–—\-\u2022•])([A-Za-z])/g, '$1$2 $3');

    // Skills jammed: Languages:Python → Languages: Python
    text = text.replace(/([A-Za-z][A-Za-z /&+]+):([A-Za-z0-9])/g, '$1: $2');

    return text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

export function extractSectionTitles(text) {
    const titles = [];
    for (const line of String(text || '').split('\n')) {
        const t = line.trim().replace(/:$/, '');
        if (!t) continue;
        const match = KNOWN_SECTIONS.find((s) => s === t.toUpperCase());
        if (match) titles.push(match);
    }
    return [...new Set(titles)];
}

export function extractHeaderLines(text) {
    const lines = String(text || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const header = [];
    for (const line of lines.slice(0, 6)) {
        const upper = line.toUpperCase().replace(/:$/, '');
        if (KNOWN_SECTIONS.includes(upper) || (line === line.toUpperCase() && line.length > 8 && !line.includes('|'))) {
            break;
        }
        header.push(line);
        if (header.length >= 4) break;
    }
    return header;
}

/**
 * Build LAYOUT LOCK instructions from the user's base resume.
 * @param {string} baseText
 */
export function buildLayoutLockBlock(baseText) {
    const normalized = normalizeResumeExtract(baseText);
    const sections = extractSectionTitles(normalized);
    const header = extractHeaderLines(normalized);

    return [
        'LAYOUT LOCK (must follow — output PDF keeps this format):',
        '- Keep name + contact / location lines identical to BASE (do not rewrite contact details).',
        '- Keep the SAME section titles and SAME section ORDER as BASE.',
        sections.length
            ? `- Section titles in order: ${sections.join(' → ')}`
            : '- Keep whatever section titles appear in BASE verbatim.',
        header.length ? `- Header lines to keep: ${header.map((h) => JSON.stringify(h)).join(' | ')}` : '',
        '- Skills: keep "Category: items" lines if BASE uses that style.',
        '- Experience: keep "Job Title <tab or spaces> Dates" on one line, company/location on the next, then – bullets.',
        '- Do not invent new sections; do not drop existing sections from BASE.',
        '- Plain text only. Section titles alone on their own lines (exact casing as BASE).',
    ]
        .filter(Boolean)
        .join('\n');
}
