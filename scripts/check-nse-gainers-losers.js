/**
 * Self-check: NSE NIFTY 50 top gainers/losers fetch (same feed as the website page).
 * Run: node scripts/check-nse-gainers-losers.js
 */
import { nseMarketDataService } from '../src/services/NseMarketDataService.js';

const gl = await nseMarketDataService.fetchNiftyTopGainersLosers({ each: 5 });
const g = gl.gainers || [];
const l = gl.losers || [];

console.assert(g.length >= 1, 'expected at least 1 NIFTY gainer');
console.assert(l.length >= 1, 'expected at least 1 NIFTY loser');
console.assert(g.every((r) => r.symbol), 'gainer missing symbol');
console.assert(l.every((r) => r.symbol), 'loser missing symbol');

console.log('OK', {
    timestamp: gl.timestamp,
    gainers: g.map((r) => `${r.symbol} ${r.changePct}`),
    losers: l.map((r) => `${r.symbol} ${r.changePct}`),
});
