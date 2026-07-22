import https from 'https';

function fetch(urlStr) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        https
            .get(
                {
                    hostname: u.hostname,
                    path: u.pathname + u.search,
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                },
                (res) => {
                    let d = '';
                    res.on('data', (c) => {
                        d += c;
                    });
                    res.on('end', () => resolve({ status: res.statusCode, d, headers: res.headers }));
                }
            )
            .on('error', reject);
    });
}

const url = 'https://atoz.cinemaz.workers.dev/links/Gk4Nfm8yqMkQpoR';
const r = await fetch(url);
console.log('status', r.status, 'len', r.d.length, 'loc', r.headers.location);
const nd = [...r.d.matchAll(/https?:\/\/[^\s"'<>]*null-drop[^\s"'<>]*/gi)].map((m) => m[0]);
console.log('nulldrop', [...new Set(nd)]);
const hrefs = [...r.d.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log('hrefs', [...new Set(hrefs)].slice(0, 40));
console.log('--- snippet ---');
console.log(r.d.slice(0, 2000));
