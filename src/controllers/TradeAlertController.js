/**
 * F&O trade analysis via NVIDIA DeepSeek — AI discovery, live news, filtered alerts.
 */

import { logger } from '../utils/logger.js';
import { formatDateLabelIST, formatNowLabelIST, getTodayDateStrIST } from '../utils/dateIST.js';
import NvidiaDeepSeekService from '../services/NvidiaDeepSeekService.js';
import { createTradeResearchService } from '../services/TradeResearchService.js';
import { marketScanService } from '../services/MarketScanService.js';
import {
    TRADE_ANALYSIS_SYSTEM_PROMPT,
    buildTradeUserPrompt,
    wrapTradeAlertMessage,
} from '../prompts/tradeAnalysisPrompt.js';
import {
    STOCK_DISCOVERY_SYSTEM_PROMPT,
    buildDiscoveryUserPrompt,
} from '../prompts/stockDiscoveryPrompt.js';
import { parseTradeSignal, parseDiscoveryResult } from '../utils/tradeSignalParser.js';
import { enforceLiveSpotPrice } from '../utils/tradeQuoteUtils.js';
import { injectTradePlans } from '../utils/tradePlanFormatter.js';
import {
    getIndianMarketClosedReason,
    isIndianEquityTradingDay,
} from '../utils/indianMarketCalendar.js';

function parseAlertTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '09:20').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

class TradeAlertController {
    constructor(groupManager, config = {}, mongoDb = null) {
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.research = createTradeResearchService(config);
        this.twoStepResearch = config.TRADE_TWO_STEP_RESEARCH !== false;
        this.enabled = config.TRADE_ALERT_ENABLED !== false;
        const { hour, minute } = parseAlertTime(config.TRADE_ALERT_TIME);
        this.alertHour = hour;
        this.alertMinute = minute;
        this.defaultSymbols = config.TRADE_ALERT_STOCKS || [];
        this.defaultMode = config.TRADE_ALERT_MODE || 'auto';
        this.onlyBuySignals = config.TRADE_ALERT_ONLY_BUY_SIGNALS !== false;
        this.maxSendsPerGroup = config.TRADE_ALERT_MAX_SENDS || 5;
        this.discoveryCount = config.TRADE_ALERT_DISCOVERY_COUNT || 8;
        this.tradePlansEnabled = config.TRADE_PLAN_ENABLED !== false;
        this.tradePlanPartials = config.TRADE_PLAN_PARTIALS || [50, 30, 20];
        this._sock = null;
        this._sentCollection = null;
        this._discoveryCollection = null;
        this._discoveryCache = {
            date: null,
            symbols: [],
            hiddenGem: null,
            hiddenGemReason: null,
            movers: null,
            moversBrief: '',
            marketNews: '',
            scannedAt: null,
        };
    }

    async init() {
        if (!this.mongoDb) return;
        this._sentCollection = this.mongoDb.collection('trade_alert_sent');
        this._discoveryCollection = this.mongoDb.collection('trade_discovery_cache');
        await this._sentCollection.createIndex(
            { group_id: 1, alert_date: 1, symbol: 1 },
            { unique: true, name: 'trade_alert_sent_unique' }
        );
        await this._discoveryCollection.createIndex(
            { alert_date: 1 },
            { unique: true, name: 'trade_discovery_date_unique' }
        );
    }

    setSock(sock) {
        this._sock = sock;
    }

    isReady() {
        return this.enabled && this.nvidia.isConfigured();
    }

    async _runAnalysis(symbol, { mode = 'live', skipResearch = false, isHiddenGem = false } = {}) {
        const startedAt = Date.now();
        const intel = await this.research.gatherIntel(symbol, { includeMarketBrief: false });

        let researchBrief = null;
        if (this.twoStepResearch && !skipResearch) {
            researchBrief = await this.research.runResearchBrief(intel);
        }

        const userPrompt = buildTradeUserPrompt({
            symbol: intel.symbol,
            displayName: intel.displayName,
            quoteContext: intel.quoteContext,
            quote: intel.quote,
            newsContext: intel.newsContext,
            optionsNewsContext: intel.optionsNewsContext,
            optionChainContext: intel.optionChainContext,
            researchBrief,
            marketBrief: null,
            mode,
        });

        logger.info(
            `Trade analysis LLM for ${intel.symbol} (${this.nvidia.tradeModel}, ` +
                `prompt ${userPrompt.length} chars, research=${researchBrief ? 'yes' : 'no'})…`
        );

        let body = await this.nvidia.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 2200,
        });

        body = enforceLiveSpotPrice(body, intel.quote);

        if (this.tradePlansEnabled) {
            body = injectTradePlans(body, intel.symbol, { partials: this.tradePlanPartials });
        }

        logger.info(`Trade analysis done for ${intel.symbol} in ${Date.now() - startedAt}ms`);

        const signal = parseTradeSignal(body);
        const text = wrapTradeAlertMessage(intel.symbol, body, {
            isDaily: mode === 'daily',
            isHiddenGem: isHiddenGem && mode === 'daily',
        });
        return { text, body, signal, symbol: intel.symbol };
    }

    async _runDailyAnalysis(symbol, { isHiddenGem = false } = {}) {
        try {
            return await this._runAnalysis(symbol, { mode: 'daily', isHiddenGem });
        } catch (err) {
            if (this.isTimeoutError(err)) {
                logger.warn(`Daily scan timeout for ${symbol}, retrying without research step…`);
                return await this._runAnalysis(symbol, {
                    mode: 'daily',
                    skipResearch: true,
                    isHiddenGem,
                });
            }
            throw err;
        }
    }

    /**
     * Pick alerts to post: 4 standard + 1 gem when gem is actionable, else up to 5 standard.
     * @param {{ symbol: string, text: string, signal: object, resultEntry: object }[]} actionableRegular
     * @param {{ symbol: string, text: string, signal: object, resultEntry: object }|null} actionableGem
     */
    _selectDailyPosts(actionableRegular, actionableGem) {
        const maxTotal = this.maxSendsPerGroup;
        const sortedRegular = [...actionableRegular].sort(
            (a, b) => (b.signal.confidence || 0) - (a.signal.confidence || 0)
        );

        if (actionableGem) {
            return [actionableGem, ...sortedRegular.slice(0, maxTotal - 1)];
        }
        return sortedRegular.slice(0, maxTotal);
    }

    async analyzeSymbol(rawSymbol, { mode = 'live', skipResearch = false } = {}) {
        const symbol = String(rawSymbol || '').trim().toUpperCase();
        if (!symbol) throw new Error('Stock symbol required');
        if (!this.nvidia.isConfigured()) throw new Error('NVIDIA_API_KEY is not set on the server');

        try {
            const result = await this._runAnalysis(symbol, { mode, skipResearch });
            return result.text;
        } catch (err) {
            if (!skipResearch && this.isTimeoutError(err)) {
                logger.warn(`Trade analysis timeout for ${symbol}, retrying without research step…`);
                const result = await this._runAnalysis(symbol, { mode, skipResearch: true });
                return result.text;
            }
            throw err;
        }
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async discoverSymbolsForToday({ forceRefresh = false } = {}) {
        const result = await this.runDiscovery({ forceRefresh, persist: !forceRefresh });
        return result.symbols;
    }

    /**
     * @param {{ forceRefresh?: boolean, persist?: boolean }} opts
     * persist=false for manual /tradelert scan so it does not lock in stale all-day cache
     */
    async runDiscovery({ forceRefresh = false, persist = true } = {}) {
        const dateStr = getTodayDateStrIST();

        if (!forceRefresh) {
            if (this._discoveryCache.date === dateStr && this._discoveryCache.symbols.length) {
                return this._discoveryResultFromCache();
            }

            if (this._discoveryCollection) {
                const row = await this._discoveryCollection.findOne({ alert_date: dateStr });
                if (row?.symbols?.length) {
                    this._discoveryCache = {
                        date: dateStr,
                        symbols: row.symbols,
                        hiddenGem: row.hidden_gem || null,
                        hiddenGemReason: row.hidden_gem_reason || null,
                        movers: row.movers || null,
                        moversBrief: row.movers_brief || '',
                        marketNews: row.market_news || '',
                        scannedAt: row.created_at || null,
                    };
                    return this._discoveryResultFromCache();
                }
            }
        }

        if (!this.nvidia.isConfigured()) {
            const symbols = this.defaultSymbols.slice(0, this.discoveryCount);
            return {
                symbols,
                hiddenGem: null,
                hiddenGemReason: null,
                moversBrief: 'n/a',
                marketNews: 'n/a',
                scannedAt: new Date(),
            };
        }

        logger.info(
            forceRefresh
                ? '📡 Fresh trade scan requested (bypassing cache)…'
                : '🤖 AI stock discovery: scanning market + news…'
        );

        const snapshot = await marketScanService.buildDiscoverySnapshot();
        logger.info(`📊 Today's top movers: ${marketScanService.formatTopMoversLine(snapshot.movers)}`);

        const userPrompt = buildDiscoveryUserPrompt(snapshot.context, this.discoveryCount);

        let discovery = { symbols: [], hiddenGem: null, hiddenGemReason: null };
        try {
            const raw = await this.nvidia.completeTrade(STOCK_DISCOVERY_SYSTEM_PROMPT, userPrompt, {
                maxTokens: 900,
                timeoutMs: 90_000,
            });
            discovery = parseDiscoveryResult(raw);
        } catch (err) {
            logger.warn(`AI discovery skipped, using movers-only watchlist: ${err.message}`);
        }

        const gemPick = marketScanService.pickHiddenGem(
            snapshot.universeRows,
            snapshot.movers,
            snapshot.marketNews,
            discovery.hiddenGem,
            discovery.hiddenGemReason
        );
        const hiddenGem = gemPick.hiddenGem;
        const hiddenGemReason = gemPick.hiddenGemReason;

        let symbols = marketScanService.buildFreshMoversWatchlist(
            snapshot.universeRows,
            this.discoveryCount,
            { hiddenGem }
        );
        symbols = marketScanService.finalizeWatchlist(symbols, snapshot.universeRows, this.discoveryCount);

        const moversBrief = marketScanService.formatMoversBrief(snapshot.movers);
        const marketNews = snapshot.marketNews.split('\n').slice(0, 5).join('\n');
        const scannedAt = new Date();

        this._discoveryCache = {
            date: dateStr,
            symbols,
            hiddenGem,
            hiddenGemReason,
            movers: snapshot.movers,
            moversBrief,
            marketNews,
            scannedAt,
        };

        if (persist && this._discoveryCollection) {
            await this._discoveryCollection.updateOne(
                { alert_date: dateStr },
                {
                    $set: {
                        symbols,
                        hidden_gem: hiddenGem,
                        hidden_gem_reason: hiddenGemReason,
                        movers: snapshot.movers,
                        movers_brief: moversBrief,
                        market_news: marketNews,
                        raw_response: discovery.symbols?.length ? String(discovery.hiddenGem || '') : 'movers-only',
                        created_at: scannedAt,
                    },
                },
                { upsert: true }
            );
        }

        const gemNote = hiddenGem ? ` · 💎 gem: ${hiddenGem}` : '';
        logger.info(
            `🤖 Fresh movers watchlist (${symbols.length}): ${symbols.join(', ')}${gemNote} ` +
                `[${marketScanService.formatTopMoversLine(snapshot.movers)}]`
        );
        return {
            symbols,
            hiddenGem,
            hiddenGemReason,
            movers: snapshot.movers,
            moversBrief,
            marketNews,
            scannedAt,
        };
    }

    _discoveryResultFromCache() {
        return {
            symbols: this._discoveryCache.symbols,
            hiddenGem: this._discoveryCache.hiddenGem || null,
            hiddenGemReason: this._discoveryCache.hiddenGemReason || null,
            movers: this._discoveryCache.movers || null,
            moversBrief: this._discoveryCache.moversBrief || 'n/a',
            marketNews: this._discoveryCache.marketNews || 'n/a',
            scannedAt: this._discoveryCache.scannedAt || null,
        };
    }

    _formatScanResultLine(entry) {
        const gemTag = entry.isHiddenGem ? ' 💎' : '';
        if (entry.posted) {
            return `✅ *${entry.symbol}*${gemTag} — ${entry.recommendation} (${entry.confidence}%)`;
        }
        if (entry.isActionable) {
            return `⚠️ ${entry.symbol}${gemTag} — ${entry.recommendation} (${entry.confidence}%) · not posted (daily limit)`;
        }
        return `— ${entry.symbol}${gemTag} — NO TRADE (CE ${entry.ceConfidence}% / PE ${entry.peConfidence}%)`;
    }

    async wasDailySent(groupId, symbol, dateStr) {
        if (!this._sentCollection) return false;
        const row = await this._sentCollection.findOne({
            group_id: groupId,
            alert_date: dateStr,
            symbol,
        });
        return Boolean(row);
    }

    async markDailySent(groupId, symbol, dateStr, extra = {}) {
        if (!this._sentCollection) return;
        await this._sentCollection.updateOne(
            { group_id: groupId, alert_date: dateStr, symbol },
            { $set: { sent_at: new Date(), ...extra } },
            { upsert: true }
        );
    }

    async resolveModeForGroup(group) {
        const mode = await this.groupManager.getTradeAlertMode(group.group_id);
        return mode || this.defaultMode;
    }

    async resolveSymbolsForGroup(group) {
        const mode = await this.resolveModeForGroup(group);
        if (mode === 'manual') {
            const groupSymbols = await this.groupManager.getTradeAlertSymbols(group.group_id);
            if (groupSymbols.length) return groupSymbols;
            return this.defaultSymbols;
        }
        return this.discoverSymbolsForToday();
    }

    async postDailyAlerts(sock = this._sock) {
        if (!this.enabled) {
            logger.info('Trade alert: disabled (TRADE_ALERT_ENABLED=false)');
            return;
        }

        if (!isIndianEquityTradingDay(Date.now(), this.config)) {
            const reason = getIndianMarketClosedReason(Date.now(), this.config);
            logger.info(`Trade alert: skipped — ${reason}`);
            return;
        }

        if (!sock) {
            logger.warn('Trade alert: no socket');
            return;
        }
        if (!this.nvidia.isConfigured()) {
            logger.warn('Trade alert: NVIDIA_API_KEY missing');
            return;
        }

        const groups = await this.groupManager.getTradeAlertGroups();
        if (!groups.length) {
            logger.info('Trade alert: no /tradelert on groups');
            return;
        }

        const dateStr = getTodayDateStrIST();
        const dateLabel = formatNowLabelIST();
        logger.info(`📈 Daily trade alerts for ${groups.length} group(s) — ${dateLabel}`);

        let autoDiscovery = null;

        for (const group of groups) {
            const mode = await this.resolveModeForGroup(group);
            let symbols;
            if (mode === 'manual') {
                const groupSymbols = await this.groupManager.getTradeAlertSymbols(group.group_id);
                symbols = groupSymbols.length ? groupSymbols : this.defaultSymbols;
            } else {
                if (!autoDiscovery) {
                    try {
                        autoDiscovery = await this.runDiscovery({ forceRefresh: true, persist: true });
                    } catch (err) {
                        logger.error(`Daily discovery failed, using fallback watchlist: ${err.message}`);
                        autoDiscovery = {
                            symbols: this.defaultSymbols.slice(0, this.discoveryCount),
                            hiddenGem: null,
                            hiddenGemReason: null,
                            moversBrief: 'Discovery unavailable — using default watchlist',
                            marketNews: '',
                            scannedAt: new Date(),
                        };
                    }
                }
                symbols = autoDiscovery.symbols;
                if (autoDiscovery.movers) {
                    symbols = marketScanService.orderSymbolsByMovers(symbols, autoDiscovery.movers);
                }
            }

            if (!symbols.length) {
                logger.warn(`Trade alert: no symbols for ${group.group_name || group.group_id}`);
                continue;
            }

            const hiddenGemSymbol = mode === 'auto' ? (autoDiscovery?.hiddenGem || null) : null;
            const hiddenGemReason = mode === 'auto' ? (autoDiscovery?.hiddenGemReason || null) : null;

            let sentCount = 0;
            const skipped = [];
            const actionableSent = [];
            const scanResults = [];
            const actionableRegular = [];
            let actionableGem = null;

            if (mode === 'auto') {
                let intro =
                    `📡 *AI Market Scan* · ${dateLabel}\n` +
                    `Scanning: *${symbols.join(', ')}*\n`;
                if (hiddenGemSymbol) {
                    intro +=
                        `💎 *Hidden gem hunt:* *${hiddenGemSymbol}*` +
                        (hiddenGemReason ? `\n_${hiddenGemReason}_` : '') +
                        '\n';
                    intro += `_Posts: up to 4 standard + 1 gem when gem ≥70%, else up to ${this.maxSendsPerGroup} standard._\n`;
                } else {
                    intro += `_CE + PE analysis posted when Primary Pick ≥70% (max ${this.maxSendsPerGroup}/day)._\n`;
                }
                intro += '_Analyzing one by one — may take several minutes._';
                await sock.sendMessage(group.group_id, { text: intro }).catch(() => {});
                await new Promise((r) => setTimeout(r, 800));
            }

            for (const symbol of symbols) {
                try {
                    if (await this.wasDailySent(group.group_id, symbol, dateStr)) {
                        continue;
                    }

                    const isHiddenGem = Boolean(hiddenGemSymbol && symbol === hiddenGemSymbol);
                    const { text, signal } = await this._runDailyAnalysis(symbol, { isHiddenGem });

                    const resultEntry = {
                        symbol,
                        recommendation: signal.recommendation,
                        confidence: signal.confidence,
                        ceConfidence: signal.ceConfidence,
                        peConfidence: signal.peConfidence,
                        isActionable: signal.isActionable,
                        isHiddenGem,
                        posted: false,
                    };

                    if (this.onlyBuySignals && !signal.isActionable) {
                        const cePe = `CE ${signal.ceConfidence}% / PE ${signal.peConfidence}%`;
                        skipped.push(`${symbol} (NO TRADE · ${cePe})`);
                        scanResults.push(resultEntry);
                        await this.markDailySent(group.group_id, symbol, dateStr, {
                            skipped: true,
                            signal: signal.recommendation,
                            confidence: signal.confidence,
                        });
                        continue;
                    }

                    const item = { symbol, text, signal, resultEntry };
                    if (isHiddenGem) {
                        actionableGem = item;
                    } else {
                        actionableRegular.push(item);
                    }
                    scanResults.push(resultEntry);
                } catch (err) {
                    logger.error(`Trade alert failed ${symbol} in ${group.group_id}: ${err.message}`);
                    skipped.push(`${symbol} (scan error)`);
                }
            }

            const toPost = this._selectDailyPosts(actionableRegular, actionableGem);
            const postSymbols = new Set(toPost.map((p) => p.symbol));

            for (const item of toPost) {
                try {
                    await sock.sendMessage(group.group_id, { text: item.text });
                    item.resultEntry.posted = true;
                    await this.markDailySent(group.group_id, item.symbol, dateStr, {
                        skipped: false,
                        signal: item.signal.recommendation,
                        confidence: item.signal.confidence,
                        hidden_gem: item.resultEntry.isHiddenGem,
                    });
                    sentCount += 1;
                    actionableSent.push(item.resultEntry.isHiddenGem ? `${item.symbol} 💎` : item.symbol);
                    logger.info(
                        `✅ Trade alert sent: ${item.symbol}${item.resultEntry.isHiddenGem ? ' 💎' : ''} → ${group.group_name || group.group_id}`
                    );
                    await new Promise((r) => setTimeout(r, 2000));
                } catch (err) {
                    logger.error(`Trade alert send failed ${item.symbol} in ${group.group_id}: ${err.message}`);
                }
            }

            for (const item of [...actionableRegular, ...(actionableGem ? [actionableGem] : [])]) {
                if (postSymbols.has(item.symbol)) continue;
                await this.markDailySent(group.group_id, item.symbol, dateStr, {
                    skipped: true,
                    reason: 'daily_limit',
                    signal: item.signal.recommendation,
                    confidence: item.signal.confidence,
                }).catch(() => {});
            }

            const scanSummary = scanResults.length
                ? `\n\n📋 *Scan summary*\n${scanResults.map((e) => this._formatScanResultLine(e)).join('\n')}`
                : '';

            if (sentCount > 0) {
                const gemPosted = toPost.some((p) => p.resultEntry.isHiddenGem && p.resultEntry.posted);
                const gemNote = gemPosted
                    ? '\n_💎 Hidden gem included in today\'s posts._'
                    : hiddenGemSymbol
                      ? `\n_No hidden gem posted — ${hiddenGemSymbol} did not reach ≥70%._`
                      : '';
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `Posted *${sentCount}* actionable alert(s): *${actionableSent.join(', ')}*` +
                        gemNote +
                        scanSummary +
                        `\n\n_Use \`/tradenow SYMBOL\` anytime for full analysis._`,
                }).catch(() => {});
            } else if (this.onlyBuySignals) {
                const skipNote = skipped.length
                    ? `\n_Scanned: ${skipped.slice(0, 8).join('; ')}_`
                    : '';
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `No high-confidence BUY setups (≥70%) today.${skipNote}` +
                        scanSummary +
                        `\n\nUse \`/tradenow SYMBOL\` for full analysis including NO TRADE.`,
                }).catch(() => {});
            }
        }
    }

    /** Manual preview — always fresh live scan (does not reuse all-day cache). */
    async previewDiscovery() {
        return this.runDiscovery({ forceRefresh: true, persist: false });
    }
}

export default TradeAlertController;
