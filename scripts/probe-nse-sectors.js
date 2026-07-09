import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const r = await axios.get('https://www.nseindia.com/option-chain', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    timeout: 20000,
});
const cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');

const indices = [
    'NIFTY%20IT',
    'NIFTY%20BANK',
    'NIFTY%20AUTO',
    'NIFTY%20PHARMA',
    'NIFTY%20METAL',
    'NIFTY%20FINANCIAL%20SERVICES',
    'NIFTY%20PSU%20BANK',
    'NIFTY%20INDIA%20DEFENCE',
    'NIFTY%20OIL%20%26%20GAS',
    'NIFTY%20MIDCAP%2050',
    'NIFTY%20SMALLCAP%2050',
    'NIFTY%20ENERGY',
    'NIFTY%20FMCG',
    'NIFTY%20REALTY',
];

for (const idx of indices) {
    try {
        const api = await axios.get(`https://www.nseindia.com/api/equity-stockIndices?index=${idx}`, {
            headers: {
                'User-Agent': UA,
                Cookie: cookie,
                Referer: 'https://www.nseindia.com/option-chain',
                Accept: 'application/json',
            },
            timeout: 15000,
        });
        console.log('OK', idx, 'stocks', api.data?.data?.length);
    } catch (e) {
        console.log('FAIL', idx, e.response?.status);
    }
}

// Try index names from allIndices
const all = await axios.get('https://www.nseindia.com/api/allIndices', {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.nseindia.com/option-chain' },
});
const names = (all.data?.data || [])
    .map((x) => x.index || x.indexSymbol)
    .filter((n) => /NIFTY/i.test(n) && !/TOTAL/i.test(n))
    .slice(0, 20);
console.log('\nSample index names from allIndices:', names.join(' | '));
