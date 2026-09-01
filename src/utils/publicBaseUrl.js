/**
 * Resolve the public base URL used for movie /d/:code short links.
 * Prefer platform-injected values — no PUBLIC_URL env required on Koyeb/Render.
 *
 * Priority:
 *   1. PUBLIC_URL (optional override)
 *   2. RENDER_EXTERNAL_URL (Render injects)
 *   3. KOYEB_PUBLIC_DOMAIN (Koyeb injects for public web services)
 *   4. Host learned from inbound HTTP (x-forwarded-host / host)
 *   5. ''  — caller may fall back to localhost for local dev
 */

/** @type {string} */
let learnedPublicBase = '';

function stripSlash(s) {
    return String(s || '').trim().replace(/\/$/, '');
}

function normalizeDomain(raw) {
    const d = stripSlash(String(raw || '').replace(/^https?:\/\//i, ''));
    if (!d) return '';
    // Reject loopback / private-looking hosts — never mint TinyURLs against these.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(d)) return '';
    if (/\.internal$/i.test(d)) return '';
    return d;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} https://… or ''
 */
export function resolvePublicBaseUrl(env = process.env) {
    const explicit = stripSlash(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '');
    if (explicit) return explicit;

    const koyeb = normalizeDomain(env.KOYEB_PUBLIC_DOMAIN);
    if (koyeb) return `https://${koyeb}`;

    if (learnedPublicBase) return learnedPublicBase;

    return '';
}

/**
 * Remember the public host from an inbound HTTP request (Koyeb/Render proxy).
 * Safe no-op for localhost / internal hosts.
 * @param {import('http').IncomingMessage} req
 */
export function learnPublicBaseFromRequest(req) {
    if (learnedPublicBase) return;
    const xfHost = String(req?.headers?.['x-forwarded-host'] || '')
        .split(',')[0]
        .trim();
    const host = normalizeDomain(xfHost || req?.headers?.host || '');
    if (!host) return;
    const xfProto = String(req?.headers?.['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim()
        .toLowerCase();
    const proto = xfProto === 'http' || xfProto === 'https' ? xfProto : 'https';
    learnedPublicBase = `${proto}://${host}`;
}

/** @internal test helper */
export function _resetLearnedPublicBaseForTests() {
    learnedPublicBase = '';
}
