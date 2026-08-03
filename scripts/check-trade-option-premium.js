/**
 * Self-check: ATM premium enforce rewrites bogus spot-as-entry premiums.
 * Run: node scripts/check-trade-option-premium.js
 */
import assert from 'assert';
import {
    enforceLiveOptionPremiums,
    isBogusOptionPremium,
} from '../src/utils/tradeQuoteUtils.js';

assert.equal(isBogusOptionPremium(2850, 2850), true);
assert.equal(isBogusOptionPremium(1200, 2850), true);
assert.equal(isBogusOptionPremium(42, 2850), false);

const body = `Stock: RELIANCE
Spot Price: 2850 INR

━━━ CALL (CE) SETUP ━━━
Verdict: ✅ BUY CE
Confidence: 78%
Strike: 3000 · weekly
Entry: 2850
Target 1: 2900
Target 2: 2950
Target 3: 3000
Stop Loss: 2800
Why:
• fake spot as premium

━━━ PUT (PE) SETUP ━━━
Verdict: ❌ AVOID
Confidence: 40%
Strike: 2700
Entry: 12
Target 1: 18
Target 2: 22
Target 3: 28
Stop Loss: 8
Why:
• ok premium

Primary Pick: ✅ BUY CE
Primary Confidence: 78%`;

const snap = {
    atmStrike: 2850,
    expiry: '07-Aug-2025',
    spot: 2850,
    atmCe: { strike: 2850, ltp: 48.5 },
    atmPe: { strike: 2850, ltp: 41.2 },
};

const out = enforceLiveOptionPremiums(body, snap);
assert.match(out, /Entry: ₹48\.5 \(NSE ATM LTP\)/);
assert.match(out, /Strike: 2850 · 07-Aug-2025 \(ATM · NSE LTP\)/);
assert.match(out, /Entry: ₹41\.2 \(NSE ATM LTP\)/);
assert.doesNotMatch(out, /^Entry: 2850$/m);
assert.match(out, /Target 1: ₹60\.63/); // 48.5 * 1.25

console.log('OK trade option premium enforce');
