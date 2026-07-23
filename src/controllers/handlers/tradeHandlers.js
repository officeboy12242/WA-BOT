/**
 * Trade alert handlers: /tradelert, /tradenow
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { config } from '../../config/config.js';
import { editMessageText } from '../../utils/waMessage.js';
import { formatTradeScanPreview } from '../../utils/tradeScanFormatter.js';

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

function sourceLabel(source) {
    if (source === 'heatmap') return 'NSE Heatmap + 15m OR / 8 EMA';
    if (source === 'nse') return 'NSE NIFTY50 top 5G+5L';
    return 'Legacy (sectors · movers · smart money)';
}

function normalizeSourceArg(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'heatmap' || s === 'breakout' || s === 'ema' || s === 'or') return 'heatmap';
    if (s === 'nse' || s === 'nse_gl' || s === 'gl' || s === 'gainers') return 'nse';
    if (s === 'legacy' || s === 'old' || s === 'enhanced') return 'legacy';
    return null;
}


async function getGroupName(sock, chatId, groupManager) {
    try {
        const meta = groupManager?.getGroupMetadataCached
            ? await groupManager.getGroupMetadataCached(sock, chatId)
            : await sock.groupMetadata(chatId);
        return meta?.subject || 'Unknown Group';
    } catch {
        return 'Unknown Group';
    }
}

export async function handleTradelert(sock, chatId, senderJid, args, { groupManager, tradeAlertController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const action = (args[0] || '').toLowerCase();
        const groupName = await getGroupName(sock, chatId, groupManager);
        const currentlyOn = await groupManager.isTradeAlertEnabled(chatId);
        const mode = (await groupManager.getTradeAlertMode(chatId)) || config.TRADE_ALERT_MODE || 'auto';
        const discoverySource =
            (await groupManager.getTradeAlertDiscoverySource(chatId)) ||
            config.TRADE_ALERT_DISCOVERY_SOURCE ||
            'heatmap';
        const symbols = await groupManager.getTradeAlertSymbols(chatId);
        const defaultSymbols = config.TRADE_ALERT_STOCKS || [];
        const nseEach = config.TRADE_ALERT_NSE_GL_EACH || 5;
        const heatmapMax = config.TRADE_ALERT_HEATMAP_MAX || 8;

        if (!action || action === 'status') {
            const llmOk = tradeAlertController?.isReady?.() ?? false;
            const llmChain = tradeAlertController?.tradeLlm?.getModelChain?.()?.join(' → ') || 'none';
            let symbolLine = mode === 'manual'
                ? (symbols.length ? symbols.join(', ') : (defaultSymbols.join(', ') || '_env default_'))
                : discoverySource === 'heatmap'
                  ? `_Heatmap ±2% sectors → top ${heatmapMax} OR/EMA setups_`
                  : discoverySource === 'nse'
                    ? `_NSE NIFTY50 top ${nseEach}G + ${nseEach}L_`
                    : '_AI picks daily from live news & top movers_';

            let r = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            r += '📈 *TRADE ALERTS* 📈\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            r += `📢 *Group:* ${groupName}\n`;
            r += `🔘 *Status:* ${currentlyOn ? '✅ ON' : '❌ OFF'}\n`;
            r += `🧠 *Mode:* ${modeLabel(mode)}\n`;
            r += `📡 *Discovery:* ${sourceLabel(discoverySource)}\n`;
            r += `🕐 *Daily time:* ${formatAlertTime()} IST (trading days only)\n`;
            r += `📊 *Symbols:* ${symbolLine}\n`;
            r += `🔔 *Posts:* CE/PE when AI ≥70% · confluence ≥40 (soft ≥25 if quiet day)\n`;
            r += `🌐 *Data:* ${
                discoverySource === 'heatmap'
                    ? 'NSE heatmap sectors + Yahoo 15m OR/8EMA + option chain'
                    : discoverySource === 'nse'
                      ? 'NSE top gainers/losers + option chain'
                      : 'NSE macro + hot sectors + Yahoo + news'
            }\n`;
            r += `🤖 *AI:* ${llmOk ? llmChain : 'Set GEMINI / GROQ / NVIDIA API key'}\n\n`;
            r += '*Commands:*\n';
            r += '• `/tradelert on` — enable daily AI scan\n';
            r += '• `/tradelert off` — disable\n';
            r += '• `/tradelert auto` — AI picks stocks (default)\n';
            r += '• `/tradelert manual` + `/tradelert stocks A,B` — fixed list\n';
            r += '• `/tradelert source heatmap` — heatmap + 15m OR / 8 EMA\n';
            r += '• `/tradelert source nse` — NIFTY50 top 5G+5L\n';
            r += '• `/tradelert source legacy` — old multi-signal scan\n';
            r += '• `/tradelert scan` — preview today\'s watchlist\n';
            r += '• `/tradenow RELIANCE` — full analysis (incl. NO TRADE)\n\n';
            r += '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
            await sock.sendMessage(chatId, { text: r });
            return;
        }

        if (action === 'on') {
            if (!tradeAlertController?.isReady?.()) {
                await sock.sendMessage(chatId, {
                    text: '❌ Trade alerts need at least one API key: `GEMINI_API_KEY`, `GROQ_API_KEY`, or `NVIDIA_API_KEY`.',
                });
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
            r += '🔔 Posts *CE/PE* when AI ≥70% · prefers confluence ≥40 (soft fill ≥25)\n';
            r += '📅 Skips *weekends & NSE holidays* — use `/tradenow` anytime\n';
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
                    '2. AI picks 8–10 stocks to analyze\n' +
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
            const loading = await sock.sendMessage(chatId, {
                text:
                    discoverySource === 'heatmap'
                        ? '📡 _Heatmap scan: sectors ±2% → 15m OR + 8 EMA… (~30–90s)_'
                        : discoverySource === 'nse'
                          ? `📡 _Fetching NSE NIFTY50 top ${nseEach}G+${nseEach}L…_`
                          : '📡 _Running enhanced market scan (sectors · macro · smart money)… (~60–120s)_',
            });
            try {
                const preview = await tradeAlertController.previewDiscovery(discoverySource);
                const r = formatTradeScanPreview({
                    ...preview,
                    hiddenGem: preview.hiddenGem,
                    hiddenGemReason: preview.hiddenGemReason,
                });
                await editMessageText(sock, chatId, loading?.key, r);
            } catch (err) {
                await editMessageText(sock, chatId, loading?.key, `❌ Scan failed: ${err.message}`);
            }
            return;
        }

        if (action === 'source') {
            const next = normalizeSourceArg(args[1]);
            if (!next) {
                await sock.sendMessage(chatId, {
                    text:
                        '❌ Usage:\n' +
                        '`/tradelert source heatmap` — NSE heatmap ±2% + 15m OR / 8 EMA\n' +
                        '`/tradelert source nse` — NIFTY50 top 5 gainers + 5 losers\n' +
                        '`/tradelert source legacy` — sectors / movers / smart money\n\n' +
                        `Current: *${sourceLabel(discoverySource)}*`,
                });
                return;
            }
            const saved = await groupManager.setTradeAlertDiscoverySource(
                chatId,
                groupName,
                next,
                senderPhone
            );
            await sock.sendMessage(chatId, {
                text:
                    `✅ *Discovery source:* ${sourceLabel(saved)}\n\n` +
                    (saved === 'heatmap'
                        ? 'Daily auto scan uses *heatmap bias* → stocks ±2% in hot sectors → ranks *15m opening-range breakouts* with *8 EMA* filters, then CE/PE trades.\n'
                        : saved === 'nse'
                          ? `Daily auto scan uses NSE NIFTY50 top *${nseEach} gainers + ${nseEach} losers*, then CE/PE trades.\n`
                          : 'Daily auto scan uses the legacy multi-signal watchlist.\n') +
                    '_Preview with `/tradelert scan`._',
            });
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
                '`/tradelert source heatmap` · `/tradelert source nse` · `/tradelert source legacy`\n' +
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

        if (!tradeAlertController.tradeLlm?.isConfigured?.()) {
            await sock.sendMessage(chatId, {
                text: '❌ Set `GEMINI_API_KEY`, `GROQ_API_KEY`, or `NVIDIA_API_KEY` on the server.',
            });
            return;
        }

        const loading = await sock.sendMessage(chatId, {
            text: `📊 _Analyzing ${symbol}…\n🌐 Live price + NSE chain + news · AI (~60–120s)_`,
        });

        try {
            const text = await tradeAlertController.analyzeSymbol(symbol, { mode: 'live' });
            await editMessageText(sock, chatId, loading?.key, text);
            logger.info(`📈 Tradenow ${symbol} in ${chatId} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error in tradenow: ${error.message}`);
            let msg;
            if (/rate limit|429|quota|resource.?exhausted|all trade llm/i.test(error.message)) {
                msg =
                    '❌ *AI rate limit* — Gemini/Groq/NVIDIA all busy.\n' +
                    '_Wait 30–60 seconds and try again, or use `/tradenow NIFTY`._';
            } else if (/timeout/i.test(error.message)) {
                msg =
                    '❌ Analysis timed out after retries.\n' +
                    '_AI API slow — try again in 1–2 min or use a simpler symbol like NIFTY._';
            } else {
                msg = `❌ Analysis failed: ${error.message}`;
            }
            await editMessageText(sock, chatId, loading?.key, msg);
        }
    } catch (error) {
        logger.error(`Error in tradenow handler: ${error.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${error.message}` }).catch(() => {});
    }
}
