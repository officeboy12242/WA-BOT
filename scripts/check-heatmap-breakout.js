/**
 * Self-check: EMA + OR/EMA setup evaluator (no network).
 * Run: node scripts/check-heatmap-breakout.js
 */
import assert from 'assert';
import { computeEma } from '../src/utils/ema.js';
import { evaluateOrEmaSetup, pickHeatmapCandidates, computeHeatmapSentiment } from '../src/services/HeatmapBreakoutScanService.js';

const ema = computeEma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8);
assert.ok(Number.isFinite(ema[7]));
assert.ok(ema[9] > ema[8]);

const sentiment = computeHeatmapSentiment([
    { indexPct: 1.2 },
    { indexPct: 0.8 },
    { indexPct: -0.3 },
    { indexPct: 0.5 },
]);
assert.equal(sentiment.bias, 'BULLISH');

const cands = pickHeatmapCandidates(
    {
        all: [
            {
                key: 'NIFTY AUTO',
                label: 'Auto',
                indexPct: 1.5,
                gainers: [
                    { symbol: 'M&M', changePct: 2.4 },
                    { symbol: 'MARUTI', changePct: 1.1 },
                ],
                losers: [{ symbol: 'X', changePct: -2.5 }],
            },
        ],
    },
    { bias: 'BULLISH' },
    { minMovePct: 2, topSectors: 1 }
);
assert.deepEqual(cands.map((c) => c.symbol), ['M&M']);

// Synthetic long breakout: OR then solid green close above OR high + EMA
const base = 100;
const candles = [];
const t0 = Date.parse('2026-07-23T03:45:00Z'); // 09:15 IST
candles.push({ ts: t0, open: base, high: base + 1, low: base - 1, close: base, volume: 1000 }); // OR
for (let i = 1; i <= 8; i++) {
    candles.push({
        ts: t0 + i * 15 * 60 * 1000,
        open: base + i * 0.1,
        high: base + i * 0.2,
        low: base,
        close: base + i * 0.15,
        volume: 800,
    });
}
// Breakout candle
candles.push({
    ts: t0 + 9 * 15 * 60 * 1000,
    open: base + 0.5,
    high: base + 3,
    low: base + 0.4,
    close: base + 2.8, // above OR high 101
    volume: 5000,
});
// Follow-through
candles.push({
    ts: t0 + 10 * 15 * 60 * 1000,
    open: base + 2.8,
    high: base + 4,
    low: base + 2.5,
    close: base + 3.5,
    volume: 3000,
});

const setup = evaluateOrEmaSetup(candles, { side: 'long', emaPeriod: 8 });
assert.ok(setup.status === 'triggered' || setup.status === 'breakout', setup.status);
assert.equal(setup.direction, 'long');
assert.ok(setup.score >= 50, setup.score);

console.log('OK heatmap breakout checks', { emaLast: ema[9], setupStatus: setup.status, score: setup.score });
