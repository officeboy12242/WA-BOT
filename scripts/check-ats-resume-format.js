import fs from 'fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {
    normalizeResumeExtract,
    extractHeaderLines,
    extractSectionTitles,
    detectResumeLayoutProfile,
    buildLayoutLockBlock,
} from '../src/utils/resumeStructure.js';
import { buildResumePdfBuffer } from '../src/utils/resumePdfExport.js';

const path = 'c:/Users/jaikishanbagul/Downloads/Jaikishan_Bagul_ATS_Resume (1).pdf';
const orig = (await pdfParse(fs.readFileSync(path))).text;
const norm = normalizeResumeExtract(orig);
console.log('=== NORMALIZED (first 80 lines) ===');
console.log(norm.split('\n').slice(0, 80).join('\n'));
console.log('\n=== PROFILE ===');
console.log(detectResumeLayoutProfile(norm));
console.log('header', extractHeaderLines(norm));
console.log('sections', extractSectionTitles(norm));
console.log('\n=== LAYOUT LOCK (snippet) ===');
console.log(buildLayoutLockBlock(norm).split('\n').slice(0, 14).join('\n'));

const pdf = await buildResumePdfBuffer(norm, { baseText: norm, title: 'ats-check' });
fs.writeFileSync('scripts/_ats-format-out.pdf', pdf);
const check = await pdfParse(pdf);
console.log('\n=== GENERATED PDF ===');
console.log('pages', check.numpages);
console.log(check.text.slice(0, 1800));

const fails = [];
if (detectResumeLayoutProfile(norm).style !== 'ats') fails.push('profile not ats');
if (!extractHeaderLines(norm).some((h) => /JAIKISHAN/i.test(h))) fails.push('name missing from header');
if (extractSectionTitles(norm).includes('JAIKISHAN BAGUL')) fails.push('name treated as section');
if (!/JAIKISHAN|Jaikishan/i.test(check.text)) fails.push('name missing in pdf');
if (fails.length) {
    console.error('FAIL:', fails);
    process.exit(1);
}
console.log('ats format check ok');
