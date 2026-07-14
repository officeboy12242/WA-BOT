/**
 * Self-check: resume text extract for txt (+ optional docx/pdf if deps work).
 * Run: node scripts/check-resume-extract.js
 */
import assert from 'assert';
import { extractResumeText, detectResumeKind } from '../src/utils/resumeTextExtract.js';

assert.strictEqual(detectResumeKind('me.pdf', 'application/pdf'), 'pdf');
assert.strictEqual(detectResumeKind('me.docx', ''), 'docx');
assert.strictEqual(detectResumeKind('me.doc', 'application/msword'), 'doc');
assert.strictEqual(detectResumeKind('me.txt', 'text/plain'), 'txt');

const sample = Buffer.from(
    'Jane Doe\nSoftware Engineer\nExperience: Acme Corp 2020-2024 — built APIs in Node.js and Python.\n' +
        'Education: B.Tech Computer Science, Example University.\nSkills: JavaScript, MongoDB, WhatsApp integrations.',
    'utf8'
);

const out = await extractResumeText(sample, { fileName: 'resume.txt', mimetype: 'text/plain' });
assert.ok(out.text.includes('Jane Doe'));
assert.strictEqual(out.kind, 'txt');

let rejected = false;
try {
    await extractResumeText(Buffer.from('short'), { fileName: 'x.txt', mimetype: 'text/plain' });
} catch {
    rejected = true;
}
assert.ok(rejected, 'short txt should fail');

console.log('resume extract self-check ok');
