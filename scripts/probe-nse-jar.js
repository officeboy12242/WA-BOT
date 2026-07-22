import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

const jar = new CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
};

const sectors = ['NIFTY IT', 'NIFTY BANK', 'NIFTY 50'];

for (const sector of sectors) {
    const encoded = sector.replace(/&/g, '%26').replace(/ /g, '%20');
    const ref = `https://www.nseindia.com/market-data/live-equity-market?symbol=${encoded}`;
    await client.get(ref, { headers, timeout: 20000 });
    try {
        const { data, status } = await client.get(
            `https://www.nseindia.com/api/equity-stockIndices?index=${encoded}`,
            {
                headers: {
                    ...headers,
                    Accept: 'application/json',
                    Referer: ref,
                },
                timeout: 20000,
            }
        );
        console.log('OK', sector, status, 'stocks', data?.data?.length);
    } catch (e) {
        console.log('FAIL', sector, e.response?.status);
    }
}
