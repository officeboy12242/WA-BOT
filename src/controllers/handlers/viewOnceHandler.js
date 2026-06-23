/**
 * View-once message revealer — reply to a view-once image/video/audio
 * with /vv to re-send it as a normal message.
 */

import { downloadContentFromMessage } from 'baileys';
import { logger } from '../../utils/logger.js';

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function handleViewOnce(sock, chatId, senderJid, originalMsg) {
    const quoted =
        originalMsg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;

    if (!quoted) {
        await sock.sendMessage(chatId, {
            text: '📸 *View Once Revealer* 🔓\n\n❌ Reply to a view-once message with `/vv`',
        }, { quoted: originalMsg });
        return;
    }

    const viewOnceWrapper =
        quoted.viewOnceMessageV2 ||
        quoted.viewOnceMessageV2Extension ||
        quoted.viewOnceMessage;

    if (!viewOnceWrapper) {
        await sock.sendMessage(chatId, {
            text: '❌ That is not a view-once message.',
        }, { quoted: originalMsg });
        return;
    }

    const inner = viewOnceWrapper.message;
    if (!inner) {
        await sock.sendMessage(chatId, {
            text: '❌ Could not read view-once content.',
        }, { quoted: originalMsg });
        return;
    }

    await sock.sendMessage(chatId, {
        text: '⏳ Processing view-once media…',
    }, { quoted: originalMsg });

    try {
        let mediaMsg;

        if (inner.imageMessage) {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(inner.imageMessage, 'image'),
            );
            const caption = inner.imageMessage.caption || '';
            mediaMsg = { image: buf, caption: caption || '📸 *View-once image revealed* 🔓' };
        } else if (inner.videoMessage) {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(inner.videoMessage, 'video'),
            );
            const caption = inner.videoMessage.caption || '';
            mediaMsg = { video: buf, caption: caption || '🎥 *View-once video revealed* 🔓' };
        } else if (inner.audioMessage) {
            const buf = await streamToBuffer(
                await downloadContentFromMessage(inner.audioMessage, 'audio'),
            );
            mediaMsg = {
                audio: buf,
                ptt: inner.audioMessage.ptt === true,
                mimetype: inner.audioMessage.mimetype || 'audio/ogg; codecs=opus',
            };
        } else {
            await sock.sendMessage(chatId, {
                text: '❌ Unsupported view-once media type.',
            }, { quoted: originalMsg });
            return;
        }

        await sock.sendMessage(chatId, mediaMsg, { quoted: originalMsg });
    } catch (err) {
        logger.error(`ViewOnce download failed: ${err.message}`);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to reveal view-once: ${err.message}`,
        }, { quoted: originalMsg });
    }
}
