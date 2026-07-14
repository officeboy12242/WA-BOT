import fs from 'fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import {
    normalizeResumeExtract,
    extractSectionTitles,
    buildLayoutLockBlock,
    looksLikeSectionHeader,
} from '../src/utils/resumeStructure.js';

const orig = normalizeResumeExtract(
    (await pdfParse(fs.readFileSync('c:/Users/jaikishanbagul/Downloads/Swaraj_Salunke_Resume_1_7122 1.pdf'))).text
);
console.log('swaraj sections:', extractSectionTitles(orig));

const custom = normalizeResumeExtract(`Alex Kim
Seoul
alex@x.com

ABOUT ME
Builder of things.

WORK HISTORY
Dev\t2020 – Present
Acme
– Built stuff

Ausbildung
TU Berlin
B.Sc.\t2016 – 2020

Sonstiges
Stuff
`);
const customs = extractSectionTitles(custom);
console.log('custom sections:', customs);
const need = ['ABOUT ME', 'WORK HISTORY', 'Ausbildung'];
for (const n of need) {
    if (!customs.includes(n)) {
        console.error('FAIL missing', n, customs);
        process.exit(1);
    }
}
if (customs.includes('Alex Kim') || customs.includes('Seoul') || customs.includes('Acme')) {
    console.error('FAIL false sections', customs);
    process.exit(1);
}
const sw = extractSectionTitles(orig);
if (sw.includes('Swaraj Salunke') || sw.includes('BDO India LLP')) {
    console.error('FAIL swaraj false sections', sw);
    process.exit(1);
}
if (looksLikeSectionHeader('Software Engineer', [], { nextLine: 'Jul 2023 – Present', prevBlank: true })) {
    console.error('FAIL job title treated as section');
    process.exit(1);
}
console.log('swaraj sections:', sw);
console.log(buildLayoutLockBlock(custom).split('\n').find((l) => l.includes('Section titles')));
console.log('dynamic structure ok');
