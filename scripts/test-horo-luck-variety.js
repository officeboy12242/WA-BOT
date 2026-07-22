import axios from 'axios';
import { horoscopeService } from '../src/services/HoroscopeService.js';

const signs = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'];

async function probeVedika() {
    console.log('=== Vedika raw per sign ===');
    for (const sign of ['leo', 'capricorn', 'aries']) {
        try {
            const r = await axios.get('https://api.vedika.io/sandbox/horoscope/daily', {
                params: { sign },
                timeout: 10000,
            });
            const d = r.data?.data || {};
            console.log(sign, '→', {
                apiSign: d.sign,
                luckyNumber: d.luckyNumber ?? d.lucky_number,
                luckyColor: d.luckyColor ?? d.lucky_color,
                compatible: d.compatibleSign ?? d.compatibility,
            });
        } catch (e) {
            console.log(sign, 'FAIL', e.message);
        }
    }
}

async function probeService() {
    console.log('\n=== Bot fetchHoroscope extras ===');
    horoscopeService._cache.clear();
    for (const sign of signs) {
        const data = await horoscopeService.fetchHoroscope(sign);
        console.log(
            `${sign.padEnd(12)} #${data.luckyNumber}  ${String(data.luckyColor).padEnd(12)} mood=${data.mood} match=${data.compatibility}`
        );
    }
}

await probeVedika();
await probeService();
