/**
 * Trade alert handlers: /tradelert, /tradenow
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { config } from '../../config/config.js';
import { editMessageText } from '../../utils/waMessage.js';

function parseSymbolList(raw) {
    return String(raw || '')
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 12);
}

function formatAlertTime() {
    return config.TRADE_ALERT_TIME || '09:20';
}

function modeLabel(mode) {
    return mode === 'manual' ? '📋 Manual watchlist' : '🤖 AI auto (live news + movers)';
}

function formatScannedAt(scannedAt) {
    if (!scannedAt) return 'just now';
    const d = scannedAt instanceof Date ? scannedAt : new Date(scannedAt);
    return d.toLocaleString('en-IN', {
        timeZone: config.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

async function getGroupName(sock, chatId) {
    try {
        const meta = await sock.groupMetadata(chatId);
        return meta.subject;
    } catch {
        return 'Unknown Group';
    }
}

export async function handleTradelert(sock, chatId, senderJid, args, { groupManager, tradeAlertController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const action = (args[0] || '').toLowerCase();
        const groupName = await getGroupName(sock, chatId);
        const currentlyOn = await groupManager.isTradeAlertEnabled(chatId);
        const mode = (await groupManager.getTradeAlertMode(chatId)) || config.TRADE_ALERT_MODE || 'auto';
        const symbols = await groupManager.getTradeAlertSymbols(chatId);
        const defaultSymbols = config.TRADE_ALERT_STOCKS || [];

        if (!action || action === 'status') {
            const nvidiaOk = tradeAlertController?.isReady?.() ?? false;
            let symbolLine = mode === 'manual'
                ? (symbols.length ? symbols.join(', ') : (defaultSymbols.join(', ') || '_env default_'))
                : '_AI picks daily from live news & top movers_';

            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '📈 *TRADE ALERTS* 📈\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n`;
            r += `🔘 *Status:* ${currentlyOn ? '✅ ON' : '❌ OFF'}\n`;
            r += `🧠 *Mode:* ${modeLabel(mode)}\n`;
            r += `🕐 *Daily time:* ${formatAlertTime()} IST\n`;
            r += `📊 *Symbols:* ${symbolLine}\n`;
            r += `🔔 *Posts only:* BUY signals ≥70% confidence\n`;
            r += `🌐 *Data:* Live Yahoo prices + Google News RSS\n`;
            r += `🤖 *AI:* ${nvidiaOk ? 'ready' : 'NVIDIA_API_KEY missing'}\n\n`;
            r += '*Commands:*\n';
            r += '• `/tradelert on` — enable daily AI scan\n';
            r += '• `/tradelert off` — disable\n';
            r += '• `/tradelert auto` — AI picks stocks (default)\n';
            r += '• `/tradelert manual` + `/tradelert stocks A,B` — fixed list\n';
            r += '• `/tradelert scan` — preview today\'s AI watchlist\n';
            r += '• `/tradenow RELIANCE` — full analysis (incl. NO TRADE)\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
            await sock.sendMessage(chatId, { text: r });
            return;
        }

        if (action === 'on') {
            if (!tradeAlertController?.nvidia?.isConfigured?.()) {
                await sock.sendMessage(chatId, { text: '❌ Trade alerts need `NVIDIA_API_KEY` on the server.' });
                return;
            }
            if (currentlyOn) {
                await sock.sendMessage(chatId, { text: 'ℹ️ Trade alerts are already *ON* in this group.' });
                return;
            }
            await groupManager.setTradeAlertEnabled(chatId, groupName, true, senderPhone);
            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '✅ *TRADE ALERTS ON* ✅\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n\n`;
            r += `🕐 Daily scan at *${formatAlertTime()}* IST\n`;
            r += `🧠 *Mode:* ${modeLabel(mode)}\n`;
            r += '🌐 Scans *live news*, earnings/results headlines, top gainers/losers\n';
            r += '🔔 Posts only *BUY CALL / BUY PUT* when confidence ≥70%\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '💡 `/tradelert scan` — preview watchlist now\n';
            r += '💡 `/tradenow TCS` — on-demand analysis';
            await sock.sendMessage(chatId, { text: r });
            logger.info(`📈 Trade alert ON: ${groupName} (${chatId}) by ${senderPhone}`);
            return;
        }

        if (action === 'off') {
            if (!currentlyOn) {
                await sock.sendMessage(chatId, {
                    text:
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━\nℹ️ *TRADE ALERTS OFF* ℹ️\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                        'Daily trade alerts are not enabled here.\nUse `/tradelert on` to enable.',
                });
                return;
            }
            await groupManager.setTradeAlertEnabled(chatId, groupName, false, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛑 *TRADE ALERTS OFF* 🛑\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n\n` +
                    'No more daily trade alerts here.\nUse `/tradelert on` to enable again.',
            });
            logger.info(`📈 Trade alert OFF: ${chatId} by ${senderPhone}`);
            return;
        }

        if (action === 'auto') {
            await groupManager.setTradeAlertMode(chatId, groupName, 'auto', senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '✅ *AI AUTO MODE*\n\n' +
                    'Each morning the bot will:\n' +
                    '1. Scan live market news & top movers\n' +
                    '2. AI picks 4–8 stocks to analyze\n' +
                    '3. Post only high-confidence BUY alerts\n\n' +
                    '_Use `/tradelert scan` to preview today\'s picks._',
            });
            return;
        }

        if (action === 'manual') {
            await groupManager.setTradeAlertMode(chatId, groupName, 'manual', senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '✅ *MANUAL MODE*\n\n' +
                    'Set symbols with:\n`/tradelert stocks RELIANCE,TCS,NIFTY`\n\n' +
                    'Or use server default `TRADE_ALERT_STOCKS`.',
            });
            return;
        }

        if (action === 'scan') {
            if (!tradeAlertController?.nvidia?.isConfigured?.()) {
                await sock.sendMessage(chatId, { text: '❌ `NVIDIA_API_KEY` required for AI scan.' });
                return;
            }
            const loading = await sock.sendMessage(chatId, {
                text: '📡 _Running live market scan + AI discovery… (~60–90s)_',
            });
            try {
                const preview = await tradeAlertController.previewDiscovery();
                let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
                r += '📡 *AI WATCHLIST PREVIEW* 📡\n';
                r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                r += `🕐 *Scanned:* ${formatScannedAt(preview.scannedAt)} IST\n`;
                r += `📈 *Picks:* ${preview.symbols.join(', ')}\n\n`;
                r += `📊 *Movers*\n${preview.moversBrief}\n\n`;
                r += `📰 *Market news*\n${preview.marketNews}\n\n`;
                r += '_Full analysis runs at daily alert time; only BUY ≥70% gets posted._';
                await editMessageText(sock, chatId, loading?.key, r);
            } catch (err) {
                await editMessageText(sock, chatId, loading?.key, `❌ Scan failed: ${err.message}`);
            }
            return;
        }

        if (action === 'stocks') {
            const listRaw = args.slice(1).join(' ');
            const parsed = parseSymbolList(listRaw);
            if (!parsed.length) {
                await sock.sendMessage(chatId, { text: '❌ Usage: `/tradelert stocks RELIANCE,TCS,NIFTY`' });
                return;
            }
            await groupManager.setTradeAlertMode(chatId, groupName, 'manual', senderPhone);
            await groupManager.setTradeAlertSymbols(chatId, groupName, parsed, senderPhone);
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *WATCHLIST UPDATED* 📊\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    `📢 *Group:* ${groupName}\n` +
                    `📈 *Symbols:* ${parsed.join(', ')}\n` +
                    `🧠 *Mode:* Manual\n\n` +
                    '_Daily scan uses this fixed list._',
            });
            logger.info(`📈 Trade watchlist: ${parsed.join(',')} in ${chatId} by ${senderPhone}`);
            return;
        }

        await sock.sendMessage(chatId, {
            text:
                '❌ Usage:\n' +
                '`/tradelert on` · `/tradelert off`\n' +
                '`/tradelert auto` · `/tradelert manual`\n' +
                '`/tradelert stocks SYMBOL1,SYMBOL2`\n' +
                '`/tradelert scan`',
        });
    } catch (error) {
        logger.error(`Error handling tradelert: ${error.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${error.message}` }).catch(() => {});
    }
}

export async function handleTradenow(sock, chatId, senderJid, args, { tradeAlertController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const symbol = (args[0] || '').trim().toUpperCase();

        if (!symbol) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage: `/tradenow RELIANCE`\n\n' +
                    'Examples: `/tradenow TCS`, `/tradenow BANKNIFTY`',
            });
            return;
        }

        if (!tradeAlertController) {
            await sock.sendMessage(chatId, { text: '❌ Trade analysis service not available.' });
            return;
        }

        if (!tradeAlertController.nvidia.isConfigured()) {
            await sock.sendMessage(chatId, { text: '❌ `NVIDIA_API_KEY` is not set on the server.' });
            return;
        }

        const loading = await sock.sendMessage(chatId, {
            text: `📊 _Analyzing ${symbol}…\n🌐 Fetching live price + news… (~45–90s)_`,
        });

        try {
            const text = await tradeAlertController.analyzeSymbol(symbol, { mode: 'live' });
            await editMessageText(sock, chatId, loading?.key, text);
            logger.info(`📈 Tradenow ${symbol} in ${chatId} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error in tradenow: ${error.message}`);
            const msg = /timeout/i.test(error.message)
                ? '❌ Analysis timed out. Try again in a moment.'
                : `❌ Analysis failed: ${error.message}`;
            await editMessageText(sock, chatId, loading?.key, msg);
        }
    } catch (error) {
        logger.error(`Error in tradenow handler: ${error.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${error.message}` }).catch(() => {});
    }
}
