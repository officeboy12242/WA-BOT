/**
 * Self-check: resume text extract for txt (+ optional docx/pdf if deps work).
 * Run: node scripts/check-resume-extract.js
 */
import assert from 'assert';
import fs from 'fs';
import {
    extractResumeText,
    detectResumeKind,
    sniffResumeKind,
    unwrapResumeBuffer,
} from '../src/utils/resumeTextExtract.js';

assert.strictEqual(detectResumeKind('me.pdf', 'application/pdf'), 'pdf');
assert.strictEqual(detectResumeKind('me.docx', ''), 'docx');
assert.strictEqual(detectResumeKind('me.doc', 'application/msword'), 'doc');
assert.strictEqual(detectResumeKind('me.txt', 'text/plain'), 'txt');
assert.strictEqual(detectResumeKind('document', 'application/octet-stream'), null);

const sample = Buffer.from(
    'Jane Doe\nSoftware Engineer\nExperience: Acme Corp 2020-2024 — built APIs in Node.js and Python.\n' +
        'Education: B.Tech Computer Science, Example University.\nSkills: JavaScript, MongoDB, WhatsApp integrations.',
    'utf8'
);

const out = await extractResumeText(sample, { fileName: 'resume.txt', mimetype: 'text/plain' });
assert.ok(out.text.includes('Jane Doe'));
assert.strictEqual(out.kind, 'txt');

// WA-style: octet-stream + no extension → sniff as txt
const sniffedTxt = await extractResumeText(sample, {
    fileName: 'document',
    mimetype: 'application/octet-stream',
});
assert.ok(sniffedTxt.text.includes('Jane Doe'));
assert.strictEqual(sniffedTxt.kind, 'txt');
assert.strictEqual(sniffResumeKind(sample), 'txt');

let rejected = false;
try {
    await extractResumeText(Buffer.from('short'), { fileName: 'x.txt', mimetype: 'text/plain' });
} catch {
    rejected = true;
}
assert.ok(rejected, 'short txt should fail');

// Multipart-wrapped PDF (browser download artifact)
const atsPath = 'c:/Users/jaikishanbagul/Downloads/Jaikishan_Bagul_ATS_Resume (1).pdf';
if (fs.existsSync(atsPath)) {
    const pdf = fs.readFileSync(atsPath);
    assert.strictEqual(sniffResumeKind(pdf), 'pdf');

    const wrapped = Buffer.concat([
        Buffer.from(
            '------WebKitFormBoundaryABC\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/pdf\r\n\r\n',
            'utf8'
        ),
        pdf,
        Buffer.from('\r\n------WebKitFormBoundaryABC--\r\n', 'utf8'),
    ]);
    const unwrapped = unwrapResumeBuffer(wrapped);
    assert.ok(unwrapped.subarray(0, 5).toString() === '%PDF-');

    const fromWrapped = await extractResumeText(wrapped, {
        fileName: 'document',
        mimetype: 'application/octet-stream',
    });
    assert.ok(fromWrapped.text.length >= 40, 'wrapped PDF should extract');
    assert.strictEqual(fromWrapped.kind, 'pdf');

    // ReportLab dual-filter PDF that pdf-parse sometimes rejects
    const rlPath = 'c:/Users/jaikishanbagul/Downloads/Jaikishan_Resume_22-07.pdf';
    if (fs.existsSync(rlPath)) {
        const rl = await extractResumeText(fs.readFileSync(rlPath), {
            fileName: 'resume.pdf',
            mimetype: 'application/pdf',
        });
        assert.ok(rl.text.length >= 40, 'ReportLab PDF should salvage via streams');
        assert.ok(/jaikishan|bagul|experience|skills/i.test(rl.text), 'salvaged text looks like a resume');
    }
}

console.log('resume extract self-check ok');
