/**
 * Compact LaTeX/Jake-style resume PDF.
 * Keeps title+dates on one row, avoids orphan dates across page breaks, left-align (no justify gaps).
 */

import PDFDocument from 'pdfkit';
import {
    normalizeResumeExtract,
    extractSectionTitles,
    extractHeaderLines,
    looksLikeSectionHeader,
} from './resumeStructure.js';

function isSectionHeader(line, knownTitles = []) {
    return looksLikeSectionHeader(line, knownTitles, {});
}

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function isSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

/** "Software Engineer\tJul 2023 – Present" or trailing year range */
function splitTitleDate(line) {
    const t = String(line || '').trim();
    if (!t) return null;

    if (t.includes('\t')) {
        const [left, ...rest] = t.split('\t');
        const dates = rest.join(' ').trim();
        if (left && dates) return { title: left.trim(), dates };
    }

    const m2 = t.match(
        /^(.+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[–\-—].+)$/i
    );
    if (m2) return { title: m2[1].trim(), dates: m2[2].trim() };

    const m3 = t.match(/^(.+?)\s+(\d{4}\s*[–\-—]\s*(?:Present|\d{4}))$/i);
    if (m3) return { title: m3[1].trim(), dates: m3[2].trim() };

    const m4 = t.match(/^(.+?)\s+(\d{4})$/);
    if (m4 && m4[1].length > 8) return { title: m4[1].trim(), dates: m4[2].trim() };

    return null;
}

function pageContentWidth(doc) {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** If not enough room for a block, start a new page (prevents orphan dates). */
function ensureSpace(doc, neededPt) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededPt > bottom) {
        doc.addPage();
    }
}

function drawSectionRule(doc) {
    const x = doc.page.margins.left;
    const y = doc.y + 1;
    const w = pageContentWidth(doc);
    doc.moveTo(x, y).lineTo(x + w, y).strokeColor('#222222').lineWidth(0.9).stroke();
    doc.moveDown(0.3);
}

/**
 * Title left + dates right-aligned on the same first line (Jake/LaTeX style).
 * Avoids space-padding (which wraps and orphans dates).
 */
function writeTitleDateLine(doc, title, dates) {
    ensureSpace(doc, 36);
    const ml = doc.page.margins.left;
    const pw = pageContentWidth(doc);
    const startY = doc.y;

    doc.font('Times-Roman').fontSize(10);
    const dateW = doc.widthOfString(dates);
    const titleMaxW = Math.max(80, pw - dateW - 12);

    doc.font('Times-Bold').fontSize(10.5).fillColor('#111111');
    doc.text(title, ml, startY, {
        width: titleMaxW,
        align: 'left',
        lineGap: 0.5,
    });
    const afterTitleY = doc.y;

    doc.font('Times-Roman').fontSize(10).fillColor('#333333');
    doc.text(dates, ml + pw - dateW, startY, {
        width: dateW,
        align: 'left',
        lineBreak: false,
    });

    doc.x = ml;
    doc.y = Math.max(afterTitleY, startY + 11) + 1;
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
            margins: { top: 36, bottom: 36, left: 48, right: 48 },
            info: {
                Title: opts.title || 'Tailored Resume',
                Creator: 'WA-BOT Resume Tailor',
            },
            bufferPages: true,
        });

        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const lines = text.split('\n');
        let phase = 'header';
        let headerCount = 0;

        if (baseHeader.length >= 1) {
            doc.font('Times-Bold').fontSize(18).fillColor('#111111').text(baseHeader[0], {
                align: 'center',
                paragraphGap: 1,
            });
            for (let i = 1; i < baseHeader.length; i++) {
                doc.font('Times-Roman').fontSize(9).fillColor('#333333').text(baseHeader[i], {
                    align: 'center',
                    paragraphGap: 0.5,
                });
            }
            doc.moveDown(0.35);
            phase = 'body';
            const skip = new Set(baseHeader.map((h) => h.toLowerCase()));
            while (lines.length && skip.has(String(lines[0]).trim().toLowerCase())) {
                lines.shift();
            }
            while (lines.length && !String(lines[0]).trim()) lines.shift();
        }

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].replace(/\s+$/g, '').trim();
            if (!trimmed) {
                doc.moveDown(0.15);
                continue;
            }

            if (phase === 'header') {
                if (isSectionHeader(trimmed, knownTitles)) {
                    phase = 'body';
                } else {
                    if (headerCount === 0) {
                        doc.font('Times-Bold').fontSize(18).fillColor('#111111').text(trimmed, {
                            align: 'center',
                            paragraphGap: 1,
                        });
                    } else {
                        doc.font('Times-Roman').fontSize(9).fillColor('#333333').text(trimmed, {
                            align: 'center',
                            paragraphGap: 0.5,
                        });
                    }
                    headerCount += 1;
                    if (headerCount >= 4) phase = 'body';
                    continue;
                }
            }

            if (isSectionHeader(trimmed, knownTitles)) {
                ensureSpace(doc, 28);
                doc.moveDown(0.35);
                doc.font('Times-Bold').fontSize(10.5).fillColor('#111111').text(trimmed.toUpperCase(), {
                    characterSpacing: 0.5,
                    paragraphGap: 0,
                    align: 'left',
                });
                drawSectionRule(doc);
                continue;
            }

            if (isBullet(trimmed)) {
                const body = trimmed.replace(/^[\u2022\-\*\u2013\u2014•–—]\s*/, '');
                ensureSpace(doc, 16);
                doc.font('Times-Roman').fontSize(9.8).fillColor('#222222').text(`– ${body}`, {
                    indent: 10,
                    paragraphGap: 1.5,
                    lineGap: 1,
                    align: 'left',
                    width: pageContentWidth(doc),
                });
                continue;
            }

            if (isSkillLine(trimmed)) {
                ensureSpace(doc, 14);
                const idx = trimmed.indexOf(':');
                const cat = trimmed.slice(0, idx).trim();
                const rest = trimmed.slice(idx + 1).trim();
                doc.font('Times-Bold').fontSize(9.8).fillColor('#222222').text(`${cat}: `, {
                    continued: true,
                    align: 'left',
                });
                doc.font('Times-Roman').fontSize(9.8).text(rest, {
                    paragraphGap: 1.5,
                    lineGap: 1,
                    align: 'left',
                });
                continue;
            }

            const titleDate = splitTitleDate(trimmed);
            if (titleDate?.dates) {
                writeTitleDateLine(doc, titleDate.title, titleDate.dates);
                continue;
            }

            // Standalone date line left over from a bad split — attach as right-aligned only if previous was a title
            if (/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*\d{4}/i.test(trimmed) || /^\d{4}\s*[–\-—]/.test(trimmed)) {
                // Merge onto previous by rewriting as title+date if we can peek back — otherwise print inline
                ensureSpace(doc, 14);
                doc.font('Times-Roman').fontSize(10).fillColor('#333333').text(trimmed, {
                    align: 'right',
                    paragraphGap: 1,
                });
                continue;
            }

            if (/\|/.test(trimmed) && trimmed.length < 140 && !trimmed.includes('@')) {
                ensureSpace(doc, 14);
                doc.font('Times-Italic').fontSize(9.8).fillColor('#333333').text(trimmed, {
                    paragraphGap: 1.5,
                    align: 'left',
                });
                continue;
            }

            ensureSpace(doc, 14);
            doc.font('Times-Roman').fontSize(9.8).fillColor('#222222').text(trimmed, {
                paragraphGap: 1.5,
                lineGap: 1.1,
                align: 'left',
            });
        }

        // Drop trailing blank pages (orphan date / empty)
        const range = doc.bufferedPageRange();
        // pdfkit can't easily delete pages; just end. Orphans fixed by ensureSpace instead.
        void range;
        doc.end();
    });
}
