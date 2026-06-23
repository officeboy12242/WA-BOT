/**
 * Owner-only /deploy command — triggers a Render redeploy of the latest commit.
 */

import { logger } from '../../utils/logger.js';
import { config } from '../../config/config.js';

const RENDER_API = 'https://api.render.com/v1';

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

export async function handleDeploy(sock, chatId, senderJid, originalMsg) {
    if (!config.RENDER_API_KEY || !config.RENDER_SERVICE_ID) {
        await sock.sendMessage(chatId, {
            text: '❌ Render deploy not configured.\nSet `RENDER_API_KEY` and `RENDER_SERVICE_ID` in .env.',
        }, { quoted: originalMsg });
        return;
    }

    await sock.sendMessage(chatId, {
        text: '⏳ Triggering Render deploy…',
    }, { quoted: originalMsg });

    try {
        const deploy = await renderFetch(
            `/services/${config.RENDER_SERVICE_ID}/deploys`,
            'POST',
            { clearCache: 'do_not_clear' },
        );

        const id = deploy.id || '?';
        const commit = deploy.commit?.id?.slice(0, 7) || 'latest';
        const status = deploy.status || 'created';

        await sock.sendMessage(chatId, {
            text:
                `✅ *Deploy triggered*\n\n` +
                `🔖 *Commit:* ${commit}\n` +
                `📦 *Deploy ID:* ${id}\n` +
                `📊 *Status:* ${status}\n\n` +
                `_The bot will restart automatically once the build finishes._`,
        }, { quoted: originalMsg });

        logger.info(`Render deploy triggered by ${senderJid}: deploy=${id} commit=${commit}`);
    } catch (err) {
        logger.error(`Render deploy failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text: `❌ Deploy failed: ${err.message}`,
        }, { quoted: originalMsg });
    }
}
