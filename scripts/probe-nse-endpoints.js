import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const BASE = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.nseindia.com/option-chain',
};

const r = await axios.get('https://www.nseindia.com/option-chain', {
    headers: { ...BASE, Accept: 'text/html' },
    timeout: 20000,
});
const cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');

const paths = [
    'equity-stockIndices?index=NIFTY%2050',
    'equity-stockIndices?index=NIFTY%20BANK',
    'equity-stockIndices?index=SECURITIES%20IN%20F%26O',
    'equity-stockIndices?index=NIFTY%20TOTAL%20MARKET',
    'index-contributors?index=NIFTY%20IT',
    'index-contributors?index=NIFTY%20BANK',
    'Merged-daily-reports?key=index&index=NIFTY%20IT',
    'historical/indicesHistory?indexType=NIFTY%20IT&from=01-07-2026&to=04-07-2026',
    'market-data-pre-open?key=ALL',
    'allIndices',
    'equity-master',
    'equity-stock?symbol=TCS',
    'quote-equity?symbol=TCS',
    'marketStatus',
];

for (const p of paths) {
    try {
        const { data, status } = await axios.get(`https://www.nseindia.com/api/${p}`, {
            headers: { ...BASE, Cookie: cookie },
            timeout: 12000,
        });
        const preview =
            typeof data === 'string'
                ? data.slice(0, 60)
                : JSON.stringify(data).slice(0, 100);
        const n = Array.isArray(data?.data) ? data.data.length : '';
        console.log('OK', status, p, n, preview);
    } catch (e) {
        console.log('FAIL', e.response?.status, p);
    }
}
