import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const BASE = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.nseindia.com/option-chain',
};

async function cookieFrom(page) {
    const r = await axios.get(page, {
        headers: { ...BASE, Accept: 'text/html,application/xhtml+xml' },
        timeout: 20000,
    });
    return r.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ') || '';
}

async function tryApi(cookie, path) {
    try {
        const { data, status } = await axios.get(`https://www.nseindia.com/api/${path}`, {
            headers: { ...BASE, Cookie: cookie },
            timeout: 20000,
        });
        const n = Array.isArray(data?.data) ? data.data.length : Array.isArray(data) ? data.length : '?';
        console.log('OK', path, status, 'items', n);
        return true;
    } catch (e) {
        console.log('FAIL', path, e.response?.status);
        return false;
    }
}

const pages = [
    'https://www.nseindia.com/option-chain',
    'https://www.nseindia.com/market-data/live-market-indices',
    'https://www.nseindia.com/market-data/live-equity-market',
];

for (const page of pages) {
    console.log('\n--- cookie from', page);
    const c = await cookieFrom(page);
    console.log('cookie len', c.length);
    if (!c) continue;
    await tryApi(c, 'allIndices');
    await tryApi(c, 'equity-stockIndices?index=NIFTY%20IT');
    await tryApi(c, 'fiidiiTradeReact');
}
