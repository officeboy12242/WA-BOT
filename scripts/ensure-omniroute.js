/**
 * Install OmniRoute into node_modules when OMNIROUTE_EMBED=true.
 * Runs on `npm start` via prestart (after Docker COPY) — not postinstall,
 * because Docker runs npm ci before the app source is copied.
 *
 * Usage: node scripts/ensure-omniroute.js
 */

import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load .env for local runs (Render injects env without this)
try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.join(root, '.env') });
} catch {
    /* optional */
}

export function resolveOmniRouteLaunch() {
    const override = (process.env.OMNIROUTE_BIN || '').trim();
    if (override && override !== 'omniroute') {
        if (override.endsWith('.mjs') || override.endsWith('.js')) {
            return { command: process.execPath, argsPrefix: [override] };
        }
        return { command: override, argsPrefix: [] };
    }

    try {
        const require = createRequire(path.join(root, 'package.json'));
        const pkgDir = path.dirname(require.resolve('omniroute/package.json'));
        const bin = path.join(pkgDir, 'bin', 'omniroute.mjs');
        if (existsSync(bin)) {
            return { command: process.execPath, argsPrefix: [bin] };
        }
    } catch {
        /* not installed */
    }

    const localBin = path.join(root, 'node_modules', '.bin', 'omniroute');
    if (existsSync(localBin) || existsSync(`${localBin}.cmd`)) {
        return { command: localBin, argsPrefix: [] };
    }

    return { command: 'omniroute', argsPrefix: [] };
}

export function isOmniRoutePackageInstalled() {
    try {
        const require = createRequire(path.join(root, 'package.json'));
        require.resolve('omniroute/package.json');
        return true;
    } catch {
        return false;
    }
}

function main() {
    if (process.env.OMNIROUTE_EMBED !== 'true') {
        console.log('ensure-omniroute: skip (set OMNIROUTE_EMBED=true to auto-install)');
        return;
    }

    if (isOmniRoutePackageInstalled()) {
        console.log('ensure-omniroute: omniroute already in node_modules');
        return;
    }

    console.log('ensure-omniroute: installing omniroute (large package, first deploy may take a while)...');
    const result = spawnSync(
        'npm',
        ['install', 'omniroute', '--no-save', '--no-audit', '--no-fund', '--prefer-offline'],
        {
            cwd: root,
            stdio: 'inherit',
            shell: true,
            env: process.env,
        }
    );

    if (result.status !== 0) {
        console.error('ensure-omniroute: install failed — embed will be unavailable');
        // Don't fail the whole deploy/start; bot can run without OmniRoute
        process.exit(0);
    }

    if (!isOmniRoutePackageInstalled()) {
        console.error('ensure-omniroute: install finished but package still missing');
        process.exit(0);
    }

    console.log('ensure-omniroute: ready');
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
    main();
}
