import axios from 'axios';
import fs from 'fs';

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

const { data } = await axios.get('https://www.nseindia.com/api/market-data-pre-open?key=ALL', {
    headers: { ...BASE, Cookie: cookie },
});
const rows = data?.data || [];
console.log('rows', rows.length);
console.log('sample metadata keys', Object.keys(rows[0]?.metadata || {}));
console.log('sample detail keys', Object.keys(rows[0]?.detail || rows[0] || {}));
console.log('sample row', JSON.stringify(rows[0], null, 2).slice(0, 1200));

const gainers = rows
    .map((row) => {
        const m = row.metadata || row;
        const d = row.detail?.preOpenMarket || row.detail || row;
        return {
            symbol: m.symbol,
            pChange: d.pChange ?? d.percentChange ?? m.pChange,
            last: d.lastPrice ?? d.iep ?? m.lastPrice,
            volume: d.totalTradedVolume ?? m.totalTradedVolume,
        };
    })
    .filter((x) => x.symbol && Number.isFinite(Number(x.pChange)))
    .sort((a, b) => Number(b.pChange) - Number(a.pChange))
    .slice(0, 10);
console.log('\ntop gainers from pre-open', gainers);
