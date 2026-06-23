/**
 * Owner-only /deploy command — triggers a Render redeploy of the latest commit.
 * Polls deploy status and notifies when complete.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

const RENDER_API = 'https://api.render.com/v1';
const POLL_INTERVAL_MS = 5000; // Check every 5 seconds
const MAX_POLL_MS = 30 * 60 * 1000; // Max 30 minutes

async function renderFetch(path, method = 'GET', body = undefined) {
    const res = await fetch(`${RENDER_API}${path}`, {
        method,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.RENDER_API_KEY}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Render API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

async function getLatestCommitMessage() {
    try {
        const res = await fetch('https://api.github.com/repos/officeboy12242/WA-BOT/commits?per_page=1');
        if (!res.ok) return 'unknown';
        const data = await res.json();
        if (!Array.isArray(data) || !data[0]) return 'unknown';
        const msg = data[0].commit?.message?.split('\n')[0] || 'unknown';
        return msg.slice(0, 60);
    } catch {
        return 'unknown';
    }
}

async function pollDeployStatus(deployId, sock, chatId, deployMsgKey, initialNotifyCallback) {
    const startTime = Date.now();

    const poll = async () => {
        try {
            const deploy = await renderFetch(
                `/services/${config.RENDER_SERVICE_ID}/deploys/${deployId}`,
            );

            const status = deploy.status || 'unknown';
            logger.debug(`Deploy ${deployId} status: ${status}`);

            if (status === 'live') {
                await initialNotifyCallback({
                    status: 'complete',
                    message: '✅ *Deploy complete!*\n\n🚀 Bot is live with latest code.',
                });
                return;
            }

            if (status === 'canceled' || status === 'build_failed' || status === 'deploy_failed') {
                await initialNotifyCallback({
                    status: 'failed',
                    message: `❌ *Deploy failed* — ${status}`,
                });
                return;
            }

            if (Date.now() - startTime > MAX_POLL_MS) {
                await initialNotifyCallback({
                    status: 'timeout',
                    message: '⏱️ *Deploy timeout* — still building. Check Render dashboard for details.',
                });
                return;
            }

            setTimeout(poll, POLL_INTERVAL_MS);
        } catch (err) {
            logger.warn(`Deploy poll failed: ${err.message}`);
            if (Date.now() - startTime < 30000) {
                setTimeout(poll, POLL_INTERVAL_MS);
            }
        }
    };

    poll();
}

export async function handleDeploy(sock, chatId, senderJid, originalMsg) {
    if (!config.RENDER_API_KEY || !config.RENDER_SERVICE_ID) {
        await sock.sendMessage(chatId, {
            text: '❌ Render deploy not configured.\nSet `RENDER_API_KEY` and `RENDER_SERVICE_ID` in .env.',
        }, { quoted: originalMsg });
        return;
    }

    try {
        const commitMsg = await getLatestCommitMessage();

        const deployId = (await renderFetch(
            `/services/${config.RENDER_SERVICE_ID}/deploys`,
            'POST',
            { clearCache: 'do_not_clear' },
        )).id;

        const deployMsg = await sock.sendMessage(chatId, {
            text:
                `📤 *Deploy started*\n\n` +
                `💬 *Commit:* ${commitMsg}\n` +
                `🔄 *Status:* Building…\n\n` +
                `_Polling for completion…_`,
        }, { quoted: originalMsg });

        logger.info(`Render deploy triggered by ${senderJid}: deploy=${deployId} commit=${commitMsg}`);

        pollDeployStatus(deployId, sock, chatId, deployMsg?.key, async (result) => {
            try {
                await sock.sendMessage(chatId, {
                    text: result.message,
                    edit: deployMsg?.key,
                });
            } catch (err) {
                logger.warn(`Could not send deploy completion notice: ${err.message}`);
            }
        });
    } catch (err) {
        logger.error(`Render deploy failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text: `❌ Deploy failed: ${err.message}`,
        }, { quoted: originalMsg });
    }
}
