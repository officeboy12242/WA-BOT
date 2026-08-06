/**
 * Self-check: morning pick Format B + live premium refresh.
 * Run: node scripts/check-morning-pick.js
 */
import assert from 'assert';
import {
    selectMorningPick,
    formatMorningPickCard,
    parseLegLevels,
    pickStrategy,
} from '../src/utils/tradeMorningPick.js';

const bodyA = `━━━ CALL (CE) SETUP ━━━
Verdict: ✅ BUY CE
Confidence: 82%
Strike: 2500 · weekly
Entry: 40
Target 1: 60
Target 2: 75
Target 3: 90
Stop Loss: 28

━━━ PUT (PE) SETUP ━━━
Verdict: ❌ AVOID
Confidence: 30%
Entry: 12
Stop Loss: 8

Primary Pick: ✅ BUY CE`;

const bodyB = `━━━ CALL (CE) SETUP ━━━
Verdict: ❌ AVOID
Confidence: 40%
Entry: 20

━━━ PUT (PE) SETUP ━━━
Verdict: ✅ BUY PE
Confidence: 74%
Strike: 980
Entry: 22
Target 1: 35
Target 2: 42
Target 3: 50
Stop Loss: 15

Primary Pick: ✅ BUY PE`;

const levels = parseLegLevels(bodyA, 'CE');
assert.equal(levels.entry, 40);
assert.equal(levels.sl, 28);
assert.equal(levels.t1, 60);

assert.equal(pickStrategy({ discoverySource: 'heatmap' }), 'Opening Range Breakout + 8 EMA');
assert.equal(
    pickStrategy({ discoverySource: 'nse', confluence: 60, signal: { confidence: 80 } }),
    'Momentum continuation'
);

const pick = selectMorningPick(
    [
        {
            symbol: 'RELIANCE',
            signal: { recommendation: 'BUY CE', confidence: 82, isBuyCall: true, isActionable: true },
            resultEntry: { confluence: 58, isHiddenGem: false },
            softGate: false,
            body: bodyA,
        },
        {
            symbol: 'TATASTEEL',
            signal: { recommendation: 'BUY PE', confidence: 74, isBuyPut: true, isActionable: true },
            resultEntry: { confluence: 42, isHiddenGem: true },
            softGate: true,
            body: bodyB,
        },
    ],
    { discoverySource: 'heatmap' }
);

assert.equal(pick.winner.symbol, 'RELIANCE');
assert.equal(pick.winner.side, 'CE');
assert.equal(pick.ranked.length, 2);

const cardLive = formatMorningPickCard(pick, {
    live: { entry: 46.5, strike: 2500, expiry: '07-Aug-2026', pcr: 0.92 },
    discoverySource: 'heatmap',
});
assert.match(cardLive, /🏆 \*MORNING PICK\*/);
assert.match(cardLive, /Prem/);
assert.match(cardLive, /46\.5/);
assert.match(cardLive, /RELIANCE/);
assert.match(cardLive, /LIVE ENTRY/);
assert.match(cardLive, /fresh NSE ATM LTP/);
assert.match(cardLive, /Opening Range Breakout \+ 8 EMA/);
// SL/T scaled from alert 40 → live 46.5 (1-decimal display)
assert.match(cardLive, /SL ₹32\.5/);
assert.match(cardLive, /T1 ₹69\.8/);

const cardAlert = formatMorningPickCard(pick, { live: null });
assert.match(cardAlert, /from alert/);
assert.match(cardAlert, /₹40/);

console.log('OK morning pick Format B + live premium');
