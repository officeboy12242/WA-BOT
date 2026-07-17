/**
 * Resume PDF export — adapts to uploaded layout family (ATS left-column vs classic centered).
 */

import PDFDocument from 'pdfkit';
import {
    normalizeResumeExtract,
    extractSectionTitles,
    extractHeaderLines,
    looksLikeSectionHeader,
    detectResumeLayoutProfile,
} from './resumeStructure.js';
import { resolveResumePalette } from './resumePdfColors.js';

function isSectionHeader(line, knownTitles = []) {
    return looksLikeSectionHeader(line, knownTitles, {});
}

function isBullet(line) {
    return /^[\u2022\-\*\u2013\u2014•–—]\s*/.test(String(line || '').trim());
}

function isSkillLine(line) {
    return /^[A-Za-z][A-Za-z0-9 /&+]{1,40}:\s+\S/.test(String(line || '').trim());
}

function isYearBand(line) {
    const t = String(line || '').trim();
    if (/^\d{4}$/.test(t)) return true;
    if (/^\d{4}\s*[-–—]\s*(?:Present|\d{4})$/i.test(t)) return true;
    if (
        /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})$/i.test(
            t
        )
    ) {
        return true;
    }
    return false;
}

/** Tab-separated or trailing month-year dates */
function splitTitleDate(line) {
    const t = String(line || '').trim();
    if (!t) return null;

    if (t.includes('\t')) {
        const [left, ...rest] = t.split('\t');
        const dates = rest.join(' ').trim();
        if (left && dates) return { title: left.trim(), dates };
    }

    const m2 = t.match(
        /^(.+?)\s{2,}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—\(].+)$/i
    );
    if (m2) return { title: m2[1].trim(), dates: m2[2].trim() };

    const m3 = t.match(
        /^(.+?)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—\(].+)$/i
    );
    if (m3 && (m3[1].includes('|') || m3[1].length > 12)) {
        return { title: m3[1].trim(), dates: m3[2].trim() };
    }

    const m4 = t.match(/^(.+?)\s+(\d{4}\s*[–\-—]\s*(?:Present|\d{4}))$/i);
    if (m4 && m4[1].length > 8) return { title: m4[1].trim(), dates: m4[2].trim() };

    return null;
}

function pageContentWidth(doc) {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, neededPt) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + neededPt > bottom) {
        doc.addPage();
    }
}

function drawSectionRule(doc, palette) {
    const x = doc.page.margins.left;
    const y = doc.y + 1;
    const w = pageContentWidth(doc);
    doc.moveTo(x, y)
        .lineTo(x + w, y)
        .strokeColor(palette.rule)
        .lineWidth(0.9)
        .stroke();
    doc.moveDown(0.28);
}

function writeTitleDateLine(doc, title, dates, palette) {
    ensureSpace(doc, 36);
    const ml = doc.page.margins.left;
    const pw = pageContentWidth(doc);
    const startY = doc.y;

    doc.font('Times-Roman').fontSize(10);
    const dateW = doc.widthOfString(dates);
    const titleMaxW = Math.max(80, pw - dateW - 12);

    doc.font('Times-Bold').fontSize(10.5).fillColor(palette.accent);
    doc.text(title, ml, startY, {
        width: titleMaxW,
        align: 'left',
        lineGap: 0.5,
    });
    const afterTitleY = doc.y;

    doc.font('Times-Roman').fontSize(10).fillColor(palette.muted);
    doc.text(dates, ml + pw - dateW, startY, {
        width: dateW,
        align: 'left',
        lineBreak: false,
    });

    doc.x = ml;
    doc.y = Math.max(afterTitleY, startY + 11) + 1;
}

function writeHeader(doc, headerLines, profile, palette) {
    const align = profile.headerAlign || 'left';
    if (!headerLines.length) return;

    for (let i = 0; i < headerLines.length; i++) {
        const line = headerLines[i];
        if (i === 0) {
            doc.font('Times-Bold')
                .fontSize(profile.style === 'ats' ? 16 : 18)
                .fillColor(palette.name)
                .text(line, {
                    align,
                    paragraphGap: 1,
                });
        } else if (i === 1 && profile.style === 'ats' && /\|/.test(line) && !/@/.test(line)) {
            doc.font('Times-Roman').fontSize(9.5).fillColor(palette.body).text(line, {
                align,
                paragraphGap: 1,
            });
        } else {
            doc.font('Times-Roman').fontSize(9).fillColor(palette.muted).text(line, {
                align,
                paragraphGap: 0.5,
            });
        }
    }
    doc.moveDown(0.35);
}

/**
 * @param {string} resumeText
 * @param {{ title?: string, baseText?: string, palette?: object }} [opts]
 * @returns {Promise<Buffer>}
 */
export function buildResumePdfBuffer(resumeText, opts = {}) {
    const text = normalizeResumeExtract(resumeText);
    if (!text) {
        return Promise.reject(new Error('Empty resume text for PDF'));
    }

    const baseNorm = opts.baseText ? normalizeResumeExtract(opts.baseText) : text;
    const knownTitles = extractSectionTitles(baseNorm);
    const baseHeader = extractHeaderLines(baseNorm);
    const profile = detectResumeLayoutProfile(baseNorm);
    const palette = resolveResumePalette(profile.style, opts.palette);
    const bulletChar = profile.bullet || '•';

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
        let i = 0;

        // Prefer BASE header (exact contact), else header from tailored text
        const header = baseHeader.length ? baseHeader : extractHeaderLines(text);
        if (header.length) {
            writeHeader(doc, header, profile, palette);
            const skip = new Set(header.map((h) => h.toLowerCase()));
            while (i < lines.length) {
                const t = String(lines[i]).trim();
                if (!t) {
                    i += 1;
                    continue;
                }
                if (skip.has(t.toLowerCase())) {
                    i += 1;
                    continue;
                }
                break;
            }
        }

        for (; i < lines.length; i++) {
            const trimmed = lines[i].replace(/\s+$/g, '').trim();
            if (!trimmed) {
                doc.moveDown(0.12);
                continue;
            }

            if (isSectionHeader(trimmed, knownTitles)) {
                ensureSpace(doc, 28);
                doc.moveDown(0.3);
                doc.font('Times-Bold')
                    .fontSize(10.5)
                    .fillColor(palette.accent)
                    .text(trimmed.toUpperCase(), {
                        characterSpacing: profile.style === 'ats' ? 0.8 : 0.5,
                        paragraphGap: 0,
                        align: 'left',
                    });
                drawSectionRule(doc, palette);
                continue;
            }

            if (isBullet(trimmed)) {
                const body = trimmed.replace(/^[\u2022\-\*\u2013\u2014•–—]\s*/, '');
                ensureSpace(doc, 16);
                doc.font('Times-Roman')
                    .fontSize(9.8)
                    .fillColor(palette.body)
                    .text(`${bulletChar} ${body}`, {
                        indent: 8,
                        paragraphGap: 1.4,
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
                doc.font('Times-Bold').fontSize(9.8).fillColor(palette.accent).text(`${cat}: `, {
                    continued: true,
                    align: 'left',
                });
                doc.font('Times-Roman').fontSize(9.8).fillColor(palette.body).text(rest, {
                    paragraphGap: 1.4,
                    lineGap: 1,
                    align: 'left',
                });
                continue;
            }

            if (isYearBand(trimmed)) {
                ensureSpace(doc, 14);
                doc.font('Times-Bold').fontSize(9.5).fillColor(palette.accent).text(trimmed, {
                    paragraphGap: 1.2,
                    align: 'left',
                });
                continue;
            }

            const titleDate = splitTitleDate(trimmed);
            if (titleDate?.dates) {
                writeTitleDateLine(doc, titleDate.title, titleDate.dates, palette);
                continue;
            }

            // ATS project / meta line with pipes (not contact)
            if (/\|/.test(trimmed) && !trimmed.includes('@')) {
                ensureSpace(doc, 14);
                doc.font('Times-Bold').fontSize(10).fillColor(palette.accent).text(trimmed, {
                    paragraphGap: 1.3,
                    align: 'left',
                });
                continue;
            }

            if (/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*\d{4}/i.test(trimmed)) {
                ensureSpace(doc, 14);
                doc.font('Times-Roman').fontSize(10).fillColor(palette.muted).text(trimmed, {
                    align: profile.style === 'ats' ? 'left' : 'right',
                    paragraphGap: 1,
                });
                continue;
            }

            ensureSpace(doc, 14);
            doc.font('Times-Roman').fontSize(9.8).fillColor(palette.body).text(trimmed, {
                paragraphGap: 1.4,
                lineGap: 1.1,
                align: 'left',
            });
        }

        doc.end();
    });
}
