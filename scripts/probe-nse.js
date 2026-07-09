import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function probe(page, referer) {
    const r = await axios.get(page, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 20000,
    });
    const cookies = r.headers['set-cookie']?.map((c) => c.split(';')[0]).join('; ') || '';
    console.log('PAGE', page, 'status', r.status, 'cookieLen', cookies.length);
    if (!cookies) return;

    for (const path of ['allIndices', 'equity-stockIndices?index=NIFTY%20IT', 'fiidiiTradeReact']) {
        try {
            const api = await axios.get(`https://www.nseindia.com/api/${path}`, {
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/json, text/plain, */*',
                    Cookie: cookies,
                    Referer: referer || page,
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 20000,
            });
            const d = api.data;
            const n = Array.isArray(d?.data) ? d.data.length : Array.isArray(d) ? d.length : JSON.stringify(d).slice(0, 80);
            console.log('  OK', path, '->', n);
        } catch (e) {
            console.log('  FAIL', path, e.response?.status, String(e.response?.data || e.message).slice(0, 100));
        }
    }
}

await probe('https://www.nseindia.com/', 'https://www.nseindia.com/');
await probe('https://www.nseindia.com/market-data/live-equity-market', 'https://www.nseindia.com/market-data/live-equity-market');
