/**
 * LaTeX / Jake-resume style PDF: preserves section order, title+date lines, skill categories, bullets.
 */

import PDFDocument from 'pdfkit';
import {
    normalizeResumeExtract,
    extractSectionTitles,
    extractHeaderLines,
} from './resumeStructure.js';

const SECTION_RE =
    /^(professional\s+summary|profile\s+summary|summary|objective|profile|skills|technical\s+skills|core\s+competencies|experience|work\s+experience|professional\s+experience|employment|projects|education|certifications?|achievements?|awards|languages|interests|publications)\s*:?\s*$/i;

function isSectionHeader(line, knownTitles = []) {
    const t = String(line || '').trim();
    if (!t || t.length > 48) return false;
    if (knownTitles.some((k) => k.toLowerCase() === t.toLowerCase())) return true;
    if (SECTION_RE.test(t)) return true;
    if (t.length >= 4 && t.length <= 42 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[a-z]/.test(t) && !t.includes('|') && !t.includes('@')) {
        return true;
    }
    return false;
}

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function isSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

/** "Software Engineer\tJul 2023 – Present" or title ... dates at end */
function splitTitleDate(line) {
    const t = String(line || '').trim();
    if (t.includes('\t')) {
        const [left, ...rest] = t.split('\t');
        return { title: left.trim(), dates: rest.join(' ').trim() };
    }
    const m = t.match(/^(.+?)\s{2,}(.+?\d{4}.*)$/);
    if (m) return { title: m[1].trim(), dates: m[2].trim() };
    const m2 = t.match(/^(.+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[–\-—].+)$/i);
    if (m2) return { title: m2[1].trim(), dates: m2[2].trim() };
    return null;
}

function drawSectionRule(doc) {
    const x = doc.page.margins.left;
    const y = doc.y + 1;
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.moveTo(x, y).lineTo(x + w, y).strokeColor('#222222').lineWidth(1).stroke();
    doc.moveDown(0.4);
}

/**
 * @param {string} resumeText
 * @param {{ title?: string, baseText?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export function buildResumePdfBuffer(resumeText, opts = {}) {
    const text = normalizeResumeExtract(resumeText);
    if (!text) {
        return Promise.reject(new Error('Empty resume text for PDF'));
    }

    const baseNorm = opts.baseText ? normalizeResumeExtract(opts.baseText) : '';
    const knownTitles = extractSectionTitles(baseNorm || text);
    const baseHeader = extractHeaderLines(baseNorm);

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'LETTER',
            margins: { top: 42, bottom: 42, left: 50, right: 50 },
            info: {
                Title: opts.title || 'Tailored Resume',
                Creator: 'WA-BOT Resume Tailor',
            },
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const lines = text.split('\n');

        let phase = 'header'; // header | body
        let headerCount = 0;

        // Prefer original contact header from base when tailored accidentally rewrote it
        if (baseHeader.length >= 1) {
            doc.font('Times-Bold').fontSize(20).fillColor('#111111').text(baseHeader[0], {
                align: 'center',
                paragraphGap: 2,
            });
            for (let i = 1; i < baseHeader.length; i++) {
                doc.font('Times-Roman').fontSize(9).fillColor('#333333').text(baseHeader[i], {
                    align: 'center',
                    paragraphGap: 1,
                });
            }
            doc.moveDown(0.5);
            phase = 'body';
            // Skip matching header lines from tailored text
            const skip = new Set(baseHeader.map((h) => h.toLowerCase()));
            while (lines.length && skip.has(String(lines[0]).trim().toLowerCase())) {
                lines.shift();
            }
            while (lines.length && !String(lines[0]).trim()) lines.shift();
        }

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].replace(/\s+$/g, '').trim();
            if (!trimmed) {
                doc.moveDown(0.25);
                continue;
            }

            if (phase === 'header') {
                if (isSectionHeader(trimmed, knownTitles)) {
                    phase = 'body';
                    // fall through to section render
                } else {
                    if (headerCount === 0) {
                        doc.font('Times-Bold').fontSize(20).fillColor('#111111').text(trimmed, {
                            align: 'center',
                            paragraphGap: 2,
                        });
                    } else {
                        doc.font('Times-Roman').fontSize(9).fillColor('#333333').text(trimmed, {
                            align: 'center',
                            paragraphGap: 1,
                        });
                    }
                    headerCount += 1;
                    if (headerCount >= 4) phase = 'body';
                    continue;
                }
            }

            if (isSectionHeader(trimmed, knownTitles)) {
                doc.moveDown(0.45);
                doc.font('Times-Bold').fontSize(11).fillColor('#111111').text(trimmed.toUpperCase(), {
                    characterSpacing: 0.6,
                    paragraphGap: 0,
                });
                drawSectionRule(doc);
                continue;
            }

            if (isBullet(trimmed)) {
                const body = trimmed.replace(/^[\u2022\-\*\u2013\u2014•–—]\s*/, '');
                doc.font('Times-Roman').fontSize(10).fillColor('#222222').text(`– ${body}`, {
                    indent: 12,
                    paragraphGap: 2,
                    lineGap: 1.2,
                    align: 'justify',
                });
                continue;
            }

            if (isSkillLine(trimmed)) {
                const idx = trimmed.indexOf(':');
                const cat = trimmed.slice(0, idx).trim();
                const rest = trimmed.slice(idx + 1).trim();
                doc.font('Times-Bold').fontSize(10).fillColor('#222222').text(`${cat}: `, {
                    continued: true,
                });
                doc.font('Times-Roman').fontSize(10).text(rest, {
                    paragraphGap: 2,
                    lineGap: 1.2,
                });
                continue;
            }

            const titleDate = splitTitleDate(trimmed);
            if (titleDate?.dates) {
                const y = doc.y;
                doc.font('Times-Bold').fontSize(10.5).fillColor('#111111');
                doc.text(titleDate.title, doc.page.margins.left, y, {
                    width: pageWidth * 0.62,
                    continued: false,
                });
                const afterTitleY = doc.y;
                doc.font('Times-Roman').fontSize(10).fillColor('#333333');
                doc.text(titleDate.dates, doc.page.margins.left + pageWidth * 0.62, y, {
                    width: pageWidth * 0.38,
                    align: 'right',
                });
                doc.y = Math.max(afterTitleY, doc.y);
                doc.moveDown(0.1);
                continue;
            }

            // Company / meta line under title
            if (/\|/.test(trimmed) && trimmed.length < 120 && !trimmed.includes('@')) {
                doc.font('Times-Italic').fontSize(10).fillColor('#333333').text(trimmed, {
                    paragraphGap: 2,
                });
                continue;
            }

            doc.font('Times-Roman').fontSize(10).fillColor('#222222').text(trimmed, {
                paragraphGap: 2,
                lineGap: 1.3,
                align: 'justify',
            });
        }

        doc.end();
    });
}
