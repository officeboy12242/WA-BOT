/**
 * Self-check OmniRoute URL normalization + provider-order helper.
 * Run: node scripts/check-omniroute.js
 */

import OmniRouteLlmService, {
    normalizeOmniRouteBaseUrl,
    withOmniRouteFirst,
} from '../src/services/OmniRouteLlmService.js';

if (normalizeOmniRouteBaseUrl('http://localhost:20128') !== 'http://localhost:20128/v1') {
    throw new Error('should append /v1');
}
if (normalizeOmniRouteBaseUrl('http://localhost:20128/v1/') !== 'http://localhost:20128/v1') {
    throw new Error('should strip trailing slash and keep /v1');
}
if (normalizeOmniRouteBaseUrl('') !== '') {
    throw new Error('empty stays empty');
}

const off = new OmniRouteLlmService({
    OMNIROUTE_BASE_URL: 'http://localhost:20128/v1',
    OMNIROUTE_API_KEY: '',
    OMNIROUTE_MODEL: 'auto',
});
if (off.isConfigured()) throw new Error('missing key must not be configured');

const on = new OmniRouteLlmService({
    OMNIROUTE_BASE_URL: 'http://host:20128',
    OMNIROUTE_API_KEY: 'test-key',
    OMNIROUTE_MODEL: 'auto',
});
if (!on.isConfigured()) throw new Error('should be configured');
if (on.completionsUrl !== 'http://host:20128/v1/chat/completions') {
    throw new Error('bad completions url: ' + on.completionsUrl);
}

const order1 = withOmniRouteFirst(['gemini', 'groq'], true);
if (order1[0] !== 'omniroute') throw new Error('should prepend omniroute');

const order2 = withOmniRouteFirst(['omniroute', 'gemini'], true);
if (order2.filter((p) => p === 'omniroute').length !== 1) throw new Error('no duplicate');

const order3 = withOmniRouteFirst(['omniroute', 'gemini'], false);
if (order3.includes('omniroute')) throw new Error('strip when not configured');

console.log('omniroute check ok');
