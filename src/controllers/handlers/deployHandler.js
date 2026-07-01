/**
 * Owner-only /deploy command — triggers a Render redeploy of the latest commit.
 * Status message is persisted and edited after the new instance starts.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';
import { resolveNotificationJid } from '../../utils/permissions.js';
import {
    deployNotificationService,
    serializeMessageKey,
    buildFailedText,
} from '../../services/DeployNotificationService.js';

const RENDER_API = 'https://api.render.com/v1';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MS = 30 * 60 * 1000;

async function renderFetch(path, method = 'GET', body = undefined) {
    const res = await fetch(`${RENDER_API}${path}`, {
        method,
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.RENDER_API_KEY}`,
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

async function pollDeployStatus(deployId, sock, commitMsg) {
    const startTime = Date.now();

    const poll = async () => {
        try {
            const deploy = await renderFetch(
                `/services/${config.RENDER_SERVICE_ID}/deploys/${deployId}`,
            );

            const status = deploy.status || 'unknown';
            logger.debug(`Deploy ${deployId} status: ${status}`);

            if (status === 'live') {
                // New instance will handle the edit on startup — old process is dying.
                return;
            }

            if (status === 'canceled' || status === 'build_failed' || status === 'deploy_failed') {
                const text = buildFailedText(commitMsg, deployId, status);
                await deployNotificationService.completePendingNow(sock, deployId, commitMsg, text, 'failed');
                return;
            }

            if (Date.now() - startTime > MAX_POLL_MS) {
                const text = buildFailedText(commitMsg, deployId, 'timeout — check Render dashboard');
                await deployNotificationService.completePendingNow(sock, deployId, commitMsg, text, 'failed');
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

        const startedText = deployNotificationService.buildStartedText(commitMsg, deployId);
        const deployMsg = await sock.sendMessage(chatId, { text: startedText }, { quoted: originalMsg });

        const targets = [];
        const primaryKey = serializeMessageKey(deployMsg?.key);
        if (primaryKey) {
            targets.push({ chat_id: chatId, message_key: primaryKey, label: 'request_chat' });
        }

        const logJid = resolveNotificationJid(sock, [
            config.BOT_LOG_NUMBER,
            ...config.OWNER_NUMBERS,
        ].filter(Boolean));

        if (logJid && logJid !== chatId && primaryKey) {
            try {
                const logMsg = await sock.sendMessage(logJid, {
                    text:
                        `${startedText}\n\n` +
                        `📍 _Requested from:_ \`${chatId}\``,
                });
                const logKey = serializeMessageKey(logMsg?.key);
                if (logKey) {
                    targets.push({ chat_id: logJid, message_key: logKey, label: 'bot_log' });
                }
            } catch (err) {
                logger.warn(`Deploy log copy failed: ${err.message}`);
            }
        }

        await deployNotificationService.savePending({
            deployId,
            commitMsg,
            triggeredBy: senderJid,
            targets,
        });

        logger.info(`Render deploy triggered by ${senderJid}: deploy=${deployId} commit=${commitMsg}`);

        pollDeployStatus(deployId, sock, commitMsg);
    } catch (err) {
        logger.error(`Render deploy failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text: `❌ Deploy failed: ${err.message}`,
        }, { quoted: originalMsg });
    }
}
