import axios from 'axios';

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const sectors = ['NIFTY IT', 'NIFTY BANK', 'NIFTY 50'];

for (const sector of sectors) {
    const encoded = sector.replace(/&/g, '%26').replace(/ /g, '%20');
    const ref = `https://www.nseindia.com/market-data/live-equity-market?symbol=${encoded}`;
    const page = await axios.get(ref, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        timeout: 20000,
    });
    const setCookie = page.headers['set-cookie'] || [];
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    try {
        const { data, status } = await axios.get(
            `https://www.nseindia.com/api/equity-stockIndices?index=${encoded}`,
            {
                headers: {
                    'User-Agent': UA,
                    Cookie: cookie,
                    Accept: 'application/json',
                    Referer: ref,
                },
                timeout: 20000,
            }
        );
        console.log('OK', sector, status, 'stocks', data?.data?.length, 'first', data?.data?.[1]?.symbol);
    } catch (e) {
        console.log('FAIL', sector, e.response?.status);
    }
}
