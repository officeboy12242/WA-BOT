/**
 * Test runner — `npm test`.
 *
 * Executes every scripts/check-*.js (offline self-checks) with a per-script
 * timeout and reports a summary. Exits non-zero if any check fails so CI /
 * deploys can gate on it.
 *
 * Run: npm test   (or: node scripts/run-all-checks.js)
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(rootDir, 'scripts');

// Some self-checks pace slowly on purpose (e.g. broadcast token-issuance wait).
const PER_SCRIPT_TIMEOUT_MS = 120_000;

function runOne(scriptPath) {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [scriptPath],
            { cwd: rootDir, timeout: PER_SCRIPT_TIMEOUT_MS, windowsHide: true },
            (err) => {
                const timedOut = err?.killed === true && err?.signal === 'SIGTERM';
                resolve({
                    name: path.basename(scriptPath),
                    ok: !err,
                    reason: timedOut
                        ? `timed out after ${PER_SCRIPT_TIMEOUT_MS / 1000}s`
                        : (err?.message || 'failed'),
                });
            }
        );
    });
}

const files = readdirSync(scriptsDir)
    .filter((f) => /^check-.+\.js$/.test(f))
    .sort()
    .map((f) => path.join(scriptsDir, f));

const results = await Promise.all(files.map(runOne));

let passed = 0;
let failed = 0;
for (const r of results) {
    if (r.ok) {
        passed += 1;
        console.log(`✓ ${r.name}`);
    } else {
        failed += 1;
        console.log(`✗ ${r.name} — ${r.reason}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed (${results.length} checks)`);
if (failed > 0) {
    process.exit(1);
}
