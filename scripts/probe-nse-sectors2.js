import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function getCookie(refererPage) {
    const r = await axios.get(refererPage, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        timeout: 20000,
    });
    return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
}

const tests = [
    {
        name: 'option-chain + NIFTY 50',
        referer: 'https://www.nseindia.com/option-chain',
        index: 'NIFTY%2050',
    },
    {
        name: 'live-equity-market IT + NIFTY IT',
        referer: 'https://www.nseindia.com/market-data/live-equity-market?symbol=NIFTY%20IT',
        index: 'NIFTY%20IT',
    },
    {
        name: 'live-equity-market BANK + NIFTY BANK',
        referer: 'https://www.nseindia.com/market-data/live-equity-market?symbol=NIFTY%20BANK',
        index: 'NIFTY%20BANK',
    },
    {
        name: 'market-data + NIFTY IT',
        referer: 'https://www.nseindia.com/market-data',
        index: 'NIFTY%20IT',
    },
];

for (const t of tests) {
    try {
        const cookie = await getCookie(t.referer);
        const api = await axios.get(`https://www.nseindia.com/api/equity-stockIndices?index=${t.index}`, {
            headers: {
                'User-Agent': UA,
                Cookie: cookie,
                Referer: t.referer,
                Accept: 'application/json',
            },
            timeout: 15000,
        });
        console.log('OK', t.name, 'stocks', api.data?.data?.length, 'sample', api.data?.data?.[0]?.symbol);
    } catch (e) {
        console.log('FAIL', t.name, e.response?.status, e.response?.data?.slice?.(0, 80));
    }
}

// index-names
try {
    const cookie = await getCookie('https://www.nseindia.com/market-data');
    const names = await axios.get('https://www.nseindia.com/api/index-names', {
        headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.nseindia.com/market-data' },
    });
    const list = names.data || [];
    const sectorish = list.filter((n) => /NIFTY (IT|BANK|AUTO|PHARMA|METAL)/i.test(String(n)));
    console.log('\nindex-names sector samples:', sectorish.slice(0, 10));
} catch (e) {
    console.log('index-names FAIL', e.response?.status);
}
