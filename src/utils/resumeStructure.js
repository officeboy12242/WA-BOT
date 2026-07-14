/**
 * Per-user resume structure: discover sections from THEIR upload.
 * Soft DEJAM_HINTS only fix PDF extract merges — not a required outline.
 */

/** Optional PDF-unjam hints only (PROFILESUMMARY → PROFILE SUMMARY). */
const DEJAM_HINTS = [
    'PROFILE SUMMARY',
    'PROFESSIONAL SUMMARY',
    'TECHNICAL SKILLS',
    'CORE COMPETENCIES',
    'PROFESSIONAL EXPERIENCE',
    'WORK EXPERIENCE',
    'KEY PROJECTS',
    'RELEVANT EXPERIENCE',
    'EDUCATION AND TRAINING',
    'CERTIFICATIONS AND LICENSES',
];

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function looksLikeSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

function looksLikeDateish(line) {
    return /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}|\d{4}\s*[–\-—]\s*(?:Present|\d{4}))\b/i.test(
        String(line || '')
    );
}

function isAllCapsHeading(t) {
    const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
    return (
        letters.length >= 3 &&
        t.length <= 52 &&
        t === t.toUpperCase() &&
        /[A-ZÀ-Ÿ]/.test(t) &&
        !/[a-zà-ÿ]/.test(t) &&
        !t.includes('@') &&
        !t.includes('|')
    );
}

function isTitleCaseHeading(t) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;
    const titleCaseWord = /^[\p{Lu}][\p{L}&/'’.-]*$/u;
    const smallWord = /^(and|of|the|for|in|to|&|und|et|y|de|da|do)$/i;
    return (
        words.every((w) => titleCaseWord.test(w) || smallWord.test(w)) &&
        titleCaseWord.test(words[0]) &&
        !/[.!?]$/.test(t)
    );
}

/**
 * True if this line is a job/school body line (not a section banner).
 * ALL CAPS banners that precede dated jobs still count as sections.
 */
function looksLikeJobOrSchoolLine(line, nextLine = '') {
    const t = String(line || '').trim();
    const next = String(nextLine || '').trim();
    if (!t) return false;
    if (isAllCapsHeading(t)) return false;
    if (looksLikeDateish(t)) return true;
    if (/\b(Engineer|Developer|Intern|Manager|Analyst|Consultant|Director|Architect|Associate)\b/i.test(t) && t.length < 60) {
        return true;
    }
    if (next && looksLikeDateish(next)) return true;
    if (next && /\b(Inc|LLC|Ltd|LLP|Corp|University|Institute|College|Pvt)\b/i.test(next) && t.length < 50) {
        return true;
    }
    return false;
}

/**
 * @param {string} line
 * @param {string[]} [knownFromThisResume]
 * @param {{ nextLine?: string, prevBlank?: boolean, next2?: string }} [ctx]
 */
export function looksLikeSectionHeader(line, knownFromThisResume = [], ctx = {}) {
    const t = String(line || '').trim().replace(/:$/, '');
    if (!t || t.length < 2 || t.length > 52) return false;

    if (knownFromThisResume.some((k) => k.toLowerCase() === t.toLowerCase())) {
        return true;
    }

    if (isBullet(t) || t.includes('@') || t.includes('http') || /^\d/.test(t)) return false;
    if (looksLikeSkillLine(t) && t.length > 28) return false;
    if (t.includes('|') && t.length > 20) return false;
    if (t.includes('\t')) return false;
    if (looksLikeJobOrSchoolLine(t, ctx.nextLine)) return false;

    if (isAllCapsHeading(t)) return true;

    // Title Case / localized banners: need blank line before + content after
    if (isTitleCaseHeading(t) && ctx.prevBlank) {
        const next = String(ctx.nextLine || '').trim();
        const next2 = String(ctx.next2 || '').trim();
        if (!next) return false;
        if (isBullet(next) || looksLikeSkillLine(next) || next.length > 45) return true;
        if (isBullet(next2) || looksLikeDateish(next2) || next2.length > 45) return true;
        // Ausbildung → TU Berlin → dated degree
        if (next.length < 45 && (looksLikeDateish(next2) || isBullet(next2))) return true;
        // Sonstiges → short note
        if (next.length > 0 && next.length <= 80 && !looksLikeDateish(next) && !/@/.test(next)) return true;
    }

    return false;
}

/**
 * Discover this resume's section titles in document order (verbatim casing).
 */
export function extractSectionTitles(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const titles = [];

    for (let i = 0; i < raw.length; i++) {
        const t = raw[i].trim().replace(/:$/, '');
        if (!t) continue;

        let prevBlank = i === 0;
        for (let j = i - 1; j >= 0; j--) {
            if (!raw[j].trim()) {
                prevBlank = true;
                break;
            }
            prevBlank = false;
            break;
        }

        let next = '';
        let next2 = '';
        for (let j = i + 1; j < raw.length; j++) {
            if (!raw[j].trim()) continue;
            if (!next) next = raw[j].trim();
            else {
                next2 = raw[j].trim();
                break;
            }
        }

        // Skip name/contact block at top (first lines before any real section)
        if (titles.length === 0 && i < 8) {
            if (/@|linkedin|github/i.test(t)) continue;
            const contactNear =
                /@|linkedin|github|\d{8,}/i.test(next) || /@|linkedin|github|\d{8,}/i.test(next2);
            if (contactNear && !isAllCapsHeading(t)) continue;
            // Location line under name (City / Country) before email further down
            if (
                !isAllCapsHeading(t) &&
                next &&
                next.length < 40 &&
                !isAllCapsHeading(next) &&
                /@|linkedin|github/i.test(next2)
            ) {
                continue;
            }
        }

        if (!looksLikeSectionHeader(t, titles, { nextLine: next, next2, prevBlank })) continue;
        if (titles.length && titles[titles.length - 1].toLowerCase() === t.toLowerCase()) continue;
        titles.push(t);
    }
    return titles;
}

/** Fix common pdf-parse merges using soft hints + light line heuristics. */
export function normalizeResumeExtract(raw) {
    let text = String(raw || '').replace(/\r\n/g, '\n');

    const hints = [...DEJAM_HINTS].filter((s) => s.includes(' ')).sort((a, b) => b.length - a.length);
    for (const section of hints) {
        const jammed = section.replace(/\s+/g, '');
        text = text.replace(new RegExp(jammed, 'gi'), `\n${section}\n`);
    }

    text = text.replace(
        /\b(Engineer|Developer|Intern|Manager|Analyst|Consultant|Lead|Architect|Scientist|Designer|Specialist|Associate|Director|Officer)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/gi,
        '$1\t$2'
    );

    text = text.replace(/\|/g, ' | ');
    text = text.replace(/\s+\|\s+/g, ' | ');
    text = text.replace(/(^|\n)([–—\-\u2022•])([A-Za-z])/g, '$1$2 $3');
    text = text.replace(/([A-Za-z][A-Za-z /&+]+):([A-Za-z0-9])/g, '$1: $2');

    text = text
        .split('\n')
        .map((line) => {
            if (line.includes('@')) return line;
            let l = line;
            l = l.replace(/([A-Za-z\)])(\d{4})(\s*[–\-—]\s*(?:Present|\d{4})|\s*$)/g, '$1\t$2$3');
            l = l.replace(/(\d)([A-Z][a-z]{2,})/g, '$1 $2');
            l = l.replace(/\)([A-Z][a-z]{2,})/g, ') $1');
            l = l.replace(/ {2,}/g, ' ');
            return l;
        })
        .join('\n');

    return text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

export function extractHeaderLines(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const header = [];
    for (let i = 0; i < raw.length && header.length < 5; i++) {
        const line = raw[i].trim();
        if (!line) {
            if (header.length) break;
            continue;
        }
        let next = '';
        let next2 = '';
        for (let j = i + 1; j < raw.length; j++) {
            if (!raw[j].trim()) continue;
            if (!next) next = raw[j].trim();
            else {
                next2 = raw[j].trim();
                break;
            }
        }
        let prevBlank = i === 0;
        for (let j = i - 1; j >= 0; j--) {
            if (!raw[j].trim()) {
                prevBlank = true;
                break;
            }
            prevBlank = false;
            break;
        }
        if (looksLikeSectionHeader(line, [], { nextLine: next, next2, prevBlank })) break;
        header.push(line);
    }
    return header;
}

/**
 * LAYOUT LOCK from THIS user's base resume (dynamic sections).
 * @param {string} baseText
 */
export function buildLayoutLockBlock(baseText) {
    const normalized = normalizeResumeExtract(baseText);
    const sections = extractSectionTitles(normalized);
    const header = extractHeaderLines(normalized);

    return [
        'LAYOUT LOCK (must follow — mirror THIS candidate\'s own resume shape):',
        '- Keep name + contact / location lines identical to BASE (do not rewrite contact details).',
        '- Keep the SAME section titles and SAME section ORDER as BASE — including unusual/custom/non-English titles.',
        '- Do NOT force a standard English template (do not rename their sections unless BASE already uses those words).',
        sections.length
            ? `- Section titles in order (copy exactly): ${sections.map((s) => JSON.stringify(s)).join(' → ')}`
            : '- Infer section titles only from BASE; keep them verbatim.',
        header.length ? `- Header lines to keep: ${header.map((h) => JSON.stringify(h)).join(' | ')}` : '',
        '- Preserve BASE patterns: skill lines, Title<TAB>Dates, company lines, bullet characters.',
        '- Do not invent new sections; do not drop existing BASE sections.',
        '- Plain text only. Each section title alone on its own line (exact casing as BASE).',
        '- Do not put dates alone on the line under a job/project title.',
    ]
        .filter(Boolean)
        .join('\n');
}
