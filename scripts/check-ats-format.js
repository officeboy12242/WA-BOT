import fs from 'fs';
import zlib from 'zlib';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {
    normalizeResumeExtract,
    extractHeaderLines,
    detectResumeLayoutProfile,
} from '../src/utils/resumeStructure.js';
import { extractPdfColorPalette } from '../src/utils/resumePdfColors.js';
import { extractPdfTypography, resolveResumeFontPair } from '../src/utils/resumePdfFonts.js';
import { buildResumePdfBuffer } from '../src/utils/resumePdfExport.js';

const path = 'c:/Users/jaikishanbagul/Downloads/Jaikishan_Bagul_ATS_Resume (1).pdf';
const origBuf = fs.readFileSync(path);
const orig = (await pdfParse(origBuf)).text;
const norm = normalizeResumeExtract(orig);
const palette = extractPdfColorPalette(origBuf);
const typography = extractPdfTypography(origBuf);
const fonts = resolveResumeFontPair(typography.family);

console.log('typography', typography);
console.log('fonts', fonts);
console.log('profile', detectResumeLayoutProfile(norm));
console.log('header', extractHeaderLines(norm));

const pdf = await buildResumePdfBuffer(norm, {
    baseText: norm,
    title: 'ats-check',
    palette,
    typography,
});
fs.writeFileSync('scripts/_ats-format-out.pdf', pdf);
const check = await pdfParse(pdf);
console.log('pages', check.numpages);

function sampleScn(buf) {
    const colors = new Map();
    const add = (r, g, b) => {
        const hex =
            '#' +
            [r, g, b]
                .map((x) => Math.round(Number(x) * 255).toString(16).padStart(2, '0'))
                .join('');
        colors.set(hex, (colors.get(hex) || 0) + 1);
    };
    for (let i = 0; i < buf.length - 6; i++) {
        if (buf.toString('ascii', i, i + 6) !== 'stream') continue;
        let start = i + 6;
        if (buf[start] === 0x0d) start += 1;
        if (buf[start] === 0x0a) start += 1;
        let end = -1;
        for (let j = start; j < Math.min(buf.length - 9, start + 500000); j++) {
            if (buf.toString('ascii', j, j + 9) === 'endstream') {
                end = j;
                break;
            }
        }
        if (end < 0) continue;
        let data;
        try {
            data = zlib.inflateSync(buf.subarray(start, end));
        } catch {
            data = buf.subarray(start, end);
        }
        const t = data.toString('latin1');
        for (const m of t.matchAll(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(?:rg|scn)\b/gi)) {
            add(m[1], m[2], m[3]);
        }
    }
    return colors;
}

const outColors = sampleScn(pdf);
const ascii = pdf.toString('latin1');
const hasArial = /Arial|ResumeRegular|ResumeBold/i.test(ascii) || fonts.embedded;

const fails = [];
if (typography?.family !== 'Arial') fails.push(`font family ${typography?.family}`);
if (typography?.headerAlign !== 'center') fails.push(`align ${typography?.headerAlign}`);
if (detectResumeLayoutProfile(norm).headerAlign !== 'center') fails.push('profile not center');
if (check.numpages !== 1) fails.push(`pages ${check.numpages}`);
if (!hasArial) fails.push('arial font not embedded');
if (![...outColors.keys()].some((c) => c === '#003a57' || c === '#005682')) {
    fails.push('missing teal');
}
if (!/JAIKISHAN/i.test(check.text)) fails.push('name missing');

if (fails.length) {
    console.error('FAIL:', fails);
    process.exit(1);
}
console.log('ats center+font+1page check ok');
