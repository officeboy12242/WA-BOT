/**
 * Sample output preview — run: node scripts/preview-trade-scan-sample.js
 * Shows exactly what /tradelert scan posts in WhatsApp.
 */

import { formatTradeScanPreview, formatDailyScanIntro } from '../src/utils/tradeScanFormatter.js';

const sampleDiscovery = {
    scannedAt: new Date(),
    marketMode: 'MARKET_HOURS',
    marketModeLabel: '🟢 Market hours',
    freshness: { ok: true, message: 'fresh' },
    macro: {
        nifty: { pct: 1.12 },
        vix: { last: 21.6 },
        fiiNet: 9977,
        diiNet: -2100,
        bias: { emoji: '🐂', label: 'BULLISH', score: 28 },
    },
    delta: {
        lines: ['NIFTY +0.6% since last scan', 'Sector leadership rotated'],
        hasChanges: true,
    },
    hotSectors: {
        hot: [
            {
                label: 'IT',
                indexPct: 2.1,
                gainers: [
                    { symbol: 'INFY', changePct: 2.4 },
                    { symbol: 'TCS', changePct: 1.8 },
                    { symbol: 'WIPRO', changePct: 1.5 },
                ],
            },
            {
                label: 'Defence',
                indexPct: 1.9,
                gainers: [
                    { symbol: 'BEL', changePct: 3.2 },
                    { symbol: 'HAL', changePct: 2.1 },
                ],
            },
            {
                label: 'PSU Bank',
                indexPct: 1.4,
                gainers: [
                    { symbol: 'SBIN', changePct: 1.6 },
                    { symbol: 'PNB', changePct: 1.2 },
                ],
            },
        ],
        cold: [
            { label: 'Realty', indexPct: -1.1 },
            { label: 'Metal', indexPct: -0.5 },
        ],
    },
    phase4Picks: [
        { symbol: 'INFY', sector: 'IT', score: 82, changePct: 2.4 },
        { symbol: 'BEL', sector: 'Defence', score: 78, changePct: 3.2 },
        { symbol: 'SBIN', sector: 'PSU Bank', score: 71, changePct: 1.6 },
    ],
    momentumAlerts: [
        { symbol: 'BEL', changePct: 3.2, rs: 2.1, turnoverCr: 820 },
        { symbol: 'INFY', changePct: 2.4, rs: 1.3, turnoverCr: 1200 },
        { symbol: 'RVNL', changePct: 2.8, rs: 1.7, turnoverCr: 650 },
    ],
    smartMoney: {
        deals: [
            { symbol: 'INFY', kind: 'BLOCK', valueCr: 142 },
            { symbol: 'HAL', kind: 'BULK', valueCr: 89 },
        ],
    },
    catalystHighlights: [
        '🟢 INFY — ORDER WIN',
        '🟢 BEL — BROKER UPGRADE',
        '🔴 REALTY — REGULATORY RISK',
    ],
    symbols: ['BEL', 'INFY', 'SBIN', 'HAL', 'RVNL', 'TCS', 'WIPRO', 'PNB'],
    hiddenGem: 'RVNL',
    hiddenGemReason: '+2.8% move · overlooked F&O mover',
    symbolMeta: [
        { symbol: 'BEL', sources: ['phase4', 'momentum'], confluence: 72 },
        { symbol: 'INFY', sources: ['phase4', 'smart money'], confluence: 68 },
        { symbol: 'SBIN', sources: ['phase4'], confluence: 55 },
        { symbol: 'HAL', sources: ['momentum', 'smart money'], confluence: 61 },
    ],
    gates: { minConfluence: 50, minConfidence: 70 },
};

console.log('=== /tradelert scan PREVIEW ===\n');
console.log(formatTradeScanPreview(sampleDiscovery));

console.log('\n\n=== DAILY GROUP INTRO (first message) ===\n');
console.log(
    formatDailyScanIntro(sampleDiscovery, {
        symbols: sampleDiscovery.symbols,
        hiddenGem: sampleDiscovery.hiddenGem,
        hiddenGemReason: sampleDiscovery.hiddenGemReason,
        maxSends: 5,
    })
);
