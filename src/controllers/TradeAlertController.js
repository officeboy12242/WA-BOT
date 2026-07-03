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
import { parseTradeSignal, parseDiscoverySymbols } from '../utils/tradeSignalParser.js';
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
        this._discoveryCache = { date: null, symbols: [], movers: null, moversBrief: '', marketNews: '', scannedAt: null };
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

    async _runAnalysis(symbol, { mode = 'live', includeMarketBrief = false } = {}) {
        const intel = await this.research.gatherIntel(symbol, { includeMarketBrief });

        let researchBrief = null;
        if (this.twoStepResearch) {
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
            marketBrief: intel.marketBrief,
            mode,
        });

        let body = await this.nvidia.complete(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 2400,
            timeoutMs: 120_000,
        });

        body = enforceLiveSpotPrice(body, intel.quote);

        if (this.tradePlansEnabled) {
            body = injectTradePlans(body, intel.symbol, { partials: this.tradePlanPartials });
        }

        const signal = parseTradeSignal(body);
        const text = wrapTradeAlertMessage(intel.symbol, body, { isDaily: mode === 'daily' });
        return { text, body, signal, symbol: intel.symbol };
    }

    async analyzeSymbol(rawSymbol, { mode = 'live' } = {}) {
        const symbol = String(rawSymbol || '').trim().toUpperCase();
        if (!symbol) throw new Error('Stock symbol required');
        if (!this.nvidia.isConfigured()) throw new Error('NVIDIA_API_KEY is not set on the server');

        const result = await this._runAnalysis(symbol, { mode, includeMarketBrief: mode === 'live' });
        return result.text;
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
        const userPrompt = buildDiscoveryUserPrompt(snapshot.context, this.discoveryCount);

        const raw = await this.nvidia.complete(STOCK_DISCOVERY_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 800,
            timeoutMs: 90_000,
        });

        let aiSymbols = parseDiscoverySymbols(raw);
        if (!aiSymbols.length) {
            logger.warn('AI discovery returned no symbols — using top movers fallback');
            aiSymbols = [
                ...snapshot.movers.gainers.slice(0, 5).map((x) => x.symbol),
                ...snapshot.movers.losers.slice(0, 4).map((x) => x.symbol),
            ];
        }

        let symbols = marketScanService.buildDiscoveryWatchlist(
            aiSymbols,
            snapshot.movers,
            this.discoveryCount
        );
        symbols = marketScanService.orderSymbolsByMovers(symbols, snapshot.movers);

        const moversBrief = marketScanService.formatMoversBrief(snapshot.movers);
        const marketNews = snapshot.marketNews.split('\n').slice(0, 5).join('\n');
        const scannedAt = new Date();

        this._discoveryCache = {
            date: dateStr,
            symbols,
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
                        movers: snapshot.movers,
                        movers_brief: moversBrief,
                        market_news: marketNews,
                        raw_response: raw.slice(0, 4000),
                        created_at: scannedAt,
                    },
                },
                { upsert: true }
            );
        }

        logger.info(`🤖 AI discovery watchlist (${symbols.length}): ${symbols.join(', ')}`);
        return { symbols, movers: snapshot.movers, moversBrief, marketNews, scannedAt };
    }

    _discoveryResultFromCache() {
        return {
            symbols: this._discoveryCache.symbols,
            movers: this._discoveryCache.movers || null,
            moversBrief: this._discoveryCache.moversBrief || 'n/a',
            marketNews: this._discoveryCache.marketNews || 'n/a',
            scannedAt: this._discoveryCache.scannedAt || null,
        };
    }

    _formatScanResultLine(entry) {
        if (entry.posted) {
            return `✅ *${entry.symbol}* — ${entry.recommendation} (${entry.confidence}%)`;
        }
        if (entry.isActionable) {
            return `⚠️ ${entry.symbol} — ${entry.recommendation} (${entry.confidence}%)`;
        }
        return `— ${entry.symbol} — NO TRADE (CE ${entry.ceConfidence}% / PE ${entry.peConfidence}%)`;
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

            let sentCount = 0;
            const skipped = [];
            const actionableSent = [];
            const scanResults = [];

            if (mode === 'auto') {
                const intro =
                    `📡 *AI Market Scan* · ${dateLabel}\n` +
                    `Scanning: *${symbols.join(', ')}*\n` +
                    `_CE + PE analysis posted when Primary Pick ≥70% (max ${this.maxSendsPerGroup}/day)._\n` +
                    `_Analyzing one by one — may take several minutes._`;
                await sock.sendMessage(group.group_id, { text: intro }).catch(() => {});
                await new Promise((r) => setTimeout(r, 800));
            }

            for (const symbol of symbols) {
                try {
                    if (this.onlyBuySignals && sentCount >= this.maxSendsPerGroup) {
                        skipped.push(`${symbol} (daily alert limit reached)`);
                        continue;
                    }

                    if (await this.wasDailySent(group.group_id, symbol, dateStr)) {
                        continue;
                    }

                    const { text, signal } = await this._runAnalysis(symbol, { mode: 'daily' });

                    const resultEntry = {
                        symbol,
                        recommendation: signal.recommendation,
                        confidence: signal.confidence,
                        ceConfidence: signal.ceConfidence,
                        peConfidence: signal.peConfidence,
                        isActionable: signal.isActionable,
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

                    if (sentCount >= this.maxSendsPerGroup) {
                        skipped.push(`${symbol} (daily limit reached)`);
                        scanResults.push(resultEntry);
                        await this.markDailySent(group.group_id, symbol, dateStr, {
                            skipped: true,
                            reason: 'daily_limit',
                        });
                        continue;
                    }

                    await sock.sendMessage(group.group_id, { text });
                    resultEntry.posted = true;
                    scanResults.push(resultEntry);
                    await this.markDailySent(group.group_id, symbol, dateStr, {
                        skipped: false,
                        signal: signal.recommendation,
                        confidence: signal.confidence,
                    });
                    sentCount += 1;
                    actionableSent.push(symbol);
                    logger.info(`✅ Trade alert sent: ${symbol} → ${group.group_name || group.group_id}`);
                    await new Promise((r) => setTimeout(r, 2000));
                } catch (err) {
                    logger.error(`Trade alert failed ${symbol} in ${group.group_id}: ${err.message}`);
                }
            }

            const scanSummary = scanResults.length
                ? `\n\n📋 *Scan summary*\n${scanResults.map((e) => this._formatScanResultLine(e)).join('\n')}`
                : '';

            if (sentCount > 0) {
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `Posted *${sentCount}* actionable alert(s): *${actionableSent.join(', ')}*` +
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
