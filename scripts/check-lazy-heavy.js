/**
 * Self-check: heavy media/pdf deps are not static imports on boot paths.
 * Run: node scripts/check-lazy-heavy.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = [
    'src/controllers/StickerController.js',
    'src/services/StickerForwarder.js',
    'src/utils/resumePdfExport.js',
    'src/utils/resumeTextExtract.js',
];

for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]fluent-ffmpeg['"]/m,
        `${file} must not static-import fluent-ffmpeg`
    );
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]wa-sticker-formatter['"]/m,
        `${file} must not static-import wa-sticker-formatter`
    );
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]pdfkit['"]/m,
        `${file} must not static-import pdfkit`
    );
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]mammoth['"]/m,
        `${file} must not static-import mammoth`
    );
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]word-extractor['"]/m,
        `${file} must not static-import word-extractor`
    );
    assert.doesNotMatch(
        src,
        /^import .+ from ['"]pdf-parse/m,
        `${file} must not static-import pdf-parse`
    );
}

const stickerCtrl = fs.readFileSync('src/controllers/StickerController.js', 'utf8');
assert.match(stickerCtrl, /await import\(['"]fluent-ffmpeg['"]\)/);
assert.match(stickerCtrl, /await import\(['"]wa-sticker-formatter['"]\)/);

console.log('OK lazy heavy imports');
