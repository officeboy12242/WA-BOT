const LANGUAGE_PATTERNS = [
    { re: /\bDual[\s._-]?Audio\b/i, label: 'Dual Audio' },
    { re: /\bMulti[\s._-]?Audio\b/i, label: 'Multi Audio' },
    { re: /\bHindi\b/i, label: 'Hindi' },
    { re: /\bEnglish\b/i, label: 'English' },
    { re: /\bTamil\b/i, label: 'Tamil' },
    { re: /\bTelugu\b/i, label: 'Telugu' },
    { re: /\bMalayalam\b/i, label: 'Malayalam' },
    { re: /\bKannada\b/i, label: 'Kannada' },
    { re: /\bBengali\b/i, label: 'Bengali' },
    { re: /\bPunjabi\b/i, label: 'Punjabi' },
    { re: /\bMarathi\b/i, label: 'Marathi' },
    { re: /\bGujarati\b/i, label: 'Gujarati' },
    { re: /\bUrdu\b/i, label: 'Urdu' },
];

const AUDIO_CODEC_PATTERNS = [
    { re: /\bDD\+[\s._-]?5\.1\b/i, label: 'DD+ 5.1' },
    { re: /\bDDP[\s._-]?5\.1\b/i, label: 'DDP 5.1' },
    { re: /\bDD[\s._-]?5\.1\b/i, label: 'DD 5.1' },
    { re: /\bDD[\s._-]?2\.0\b/i, label: 'DD 2.0' },
    { re: /\bAtmos\b/i, label: 'Atmos' },
    { re: /\bAAC[\s._-]?5\.1\b/i, label: 'AAC 5.1' },
    { re: /\bAAC[\s._-]?2\.0\b/i, label: 'AAC 2.0' },
    { re: /\bE[\s._-]?AC[\s._-]?3\b/i, label: 'EAC3' },
    { re: /\bAC3\b/i, label: 'AC3' },
    { re: /\bAAC\b/i, label: 'AAC' },
    { re: /\bMP3\b/i, label: 'MP3' },
];

/**
 * Extract audio language/codec hints from a release filename.
 * @param {string} filename
 * @returns {string}
 */
export function audioFromFilename(filename) {
    if (!filename) return '';

    const hasDual = /\bDual[\s._-]?Audio\b/i.test(filename);
    const hasMulti = /\bMulti[\s._-]?Audio\b/i.test(filename);

    const languages = [];
    if (hasDual) {
        languages.push('Dual Audio');
    } else if (hasMulti) {
        languages.push('Multi Audio');
    } else {
        for (const { re, label } of LANGUAGE_PATTERNS) {
            if (re.test(filename) && !languages.includes(label)) {
                languages.push(label);
            }
        }
    }

    if (hasDual || hasMulti) {
        for (const { re, label } of LANGUAGE_PATTERNS) {
            if (label === 'Dual Audio' || label === 'Multi Audio') continue;
            if (re.test(filename) && !languages.includes(label)) {
                languages.push(label);
            }
        }
    }

    const codecs = [];
    for (const { re, label } of AUDIO_CODEC_PATTERNS) {
        if (!re.test(filename) || codecs.includes(label)) continue;
        if (label === 'AAC' && codecs.some((c) => c.startsWith('AAC'))) continue;
        if (label === 'DD 5.1' && codecs.some((c) => c.startsWith('DD'))) continue;
        codecs.push(label);
    }

    const parts = [];
    if (languages.length) parts.push(languages.join(' + '));
    if (codecs.length) parts.push(codecs.join(', '));
    return parts.join(' • ');
}
