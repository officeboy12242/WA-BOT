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

const all = await axios.get('https://www.nseindia.com/api/allIndices', {
    headers: { ...BASE, Cookie: cookie },
});
const rows = all.data?.data || [];
console.log('total indices', rows.length);
console.log('sample keys', Object.keys(rows[0] || {}));

const sectors = [
    'NIFTY IT',
    'NIFTY BANK',
    'NIFTY AUTO',
    'NIFTY PHARMA',
    'NIFTY METAL',
    'NIFTY ENERGY',
    'NIFTY FMCG',
    'NIFTY REALTY',
    'NIFTY FINANCIAL SERVICES',
    'NIFTY PSU BANK',
    'NIFTY INDIA DEFENCE',
    'NIFTY OIL & GAS',
    'NIFTY MIDCAP 50',
    'NIFTY SMALLCAP 50',
];

for (const name of sectors) {
    const row = rows.find((x) => (x.index || x.indexSymbol) === name);
    if (row) {
        console.log(
            'FOUND',
            name,
            'pct',
            row.percentChange ?? row.pChange,
            'last',
            row.last ?? row.lastPrice
        );
    } else {
        console.log('MISSING', name);
    }
}

// Try NextApi endpoints
const nextPaths = [
    'nextapi/equity-stockIndices?index=NIFTY%20IT',
    'nextapi/equity-stockIndices?type=indices&index=NIFTY%20IT',
    'equity-stockIndices?type=indices&index=NIFTY%20IT',
    'NextApi/equity-stockIndices?index=NIFTY%20IT',
    'market-data-pre-open?key=NIFTYIT',
    'live-analysis-variations?index=NIFTY%20IT',
    'live-analysis-variations?index=NIFTY%20BANK',
];

for (const p of nextPaths) {
    try {
        const { data, status } = await axios.get(`https://www.nseindia.com/api/${p}`, {
            headers: { ...BASE, Cookie: cookie },
            timeout: 12000,
        });
        const n = Array.isArray(data?.data) ? data.data.length : '?';
        console.log('OK', p, status, 'items', n);
    } catch (e) {
        console.log('FAIL', p, e.response?.status);
    }
}
