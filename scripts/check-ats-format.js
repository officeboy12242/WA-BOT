import fs from 'fs';
import zlib from 'zlib';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {
    normalizeResumeExtract,
    extractHeaderLines,
    extractSectionTitles,
    detectResumeLayoutProfile,
} from '../src/utils/resumeStructure.js';
import { extractPdfColorPalette } from '../src/utils/resumePdfColors.js';
import { buildResumePdfBuffer } from '../src/utils/resumePdfExport.js';

const path = 'c:/Users/jaikishanbagul/Downloads/Jaikishan_Bagul_ATS_Resume (1).pdf';
const origBuf = fs.readFileSync(path);
const orig = (await pdfParse(origBuf)).text;
const norm = normalizeResumeExtract(orig);
const palette = extractPdfColorPalette(origBuf);
console.log('palette', palette);
console.log('profile', detectResumeLayoutProfile(norm));
console.log('header', extractHeaderLines(norm));
console.log('sections', extractSectionTitles(norm));

const pdf = await buildResumePdfBuffer(norm, { baseText: norm, title: 'ats-check', palette });
fs.writeFileSync('scripts/_ats-format-out.pdf', pdf);

function sampleColors(buf) {
    const colors = new Map();
    const addRgb = (r, g, b) => {
        const hex =
            '#' +
            [r, g, b]
                .map((x) => Math.round(Number(x) * 255).toString(16).padStart(2, '0'))
                .join('');
        colors.set(hex, (colors.get(hex) || 0) + 1);
    };
    const scan = (t) => {
        for (const m of t.matchAll(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(?:rg|scn)\b/gi)) {
            addRgb(m[1], m[2], m[3]);
        }
    };
    scan(buf.toString('latin1'));
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
        scan(data.toString('latin1'));
    }
    return colors;
}

const outColors = sampleColors(pdf);
console.log('out colors', [...outColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12));

const fails = [];
if (detectResumeLayoutProfile(norm).style !== 'ats') fails.push('profile not ats');
if (!palette?.name || palette.name !== '#003a57') fails.push(`name color ${palette?.name}`);
if (!palette?.accent || palette.accent !== '#005682') fails.push(`accent ${palette?.accent}`);
const hasTeal = [...outColors.keys()].some((c) => c === '#003a57' || c === '#005682');
if (!hasTeal) fails.push('output missing teal accents');
if (fails.length) {
    console.error('FAIL:', fails);
    process.exit(1);
}
console.log('ats format+color check ok');
