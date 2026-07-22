/**
 * Optional same-host OmniRoute: spawn gateway on an internal port.
 * Public traffic reaches it via AdminPanel reverse-proxy (/v1, /dashboard).
 *
 * Requires `omniroute` on PATH (npm i -g omniroute) or OMNIROUTE_BIN override.
 * Do not add the full omniroute package to this repo — it is huge.
 */

import { spawn } from 'child_process';
import http from 'http';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

function waitForHttpOk(url, { timeoutMs = 90_000, intervalMs = 1_500 } = {}) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const req = http.get(url, (res) => {
                res.resume();
                if (res.statusCode && res.statusCode < 500) {
                    resolve(true);
                    return;
                }
                retry();
            });
            req.on('error', retry);
            req.setTimeout(5_000, () => {
                req.destroy();
                retry();
            });
        };
        const retry = () => {
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`OmniRoute did not become ready within ${timeoutMs}ms (${url})`));
                return;
            }
            setTimeout(tryOnce, intervalMs);
        };
        tryOnce();
    });
}

class OmniRouteEmbed {
    constructor(cfg = config) {
        this.cfg = cfg;
        this.child = null;
        this.port = Number(cfg.OMNIROUTE_INTERNAL_PORT) || 20128;
        this.enabled = cfg.OMNIROUTE_EMBED === true;
    }

    isEnabled() {
        return this.enabled;
    }

    internalBaseUrl() {
        return `http://127.0.0.1:${this.port}/v1`;
    }

    async start() {
        if (!this.enabled) {
            return { started: false, reason: 'disabled' };
        }
        if (this.child) {
            return { started: true, reason: 'already' };
        }

        const bin = (this.cfg.OMNIROUTE_BIN || 'omniroute').trim() || 'omniroute';
        const args = ['--port', String(this.port), '--no-open'];
        logger.info(`🌐 Starting embedded OmniRoute: ${bin} ${args.join(' ')}`);

        this.child = spawn(bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PORT: String(this.port),
                // Keep OmniRoute off the public Render PORT
            },
            windowsHide: true,
        });

        this.child.stdout?.on('data', (buf) => {
            const line = String(buf).trim();
            if (line) logger.info(`[omniroute] ${line.slice(0, 300)}`);
        });
        this.child.stderr?.on('data', (buf) => {
            const line = String(buf).trim();
            if (line) logger.warn(`[omniroute] ${line.slice(0, 300)}`);
        });
        this.child.on('exit', (code, signal) => {
            logger.warn(`OmniRoute exited code=${code} signal=${signal || ''}`);
            this.child = null;
        });

        const healthUrl = `http://127.0.0.1:${this.port}/`;
        try {
            await waitForHttpOk(healthUrl);
            logger.info(`🌐 Embedded OmniRoute ready on 127.0.0.1:${this.port}`);
            return { started: true, port: this.port, baseUrl: this.internalBaseUrl() };
        } catch (err) {
            logger.error(`Embedded OmniRoute failed: ${err.message}`);
            this.stop();
            throw err;
        }
    }

    stop() {
        if (!this.child) return;
        try {
            this.child.kill('SIGTERM');
        } catch {
            /* ignore */
        }
        this.child = null;
    }
}

export default OmniRouteEmbed;
