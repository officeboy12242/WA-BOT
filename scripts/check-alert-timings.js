/**
 * Checks for alert timestamping — scan clock, price clock, send clock.
 * Pure functions, no network.
 * Run: node scripts/check-alert-timings.js
 */
import {
    istClock, formatAlertTimings, withSentStamp,
    parseNseTimestamp, premiumAgeMinutes, STALE_PREMIUM_MIN,
} from '../src/utils/tradeScanFormatter.js';
import { wrapTradeAlertMessage } from '../src/prompts/tradeAnalysisPrompt.js';

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${label}`); } };

// ------------------------------------------------------------------ istClock
// 04:00Z is 09:30 IST. Seconds are kept because delivery lag is a seconds-scale
// question — HH:MM alone cannot distinguish 12s of lag from 70s.
ok(istClock(Date.parse('2026-08-12T04:00:00Z')) === '09:30:00', '04:00Z -> 09:30:00 IST');
ok(istClock(Date.parse('2026-08-12T04:00:09Z')) === '09:30:09', 'seconds are preserved');
ok(istClock(Date.parse('2026-08-12T18:35:00Z')) === '00:05:00', 'past-midnight IST wraps correctly');
ok(/^\d{2}:\d{2}:\d{2}$/.test(istClock()), 'default arg returns a well-formed clock');

// -------------------------------------------------------------- timing block
const t = Date.parse('2026-08-12T04:00:00Z');
const all = formatAlertTimings({ scannedAt: t, chainTimestamp: '12-Aug-2026 09:29:59', sentAt: t + 65_000 });
ok(all.includes('Scanned 09:30:00'), 'scan clock rendered');
ok(all.includes('Priced 09:29:59'), "NSE's own price clock is used verbatim");
ok(all.includes('Sent 09:31:05'), 'send clock rendered');
ok(all.includes('IST'), 'timezone stated');

// each clock is independently optional
ok(formatAlertTimings({}) === '', 'no timings -> empty string, not a bare header');
ok(formatAlertTimings({ scannedAt: t }).includes('Scanned'), 'scan alone renders');
ok(!formatAlertTimings({ scannedAt: t }).includes('Sent'), 'no send time -> no send row');
ok(!formatAlertTimings({ scannedAt: t }).includes('Priced'), 'no price time -> no price row');

// chainTimestamp wins over pricedAt: NSE's clock is what the premiums were valid at
const both = formatAlertTimings({ chainTimestamp: '12-Aug-2026 09:29:59', pricedAt: t });
ok(both.includes('09:29:59') && !both.includes('Priced 09:30:00'),
    "NSE chain timestamp preferred over our own fetch time");
// a chainTimestamp we cannot parse is still shown rather than dropped
ok(formatAlertTimings({ chainTimestamp: 'weird-format' }).includes('weird-format'),
    'unparseable chain timestamp falls back to printing it raw');
// pricedAt is used when NSE gave us nothing
ok(formatAlertTimings({ pricedAt: t }).includes('Priced 09:30:00'), 'pricedAt used when chainTimestamp absent');

// garbage in must not produce "Invalid Date"
for (const bad of [{ scannedAt: 'nonsense' }, { scannedAt: NaN }, { scannedAt: {} }, { sentAt: 'x' }]) {
    const out = formatAlertTimings(bad);
    ok(!/NaN|Invalid/.test(out), `unparseable input yields no NaN/Invalid (${JSON.stringify(bad)})`);
}
ok(formatAlertTimings(null) === '', 'null input safe');

// accepts Date, epoch ms, and ISO string alike
ok(formatAlertTimings({ scannedAt: new Date(t) }).includes('09:30:00'), 'accepts a Date');
ok(formatAlertTimings({ scannedAt: t }).includes('09:30:00'), 'accepts epoch ms');
ok(formatAlertTimings({ scannedAt: '2026-08-12T04:00:00Z' }).includes('09:30:00'), 'accepts an ISO string');

// --------------------------------------------------------------- send stamp
const stamped = withSentStamp('CARD BODY', t);
ok(stamped.startsWith('CARD BODY'), 'original text preserved');
ok(stamped.includes('Sent 09:30:00 IST'), 'send clock appended');
ok(!/live at that moment/.test(stamped), 'does NOT assert freshness — false on a stale card');
// appending (not placeholder substitution) means a forgetful caller loses the line,
// never leaks a raw token into a subscriber chat
ok(!/\{\{|\}\}/.test(stamped), 'no placeholder tokens in output');
ok(withSentStamp('') === '', 'empty text stays empty');
ok(withSentStamp('   ').trim() === '', 'whitespace-only text is not stamped');
ok(withSentStamp(null) === '', 'null text safe');
ok(withSentStamp(undefined) === '', 'undefined text safe');
// idempotency is NOT claimed — but double-stamping must not corrupt the card
const twice = withSentStamp(withSentStamp('BODY', t), t);
ok(twice.startsWith('BODY'), 'double stamping does not corrupt the body');

// ----------------------------------------------------------------- full card
const card = wrapTradeAlertMessage('RELIANCE', 'Stock: Reliance\nSpot Price: 1330', {
    isDaily: true,
    meta: {
        entryState: { label: 'Live entry' },
        freshness: 'live quote',
        timings: { scannedAt: t, chainTimestamp: '12-Aug-2026 09:29:59' },
    },
});
ok(card.includes('Scanned 09:30:00'), 'daily card carries the scan clock');
ok(card.includes('Priced 09:29:59'), 'daily card carries the price clock');
ok(!card.includes('Sent '), 'card does NOT pre-claim a send time — that is stamped at send');
ok(card.indexOf('Scanned') < card.indexOf('Not financial advice'), 'timings sit above the disclaimer');
ok(card.includes('Not financial advice'), 'disclaimer still present');

// a card with no timings must look exactly as before
const plain = wrapTradeAlertMessage('RELIANCE', 'body', { isDaily: true, meta: { entryState: { label: 'x' } } });
ok(!plain.includes('Scanned'), 'no timings -> no timing line');
ok(plain.includes('Not financial advice'), 'plain card still complete');
const onDemand = wrapTradeAlertMessage('RELIANCE', 'body', { isDaily: false });
ok(onDemand.includes('TRADE ANALYSIS'), 'on-demand card unaffected');

// the realistic end-to-end shape: built, then stamped at send
const sent = withSentStamp(card, t + 143_000);
ok(sent.includes('Scanned 09:30:00'), 'scan clock survives stamping');
ok(sent.includes('Sent 09:32:23'), 'send clock added after build');
ok(sent.lastIndexOf('Sent 09:32:23') > sent.indexOf('Not financial advice'),
    'send stamp lands at the very end, after the disclaimer');

// -------------------------------------------------- NSE timestamp + staleness
// NSE ships IST wall-clock. Parsing it as UTC would put every quote 5.5h off and
// silently invent staleness that is not there.
const parsed = parseNseTimestamp('12-Aug-2026 15:40:00');
ok(parsed !== null, 'NSE timestamp parses');
ok(new Date(parsed).toISOString() === '2026-08-12T10:10:00.000Z', 'parsed as IST wall-clock, not UTC');
ok(parseNseTimestamp('12-Aug-2026 15:40') !== null, 'parses without seconds');
ok(parseNseTimestamp('garbage') === null, 'garbage -> null');
ok(parseNseTimestamp('') === null, 'empty -> null');
ok(parseNseTimestamp(null) === null, 'null -> null');
ok(parseNseTimestamp('12-Zzz-2026 15:40:00') === null, 'bad month name -> null');

const at2049 = Date.parse('2026-08-12T15:19:10Z'); // 20:49:10 IST
ok(premiumAgeMinutes('12-Aug-2026 15:40:00', at2049) === 309, 'age computed in minutes');
ok(premiumAgeMinutes('garbage', at2049) === null, 'unparseable -> null age, not a bogus number');

// closed market: stale premiums must be called out, since that is the whole point
const staleOut = formatAlertTimings({ scannedAt: at2049, chainTimestamp: '12-Aug-2026 15:40:00', nowMs: at2049 });
ok(staleOut.includes('Premiums are'), 'stale quote raises a warning');
ok(staleOut.includes('5h 9m old'), 'staleness expressed in hours and minutes');
ok(staleOut.includes('re-check the chain'), 'tells the reader what to do about it');

// open market, seconds old: no warning, no noise
const at0930 = Date.parse('2026-08-12T04:00:12Z');
const freshOut = formatAlertTimings({ scannedAt: at0930, chainTimestamp: '12-Aug-2026 09:30:00', nowMs: at0930 });
ok(!freshOut.includes('Premiums are'), 'a 12-second-old quote raises no warning');
ok(freshOut.includes('Priced 09:30:00'), 'fresh quote still shows its clock');

// just under / just over the threshold
const t0 = Date.parse('2026-08-12T04:00:00Z');
const under = formatAlertTimings({ chainTimestamp: '12-Aug-2026 09:21:00', nowMs: t0 }); // 9m
const over = formatAlertTimings({ chainTimestamp: '12-Aug-2026 09:19:00', nowMs: t0 });  // 11m
ok(!under.includes('Premiums are'), `${STALE_PREMIUM_MIN}m threshold: 9m old is not flagged`);
ok(over.includes('Premiums are'), `${STALE_PREMIUM_MIN}m threshold: 11m old is flagged`);
ok(over.includes('11m old'), 'sub-2h staleness shown in minutes, not hours');

// the send stamp must NOT assert freshness — it would be a lie on a stale card
const stampLine = withSentStamp('X', at2049);
ok(!/live at that moment/i.test(stampLine), 'send stamp does not claim the premiums were live');
ok(stampLine.includes('Sent 20:49:10 IST'), 'send stamp still reports the send clock');

console.log(`\ncheck-alert-timings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
