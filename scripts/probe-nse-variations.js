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

const idx = 'NIFTY%20IT';
const { data } = await axios.get(`https://www.nseindia.com/api/live-analysis-variations?index=${idx}`, {
    headers: { ...BASE, Cookie: cookie },
});
console.log('top keys', Object.keys(data || {}));
console.log('data type', Array.isArray(data?.data) ? 'array' : typeof data?.data);
if (data?.data) {
    const arr = Array.isArray(data.data) ? data.data : Object.values(data.data);
    console.log('len', arr.length);
    console.log('sample', JSON.stringify(arr[0], null, 2).slice(0, 800));
    const gainers = arr.filter((x) => Number(x.pChange ?? x.percentChange) > 0).slice(0, 5);
    console.log(
        'top gainers',
        gainers.map((g) => `${g.symbol} ${g.pChange ?? g.percentChange}%`)
    );
}
