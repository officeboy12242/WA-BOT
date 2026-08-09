/**
 * See what heatmap v2 actually produces, at any time of day.
 *
 * Run: node scripts/preview-heatmap-v2.js [--at 11:30]
 *
 * Outside market hours a live scan correctly returns nothing — the last
 * session is complete, so every break is stale or past the noon cutoff. This
 * replays the most recent session as if the clock were `--at`, using the real
 * scanner, and prints both the AI context block and the `/tradelert scan` card
 * a group would receive.
 */

import { heatmapV2ScanService } from '../src/services/HeatmapV2ScanService.js';
import { formatTradeScanPreview } from '../src/utils/tradeScanFormatter.js';
import { config } from '../src/config/config.js';

const argv = process.argv.slice(2);
const atArg = (() => {
    const i = argv.indexOf('--at');
    return i >= 0 ? argv[i + 1] : '11:30';
})();
const [hh, mm = '0'] = atArg.split(':');
const asOfMinute = Number(hh) * 60 + Number(mm);

console.log(`Replaying the latest session as if it were ${atArg} IST`);
console.log(`Config: minScore=${config.HEATMAP_V2_MIN_SCORE} minMove=${config.HEATMAP_V2_MIN_MOVE_PCT}% · targets 1R / 2R\n`);

const scan = await heatmapV2ScanService.scan({ asOfMinute });

console.log('══════════ AI CONTEXT BLOCK ══════════');
console.log(heatmapV2ScanService.formatBlock(scan));

console.log('\n══════════ /tradelert scan CARD ══════════');
console.log(
    formatTradeScanPreview({
        symbols: scan.symbols,
        heatmap: scan,
        macro: scan.macro,
        discoverySource: 'heatmap2',
        scannedAt: scan.scannedAt,
        marketModeLabel: `REPLAY ${atArg}`,
        freshness: { ok: true },
        moversBrief: '',
        gates: { minConfluence: 40, minConfidence: 70 },
    })
);

console.log('\n══════════ RAW PICK ══════════');
const p = scan.picks[0];
if (!p) {
    console.log('(no picks at this time — try a different --at)');
} else {
    console.log(JSON.stringify(p, null, 2));
    if (p.setup) {
        const r = Math.abs(p.setup.entry - p.setup.stop);
        console.log(`\nR check: risk=${r.toFixed(2)} · T1 is ${((Math.abs(p.setup.target1 - p.setup.entry)) / r).toFixed(2)}R · T2 is ${((Math.abs(p.setup.target2 - p.setup.entry)) / r).toFixed(2)}R`);
    }
}
console.log(`\nScanned ${scan.candidatesScanned} candidates in ${scan.elapsedMs}ms · ${scan.picks.length} picks`);
process.exit(0);
