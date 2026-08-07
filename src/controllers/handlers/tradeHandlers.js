/**
 * Trade alert handlers: /tradelert, /tradenow, /swing
 */

import { logger } from '../../utils/logger.js';
import { extractPhoneNumber } from '../../utils/permissions.js';
import { config } from '../../config/config.js';
import { editMessageText } from '../../utils/waMessage.js';
import { formatTradeScanPreview } from '../../utils/tradeScanFormatter.js';
import SwingMomentumScanService from '../../services/SwingMomentumScanService.js';
import { formatSwingScan, formatSwingRanking } from '../../utils/swingAlertFormatter.js';
import { createTradeOutcomeService } from '../../services/TradeOutcomeService.js';
import ExpiryTradeService, { EXPIRY_INDICES } from '../../services/ExpiryTradeService.js';
import { formatExpiryAlert, formatExpiryDigest } from '../../utils/expiryAlertFormatter.js';
import { nextExpiry } from '../../utils/expiryCalendar.js';

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
            r += `🤖 *AI:* ${llmOk ? llmChain : 'Set GEMINI / GROQ / NVIDIA API key'}\n`;
            const gate = tradeAlertController?.tradeLlm?.getGateStatus?.() || [];
            if (gate.length) {
                const budget = gate
                    .map((p) => `${p.name} ${p.used}/${p.limit}${p.cooled ? ' 🧊' : ''}`)
                    .join(' · ');
                r += `⚡ *Budget (last 60s):* ${budget}\n`;
            }
            r += '\n';
            r += '*Commands:*\n';
            r += '• `/tradelert on` — enable daily AI scan\n';
            r += '• `/tradelert off` — disable\n';
            r += '• `/tradelert auto` — AI picks stocks (default)\n';
            r += '• `/tradelert manual` + `/tradelert stocks A,B` — fixed list\n';
            r += '• `/tradelert source heatmap` — heatmap + 15m OR / 8 EMA\n';
            r += '• `/tradelert source nse` — NIFTY50 top 5G+5L\n';
            r += '• `/tradelert source legacy` — old multi-signal scan\n';
            r += '• `/tradelert scan` — preview today\'s watchlist\n';
            r += '• `/tradenow RELIANCE` — full analysis (incl. NO TRADE)\n';
            r += '• `/swing` — swing setups (2–6 wk holds, no AI)\n\n';
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
        // `/tradenow TCS fresh` bypasses the short reuse window.
        const forceRefresh = /^(fresh|new|refresh|force)$/i.test(args[1] || '');

        if (!symbol) {
            await sock.sendMessage(chatId, {
                text:
                    '❌ Usage: `/tradenow RELIANCE`\n\n' +
                    'Examples: `/tradenow TCS`, `/tradenow BANKNIFTY`\n' +
                    '_Add `fresh` to skip the 2-min reuse window: `/tradenow TCS fresh`_',
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
            const text = await tradeAlertController.analyzeSymbol(symbol, {
                mode: 'live',
                forceRefresh,
            });
            await editMessageText(sock, chatId, loading?.key, text);
            logger.info(`📈 Tradenow ${symbol} in ${chatId} by ${senderPhone}`);
        } catch (error) {
            logger.error(`Error in tradenow: ${error.message}`);
            const chain = tradeAlertController.tradeLlm?.getGateStatus?.() || [];
            const cooled = chain.filter((p) => p.cooled).map((p) => p.name);
            let msg;
            if (/rate limit|429|quota|resource.?exhausted|all trade llm/i.test(error.message)) {
                msg =
                    '❌ *AI rate limit* — every provider is at its per-minute budget.\n' +
                    (cooled.length ? `_Cooling down: ${cooled.join(', ')}_\n` : '') +
                    '_Wait 30–60 seconds and try again._';
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

/* ── /swing — deterministic momentum + breakout swing scan ────────────────── */

/** Built once; the daily-bar cache inside lives for the trading day. */
let _swingScanner = null;
function getSwingScanner() {
    if (!_swingScanner) _swingScanner = new SwingMomentumScanService(config);
    return _swingScanner;
}

/** In-flight dedupe — the scan is ~200 HTTP calls, never run it twice at once. */
let _swingInflight = null;

async function runSwingScan(opts) {
    if (_swingInflight) {
        logger.info('Swing scan already running — joining in-flight request');
        return _swingInflight;
    }
    _swingInflight = getSwingScanner()
        .scan(opts)
        .finally(() => {
            _swingInflight = null;
        });
    return _swingInflight;
}

/** Record posted picks so real expectancy accumulates from day one. */
async function logSwingPicks(result, chatId, tradeAlertController) {
    const mongoDb = tradeAlertController?.mongoDb;
    if (!mongoDb || !result?.picks?.length) return;
    try {
        const outcomes = createTradeOutcomeService(mongoDb, config);
        for (const p of result.picks) {
            await outcomes.logPostedAlert({
                symbol: p.symbol,
                side: 'SWING_LONG',
                entry: p.plan.entry,
                stopLoss: p.plan.stop,
                target1: p.plan.target1,
                target2: p.plan.target2,
                confidence: p.percentile,
                confluence: Number(p.momentumScore?.toFixed(3)) || null,
                groupId: chatId,
            });
        }
        logger.info(`📊 Logged ${result.picks.length} swing picks for outcome tracking`);
    } catch (err) {
        // Never let journalling break the user-facing reply.
        logger.warn(`Swing outcome logging failed: ${err.message}`);
    }
}

export async function handleSwing(sock, chatId, senderJid, args, { tradeAlertController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const action = String(args[0] || '').trim().toLowerCase();

        if (action === 'help') {
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *SWING MOMENTUM* 📊\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    'Ranks the NIFTY 200 by *risk-adjusted 6M+12M momentum* ' +
                    '(NSE Momentum-30 method), then takes only names breaking out ' +
                    'near 52-week highs on expanding volume — and only while NIFTY ' +
                    'holds its 200 DMA.\n\n' +
                    '*Commands:*\n' +
                    '• `/swing` — today\'s entryable setups\n' +
                    '• `/swing top` — momentum leaderboard only\n' +
                    '• `/swing force` — ignore the regime gate (not advised)\n\n' +
                    '_Hold 2–6 weeks. Ranking is pure arithmetic — no AI._\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            });
            return;
        }

        const wantRanking = action === 'top' || action === 'rank' || action === 'leaderboard';
        const ignoreRegime = action === 'force';

        const loading = await sock.sendMessage(chatId, {
            text:
                '📊 _Scanning NIFTY 200 for swing setups…_\n' +
                '_6M+12M momentum · 52w breakout · volume · regime (~30–90s first run)_',
        });

        try {
            const result = await runSwingScan({ ignoreRegime });
            const text = wantRanking ? formatSwingRanking(result) : formatSwingScan(result);
            await editMessageText(sock, chatId, loading?.key, text);

            if (!wantRanking) await logSwingPicks(result, chatId, tradeAlertController);

            logger.info(
                `📊 Swing scan by ${senderPhone} in ${chatId}: ${result.picks?.length || 0} picks`
            );
        } catch (error) {
            logger.error(`Swing scan failed: ${error.message}`);
            await editMessageText(
                sock,
                chatId,
                loading?.key,
                `❌ Swing scan failed: ${error.message}\n\n_Price data source may be unreachable — try again in a minute._`
            );
        }
    } catch (error) {
        logger.error(`Error in swing handler: ${error.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${error.message}` }).catch(() => {});
    }
}

/* ── /expiry — expiry-day index option alerts ─────────────────────────────── */

let _expirySvc = null;
function getExpiryService() {
    if (!_expirySvc) _expirySvc = new ExpiryTradeService(config);
    return _expirySvc;
}

function parseExpiryArgs(args) {
    let index = null;
    let slot = 'auto';
    for (const raw of args) {
        const a = String(raw || '').trim().toUpperCase();
        if (!a) continue;
        if (EXPIRY_INDICES[a]) { index = a; continue; }
        if (a === 'BNF' || a === 'BANK') { index = 'BANKNIFTY'; continue; }
        if (a === 'FIN') { index = 'FINNIFTY'; continue; }
        if (a === 'MIDCAP' || a === 'MIDCP') { index = 'MIDCPNIFTY'; continue; }
        const l = a.toLowerCase();
        if (l === 'morning' || l === 'setup' || l === 'directional') slot = 'morning';
        if (l === 'hero' || l === 'herozero' || l === 'afternoon' || l === 'zero') slot = 'afternoon';
    }
    return { index, slot };
}

/** Log expiry picks so real outcomes accumulate alongside the swing journal. */
async function logExpiryPicks(result, chatId, tradeAlertController) {
    const mongoDb = tradeAlertController?.mongoDb;
    const s = result?.setup;
    if (!mongoDb || !s?.tradeable || s.strategy !== 'DIRECTIONAL') return;
    try {
        const outcomes = createTradeOutcomeService(mongoDb, config);
        await outcomes.logPostedAlert({
            symbol: `${result.index}${s.leg.strike}${s.leg.type}`,
            side: `EXPIRY_${s.direction}`,
            entry: s.entry,
            stopLoss: s.stop,
            target1: s.target1,
            target2: s.target2,
            confidence: s.leg.probItm != null ? Math.round(s.leg.probItm * 100) : null,
            confluence: null,
            groupId: chatId,
        });
    } catch (err) {
        logger.warn(`Expiry outcome logging failed: ${err.message}`);
    }
}

export async function handleExpiry(sock, chatId, senderJid, args, { tradeAlertController }) {
    try {
        const senderPhone = extractPhoneNumber(senderJid);
        const first = String(args[0] || '').trim().toLowerCase();

        if (first === 'help') {
            const next = nextExpiry();
            await sock.sendMessage(chatId, {
                text:
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 *EXPIRY TRADES* 📅\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '*Two setups, whichever suits the clock:*\n' +
                    '• *Morning* (>3.5h left) — ATM directional on a 15m opening-range break, 20% stop, 1:2.5\n' +
                    '• *Afternoon* (<3.5h) — hero-zero deep OTM, with P(ITM) and the required move printed\n\n' +
                    '*Commands:*\n' +
                    '• `/expiry` — everything expiring today\n' +
                    '• `/expiry nifty` — one index\n' +
                    '• `/expiry nifty hero` — force the hero-zero view\n' +
                    '• `/expiry nifty setup` — force the directional view\n\n' +
                    '*Schedule:* NIFTY every Tuesday · BANKNIFTY/FINNIFTY/MIDCPNIFTY last Tuesday\n' +
                    (next ? `*Next:* ${next.dateStr} (${next.indices.join(', ')})\n\n` : '\n') +
                    '_Hero-zero is a lottery ticket by construction. The card shows the odds._\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            });
            return;
        }

        const svc = getExpiryService();
        const { index, slot } = parseExpiryArgs(args);

        const loading = await sock.sendMessage(chatId, {
            text: `📅 _Reading ${index || 'today\'s expiry'} option chain…_`,
        });

        try {
            if (index) {
                const result = await svc.analyze(index, { slot });
                await editMessageText(sock, chatId, loading?.key, formatExpiryAlert(result));
                await logExpiryPicks(result, chatId, tradeAlertController);
            } else {
                const digest = await svc.analyzeAllExpiring({ slot });
                if (!digest.indices.length) {
                    // Not an expiry day — fall back to the nearest weekly so the
                    // command is never a dead end.
                    const result = await svc.analyze('NIFTY', { slot });
                    const next = nextExpiry();
                    await editMessageText(
                        sock,
                        chatId,
                        loading?.key,
                        `ℹ️ _No expiry today — showing the next NIFTY expiry` +
                            (next ? ` (${next.dateStr})` : '') + `._\n\n` +
                            formatExpiryAlert(result)
                    );
                } else {
                    await editMessageText(
                        sock,
                        chatId,
                        loading?.key,
                        formatExpiryDigest(digest, { slot })
                    );
                    for (const r of digest.results) await logExpiryPicks(r, chatId, tradeAlertController);
                }
            }
            logger.info(`📅 Expiry scan by ${senderPhone}: ${index || 'all'} slot=${slot}`);
        } catch (error) {
            logger.error(`Expiry scan failed: ${error.message}`);
            await editMessageText(
                sock,
                chatId,
                loading?.key,
                `❌ Expiry scan failed: ${error.message}\n\n_NSE option chain may be rate-limiting — retry in a minute._`
            );
        }
    } catch (error) {
        logger.error(`Error in expiry handler: ${error.message}`);
        await sock.sendMessage(chatId, { text: `❌ ${error.message}` }).catch(() => {});
    }
}
