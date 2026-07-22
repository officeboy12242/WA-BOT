import axios from 'axios';
import { horoscopeService } from '../src/services/HoroscopeService.js';

async function test() {
    const sign = 'capricorn';
    const titleSign = 'Capricorn';

    console.log('=== Ohmanda ===');
    try {
        const r = await axios.get(`https://ohmanda.com/api/horoscope/${sign}/`, { timeout: 10000 });
        console.log(JSON.stringify(r.data, null, 2));
    } catch (e) {
        console.log('FAIL:', e.message);
    }

    console.log('\n=== Vedika ===');
    try {
        const r = await axios.get('https://api.vedika.io/sandbox/horoscope/daily', { params: { sign }, timeout: 10000 });
        console.log(JSON.stringify(r.data, null, 2));
    } catch (e) {
        console.log('FAIL:', e.message);
    }

    console.log('\n=== Horoscope App ===');
    try {
        const r = await axios.get('https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily', {
            params: { sign: titleSign, day: 'TODAY' },
            timeout: 10000,
        });
        console.log(JSON.stringify(r.data, null, 2));
    } catch (e) {
        console.log('FAIL:', e.message);
    }

    console.log('\n=== fetchHoroscope result ===');
    const data = await horoscopeService.fetchHoroscope('capricorn');
    console.log(JSON.stringify(data, null, 2));

    console.log('\n=== formatted message ===');
    console.log(horoscopeService.formatMessage(data));
}

test().catch(console.error);
