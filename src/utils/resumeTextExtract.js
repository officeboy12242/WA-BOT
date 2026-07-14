/**
 * Extract plain text from resume uploads: PDF, DOC, DOCX, TXT.
 */

import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { normalizeResumeExtract } from './resumeStructure.js';

const MAX_CHARS = 80_000;

const EXT_BY_MIME = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-word': 'doc',
};

/**
 * @param {string} [fileName]
 * @param {string} [mimetype]
 * @returns {'pdf'|'doc'|'docx'|'txt'|null}
 */
export function detectResumeKind(fileName = '', mimetype = '') {
    const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
    if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];

    const name = String(fileName || '').toLowerCase();
    const m = name.match(/\.([a-z0-9]+)$/);
    const ext = m?.[1];
    if (ext === 'pdf' || ext === 'doc' || ext === 'docx' || ext === 'txt' || ext === 'text') {
        return ext === 'text' ? 'txt' : ext;
    }
    if (mime.startsWith('text/')) return 'txt';
    return null;
}

function cleanText(raw) {
    return String(raw || '')
        .replace(/\u0000/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_CHARS);
}

/**
 * @param {Buffer} buffer
 * @param {{ fileName?: string, mimetype?: string }} meta
 * @returns {Promise<{ text: string, kind: string }>}
 */
export async function extractResumeText(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('Empty file');
    }

    const kind = detectResumeKind(meta.fileName, meta.mimetype);
    if (!kind) {
        throw new Error('Unsupported file. Send PDF, DOC, DOCX, or TXT.');
    }

    let text = '';
    if (kind === 'pdf') {
        const data = await pdfParse(buffer);
        text = data?.text || '';
    } else if (kind === 'docx') {
        const result = await mammoth.extractRawText({ buffer });
        text = result?.value || '';
    } else if (kind === 'doc') {
        const extractor = new WordExtractor();
        const doc = await extractor.extract(buffer);
        text = doc?.getBody?.() || '';
    } else {
        text = buffer.toString('utf8');
    }

    text = normalizeResumeExtract(cleanText(text));
    if (text.length < 40) {
        throw new Error('Could not read enough text from that file. Try TXT or a text-based PDF.');
    }

    return { text, kind };
}
