/**
 * Live preview of the /index card using the real analyze() path — hits NSE
 * option chain + Yahoo intraday.
 *
 * Usage: node scripts/preview-index-live.js [SYMBOL] [HH:MM_IST]
 *   node scripts/preview-index-live.js                      # NIFTY, real now
 *   node scripts/preview-index-live.js BANKNIFTY            # BANKNIFTY, real now
 *   node scripts/preview-index-live.js NIFTY 11:00          # NIFTY, faked to 11:00 IST today
 *
 * The 2nd argument shifts Date.now() to that IST time TODAY so the strategy
 * engines (which gate off after 15:00) can be previewed with live data. This
 * is a preview shortcut only — the option-chain snapshot is still whatever
 * NSE returns right now; only the clock is faked.
 */
import { indexAnalysisService } from '../src/services/IndexAnalysisService.js';

const symbol = (process.argv[2] || 'NIFTY').trim();
const fakeTime = process.argv[3] || null;

function fakeClockToIst(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) throw new Error(`Bad time: ${hhmm} (expected HH:MM IST)`);
    const hh = Number(m[1]), mm = Number(m[2]);
    // Anchor to today's IST midnight and add hh:mm. IST is UTC+5:30.
    const nowIst = new Date(Date.now() + 5.5 * 3600e3);
    const y = nowIst.getUTCFullYear(), mo = nowIst.getUTCMonth(), d = nowIst.getUTCDate();
    const targetUtc = Date.UTC(y, mo, d, hh, mm) - 5.5 * 3600e3;
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
        construct(t, args) { return args.length ? new t(...args) : new t(targetUtc); },
        apply() { return new RealDate(targetUtc).toString(); },
    });
    Date.now = () => targetUtc;
    return targetUtc;
}

(async () => {
    if (fakeTime) {
        const ts = fakeClockToIst(fakeTime);
        console.log(`# clock faked to ${new Date(ts + 5.5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} IST`);
    }
    try {
        const analysis = await indexAnalysisService.analyze(symbol);
        console.log(indexAnalysisService.format(analysis));
    } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
    }
})();
