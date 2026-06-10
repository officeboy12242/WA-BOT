/**
 * Instagram download handler
 */

import { fileTypeFromBuffer } from 'file-type';
import { snapsave } from 'snapsave-media-downloader';
import { logger } from '../../utils/logger.js';
import { downloadMediaBuffer } from '../../utils/downloadMediaBuffer.js';
import { extractInstagramUrl, isSupportedInstagramUrl } from '../../utils/instagramUrl.js';

function formatInstaDownloadStatus(mediaList) {
    const images = mediaList.filter((m) => m.type === 'image').length;
    const videos = mediaList.filter((m) => m.type === 'video').length;
    const total = mediaList.length;

    if (images && videos) return `⏳ Downloading *${images}* image(s) and *${videos}* video(s)…\n_Please wait._`;
    if (videos) return `⏳ Downloading *${videos}* video(s)…\n_Please wait._`;
    if (images) return `⏳ Downloading *${images}* image(s)…\n_Please wait._`;
    return `⏳ Downloading *${total}* item(s)…\n_Please wait._`;
}

function formatInstaSuccessText(sentCount, total, failedCount) {
    if (failedCount > 0) {
        return (
            `✅ Downloaded *${sentCount}/${total}* item(s) successfully.\n` +
            `_${failedCount} item(s) could not be downloaded._`
        );
    }
    const label = sentCount === 1 ? 'item' : 'items';
    return `✅ Downloaded and sent *${sentCount}* ${label} successfully.`;
}

async function safeDeleteChatMessage(sock, chatId, waMessage) {
    const key = waMessage?.key;
    if (!key) return;
    try {
        await sock.sendMessage(chatId, { delete: key });
    } catch (err) {
        logger.warn(`Could not delete status message: ${err.message}`);
    }
}

async function classifyMediaBuffer(buffer) {
    const type = await fileTypeFromBuffer(buffer);
    if (!type) return { kind: 'other', mime: 'application/octet-stream', ext: 'bin' };
    const mime = type.mime;
    const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'other';
    return { kind, mime, ext: type.ext };
}

async function sendDownloadedMedia(sock, chatId, buffer, sendOpts, index) {
    const detected = await classifyMediaBuffer(buffer);
    if (detected.kind === 'video') {
        await sock.sendMessage(chatId, { video: buffer, mimetype: detected.mime }, sendOpts);
        return true;
    }
    if (detected.kind === 'image') {
        await sock.sendMessage(chatId, { image: buffer, mimetype: detected.mime }, sendOpts);
        return true;
    }
    await sock.sendMessage(
        chatId,
        { document: buffer, mimetype: detected.mime, fileName: `instagram_${index + 1}.${detected.ext || 'bin'}` },
        sendOpts
    );
    return true;
}

export async function handleInsta(sock, chatId, args, quotedMessage, options = {}) {
    const { requireCommandArgs = true } = options;
    const replyToCommand = quotedMessage ? { quoted: quotedMessage } : {};

    if (requireCommandArgs && !args.length) {
        await sock.sendMessage(
            chatId,
            {
                text:
                    'Usage: `/insta <instagram-url>` (alias `/i`)\n' +
                    'Example: `/insta https://www.instagram.com/p/xxxxx/`\n\n' +
                    'In a private chat you can also paste an Instagram link without a command.',
            },
            replyToCommand
        );
        return;
    }

    let url = extractInstagramUrl(args.join(' ').trim()) || (args[0] || '').trim();
    if (!isSupportedInstagramUrl(url)) {
        await sock.sendMessage(
            chatId,
            { text: 'Only Instagram post/reel/TV/share links from instagram.com are supported.' },
            replyToCommand
        );
        return;
    }

    let statusMsg = null;
    try {
        statusMsg = await sock.sendMessage(chatId, {
            text: '⏳ Fetching Instagram media…\n_This may take a few seconds._',
        });

        const result = await snapsave(url, { retry: 2, retryDelay: 800 });

        if (!result.success) {
            await safeDeleteChatMessage(sock, chatId, statusMsg);
            statusMsg = null;
            await sock.sendMessage(
                chatId,
                { text: `Could not fetch media. ${result.message || 'Unknown error.'}` },
                replyToCommand
            );
            return;
        }

        const data = result.data || {};
        const rawMedia = data.media || [];
        const seen = new Set();
        const mediaList = [];
        for (const m of rawMedia) {
            if (!m?.url || seen.has(m.url)) continue;
            seen.add(m.url);
            mediaList.push(m);
        }

        if (!mediaList.length) {
            await safeDeleteChatMessage(sock, chatId, statusMsg);
            statusMsg = null;
            await sock.sendMessage(chatId, { text: 'No media URLs in the response.' }, replyToCommand);
            return;
        }

        await safeDeleteChatMessage(sock, chatId, statusMsg);
        statusMsg = await sock.sendMessage(chatId, { text: formatInstaDownloadStatus(mediaList) });

        const total = mediaList.length;
        let sentCount = 0;
        let failedCount = 0;
        for (let i = 0; i < total; i++) {
            try {
                const buffer = await downloadMediaBuffer(mediaList[i].url);
                await sendDownloadedMedia(sock, chatId, buffer, {}, i);
                sentCount++;
            } catch (err) {
                failedCount++;
                logger.warn(`Insta item ${i + 1}/${total} failed: ${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 1000));
        }

        await safeDeleteChatMessage(sock, chatId, statusMsg);
        statusMsg = null;

        if (!sentCount) {
            await sock.sendMessage(
                chatId,
                { text: 'Found media links but could not download any item. Try again later.' },
                replyToCommand
            );
            return;
        }

        await sock.sendMessage(
            chatId,
            { text: formatInstaSuccessText(sentCount, total, failedCount) },
            replyToCommand
        );
        logger.info(`Insta: sent ${sentCount}/${total} item(s) for ${chatId}`);
    } catch (err) {
        logger.error(`Insta command error: ${err.message}`);
        await sock.sendMessage(
            chatId,
            { text: 'Something went wrong (private post, bad link, or upstream error). Try another URL.' },
            replyToCommand
        );
    } finally {
        if (statusMsg?.key) {
            await safeDeleteChatMessage(sock, chatId, statusMsg);
        }
    }
}

export async function handleNews(sock, chatId, senderJid, { newsController, groupManager }) {
    try {
        if (!newsController) {
            await sock.sendMessage(chatId, { text: 'Tech news is not configured on this bot.' });
            return;
        }

        const articles = await newsController.fetchFreshArticles();
        if (!articles.length) {
            await sock.sendMessage(chatId, { text: '📭 No fresh tech news right now. Try again later.' });
            return;
        }

        const sent = await newsController.previewNews(sock, chatId, articles);
        logger.info(`News preview (${sent} msg) sent to ${chatId}`);

        const canPost = await groupManager.canManualPostNews(senderJid);
        if (!canPost) return;

        const { posted, groups } = await newsController.postNews(sock, articles);
        if (groups === 0) {
            await sock.sendMessage(chatId, {
                text: 'ℹ️ Preview only — no activated groups. Use `/activate` in a group first.',
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                posted > 0
                    ? `✅ Posted *${sent}* tech news message(s) to *${posted}* activated group(s).`
                    : 'ℹ️ News was already posted to all activated groups.',
        });
    } catch (error) {
        logger.error(`Error handling news command: ${error.message}`);
        await sock.sendMessage(chatId, { text: 'Could not fetch tech news right now. Try again later.' });
    }
}
