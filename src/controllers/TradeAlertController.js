/**
 * F&O trade analysis via NVIDIA DeepSeek — AI discovery, live news, filtered alerts.
 */

import { logger } from '../utils/logger.js';
import { formatDateLabelIST, formatNowLabelIST, getTodayDateStrIST } from '../utils/dateIST.js';
import NvidiaDeepSeekService from '../services/NvidiaDeepSeekService.js';
import TradeLlmRouterService, { isTradeLlmRateLimitError } from '../services/TradeLlmRouterService.js';
import { createTradeResearchService } from '../services/TradeResearchService.js';
import { marketScanService } from '../services/MarketScanService.js';
import { createTradeDiscoveryEngine } from '../services/TradeDiscoveryEngine.js';
import { scoreConfluence, getMinConfluenceScore } from '../utils/tradeConfluenceScore.js';
import {
    getIndiaMarketMode,
    checkQuoteFreshness,
} from '../utils/indianMarketCalendar.js';
import { computeEntryState, ENTRY_STATES } from '../utils/tradeEntryState.js';
import {
    formatDailyScanIntro,
    formatAlertMetaFooter,
} from '../utils/tradeScanFormatter.js';
import { parsePremium, parseTargets } from '../utils/tradePlanFormatter.js';
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
import { enforceLiveSpotPrice, enforceLiveOptionPremiums } from '../utils/tradeQuoteUtils.js';
import { injectTradePlans } from '../utils/tradePlanFormatter.js';
import {
    getIndianMarketClosedReason,
    isIndianEquityTradingDay,
} from '../utils/indianMarketCalendar.js';

function parseAlertTime(timeStr) {
    const [h, m = '0'] = String(timeStr || '09:20').trim().split(':');
    return { hour: Number(h), minute: Number(m) };
}

function normalizeDiscoverySource(v) {
    const s = String(v || '').trim().toLowerCase();
    if (s === 'heatmap' || s === 'breakout' || s === 'ema' || s === 'or') return 'heatmap';
    if (s === 'nse' || s === 'nse_gl' || s === 'gl' || s === 'gainers') return 'nse';
    return 'legacy';
}

class TradeAlertController {
    constructor(groupManager, config = {}, mongoDb = null) {
        this.groupManager = groupManager;
        this.config = config;
        this.mongoDb = mongoDb;
        this.nvidia = new NvidiaDeepSeekService(config);
        this.tradeLlm = new TradeLlmRouterService(config);
        this.research = createTradeResearchService(config);
        this.twoStepResearch = config.TRADE_TWO_STEP_RESEARCH !== false;
        this.enabled = config.TRADE_ALERT_ENABLED !== false;
        const { hour, minute } = parseAlertTime(config.TRADE_ALERT_TIME);
        this.alertHour = hour;
        this.alertMinute = minute;
        this.defaultSymbols = config.TRADE_ALERT_STOCKS || [];
        this.defaultMode = config.TRADE_ALERT_MODE || 'auto';
        this.defaultDiscoverySource = normalizeDiscoverySource(config.TRADE_ALERT_DISCOVERY_SOURCE);
        this.nseGlEach = config.TRADE_ALERT_NSE_GL_EACH || 5;
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
            source: null,
            symbols: [],
            hiddenGem: null,
            hiddenGemReason: null,
            movers: null,
            moversBrief: '',
            marketNews: '',
            scannedAt: null,
            intelligence: null,
        };
        this.discoveryEngine = null;
        this.minConfluence = getMinConfluenceScore(config);
        this.softDailyFallback = config.TRADE_ALERT_DAILY_SOFT_FALLBACK !== false;
        this.softMinConfluence = Number.isFinite(config.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE)
            ? config.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE
            : 25;
    }

    async init() {
        if (!this.mongoDb) return;
        this.discoveryEngine = createTradeDiscoveryEngine(this.config, this.mongoDb);
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
        return this.enabled && this.tradeLlm.isConfigured();
    }

    async _runAnalysis(symbol, { mode = 'live', skipResearch = false, isHiddenGem = false } = {}) {
        const startedAt = Date.now();
        const intel = await this.research.gatherIntel(symbol, { includeMarketBrief: false });

        let researchBrief = null;
        // Daily batch: skip research brief (1 LLM call/symbol) so alerts land near open.
        // Live /tradenow: skip unless caller opts in via two-step.
        const wantResearch =
            this.twoStepResearch && !skipResearch && mode === 'daily' && this.config.TRADE_DAILY_RESEARCH === true;
        if (wantResearch) {
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
            `Trade analysis LLM for ${intel.symbol} (${this.tradeLlm.getPrimaryLabel()}, ` +
                `prompt ${userPrompt.length} chars, research=${researchBrief ? 'yes' : 'no'})…`
        );

        let body = await this.tradeLlm.completeTradeAnalysis(TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 8192,
        });

        body = enforceLiveSpotPrice(body, intel.quote);
        body = enforceLiveOptionPremiums(body, intel.optionChainSnapshot);

        if (this.tradePlansEnabled) {
            body = injectTradePlans(body, intel.symbol, { partials: this.tradePlanPartials });
        }

        logger.info(`Trade analysis done for ${intel.symbol} in ${Date.now() - startedAt}ms`);

        const signal = parseTradeSignal(body);
        const marketMode = getIndiaMarketMode();
        const entryState = this._computeEntryStateFromBody(body, intel.quote, marketMode);
        const text = wrapTradeAlertMessage(intel.symbol, body, {
            isDaily: mode === 'daily',
            isHiddenGem: isHiddenGem && mode === 'daily',
            meta: {
                entryState,
                confluence: null,
                freshness: intel.quote?.price != null ? 'live quote' : null,
            },
        });
        return { text, body, signal, symbol: intel.symbol, entryState };
    }

    _computeEntryStateFromBody(body, quote, marketMode) {
        const text = String(body || '');
        const ceBlock = text.match(/━━━\s*CALL\s*\(CE\)\s*SETUP[\s\S]*?(?=━━━\s*PUT|Primary Pick:|$)/i)?.[0] || '';
        const entryRaw = ceBlock.match(/Entry:\s*(.+)/i)?.[1] || '';
        const entryNums = entryRaw.match(/(\d+(?:\.\d+)?)/g)?.map(Number) || [];
        const entryLow = entryNums.length ? Math.min(...entryNums) : null;
        const entryHigh = entryNums.length ? Math.max(...entryNums) : null;
        const premiumMatch = ceBlock.match(/Premium:\s*([\d,.]+)/i);
        const entry = premiumMatch ? parsePremium(premiumMatch[1]) : entryLow;
        const targets = parseTargets(ceBlock, entry);
        return computeEntryState({
            marketMode: marketMode.mode,
            quote,
            entryLow: entryLow ?? entry,
            entryHigh: entryHigh ?? entry,
            target1: targets.t1,
        });
    }

    _passesSendGates({ signal, confluence, entryState, marketMode, discovery }) {
        const gates = discovery?.gates || {};
        const minConf = gates.minConfidence ?? 70;
        const minConv = gates.minConfluence ?? this.minConfluence;

        if (marketMode.watchOnly && gates.allowsLiveEntry === false) {
            return { pass: false, reason: 'watch-only session' };
        }
        if (discovery?.freshness?.ok === false) {
            return { pass: false, reason: discovery.freshness.message || 'stale data' };
        }
        if (!signal.isActionable || signal.confidence < minConf) {
            return { pass: false, reason: `AI < ${minConf}%` };
        }
        if (confluence?.blocked) {
            return { pass: false, reason: `catalyst AVOID (${confluence.blockReason})` };
        }
        if (confluence && confluence.score < minConv) {
            return { pass: false, reason: `confluence ${confluence.score} < ${minConv}` };
        }
        if (
            entryState?.state === ENTRY_STATES.ENTRY_MISSED ||
            entryState?.state === ENTRY_STATES.NO_ACTIVE_ENTRY
        ) {
            return { pass: false, reason: entryState.label };
        }
        return { pass: true, reason: null };
    }

    _isSoftDailyEligible({ signal, confluence, gate, discovery }) {
        if (!this.softDailyFallback) return false;
        if (!signal?.isActionable) return false;
        const minConf = discovery?.gates?.minConfidence ?? 70;
        if ((signal.confidence || 0) < minConf) return false;
        if (confluence?.blocked) return false;
        if ((confluence?.score ?? 0) < this.softMinConfluence) return false;
        // Only fill from confluence misses — not watch-only / stale / entry-missed
        return /confluence\s+\d+\s*</i.test(String(gate?.reason || ''));
    }

    _wrapSoftDailyAlert(text, { symbol, confluence, strictMin }) {
        const score = confluence?.score ?? '?';
        return (
            `⚡ *DAILY ALERT (soft gate)* — *${symbol}*\n` +
            `_AI ≥70% · confluence ${score} (strict ≥${strictMin}). Size smaller / manage risk._\n\n` +
            String(text || '').trim()
        );
    }

    async _runDailyAnalysis(symbol, { isHiddenGem = false } = {}) {
        try {
            // Always skip research on daily path — one LLM call per symbol.
            return await this._runAnalysis(symbol, { mode: 'daily', skipResearch: true, isHiddenGem });
        } catch (err) {
            if (this.isTimeoutError(err) || isTradeLlmRateLimitError(err)) {
                logger.warn(`Daily scan retry for ${symbol}: ${err.message}`);
                await new Promise((r) => setTimeout(r, isTradeLlmRateLimitError(err) ? 2500 : 400));
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
     * Run async work over items with limited concurrency (keeps daily scan near 09:22 IST).
     * @template T, R
     * @param {T[]} items
     * @param {number} limit
     * @param {(item: T, index: number) => Promise<R>} worker
     * @returns {Promise<R[]>}
     */
    async _mapPool(items, limit, worker) {
        const out = new Array(items.length);
        let next = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await worker(items[i], i);
            }
        });
        await Promise.all(runners);
        return out;
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
        if (!this.tradeLlm.isConfigured()) throw new Error('No trade LLM configured (GEMINI, GROQ, or NVIDIA API key)');

        try {
            const result = await this._runAnalysis(symbol, { mode, skipResearch });
            return result.text;
        } catch (err) {
            if (!skipResearch && (this.isTimeoutError(err) || isTradeLlmRateLimitError(err))) {
                logger.warn(`Trade analysis retry for ${symbol} (skip research): ${err.message}`);
                await new Promise((r) => setTimeout(r, isTradeLlmRateLimitError(err) ? 3000 : 0));
                const result = await this._runAnalysis(symbol, { mode, skipResearch: true });
                return result.text;
            }
            if (isTradeLlmRateLimitError(err)) {
                throw new Error('All trade LLM providers rate limited — wait 30–60 seconds and try `/tradenow` again.');
            }
            throw err;
        }
    }

    isTimeoutError(err) {
        return /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(err?.message || err));
    }

    async discoverSymbolsForToday({ forceRefresh = false, source = null } = {}) {
        const result = await this.runDiscovery({ forceRefresh, persist: !forceRefresh, source });
        return result.symbols;
    }

    async resolveDiscoverySourceForGroup(groupId) {
        const fromGroup = await this.groupManager.getTradeAlertDiscoverySource?.(groupId);
        return normalizeDiscoverySource(fromGroup || this.defaultDiscoverySource);
    }

    /**
     * @param {{ forceRefresh?: boolean, persist?: boolean, source?: string }} opts
     * persist=false for manual /tradelert scan so it does not lock in stale all-day cache
     */
    async runDiscovery({ forceRefresh = false, persist = true, source = null } = {}) {
        const dateStr = getTodayDateStrIST();
        const discoverySource = normalizeDiscoverySource(source || this.defaultDiscoverySource);

        if (!forceRefresh) {
            if (
                this._discoveryCache.date === dateStr &&
                this._discoveryCache.source === discoverySource &&
                this._discoveryCache.symbols.length
            ) {
                return this._discoveryResultFromCache();
            }

            if (this._discoveryCollection) {
                const row = await this._discoveryCollection.findOne({
                    alert_date: dateStr,
                    discovery_source: discoverySource,
                });
                if (row?.symbols?.length) {
                    this._discoveryCache = {
                        date: dateStr,
                        source: discoverySource,
                        symbols: row.symbols,
                        hiddenGem: row.hidden_gem || null,
                        hiddenGemReason: row.hidden_gem_reason || null,
                        movers: row.movers || null,
                        moversBrief: row.movers_brief || '',
                        marketNews: row.market_news || '',
                        scannedAt: row.created_at || null,
                        intelligence: row.intelligence || null,
                        niftyGl: row.intelligence?.niftyGl || null,
                        discoverySource,
                    };
                    return this._discoveryResultFromCache();
                }
            }
        }

        if (!this.discoveryEngine) {
            this.discoveryEngine = createTradeDiscoveryEngine(this.config, this.mongoDb);
        }

        logger.info(
            forceRefresh
                ? `📡 Fresh trade scan (${discoverySource})…`
                : `🤖 Trade discovery (${discoverySource})…`
        );

        const intel = await this.discoveryEngine.run({ forceRefresh, source: discoverySource });

        let symbols = [...(intel.symbols || [])];
        let gemPick = { hiddenGem: null, hiddenGemReason: null };

        // Heatmap / NSE lists are authoritative — skip AI overlay / hidden-gem rewrite.
        if (discoverySource !== 'nse' && discoverySource !== 'heatmap') {
            let discovery = { symbols: [], hiddenGem: null, hiddenGemReason: null };
            if (this.tradeLlm.isConfigured()) {
                const userPrompt = buildDiscoveryUserPrompt(intel.context, this.discoveryCount);
                try {
                    const raw = await this.tradeLlm.completeTrade(STOCK_DISCOVERY_SYSTEM_PROMPT, userPrompt, {
                        maxTokens: 900,
                        timeoutMs: 90_000,
                    });
                    discovery = parseDiscoveryResult(raw);
                } catch (err) {
                    logger.warn(`AI discovery overlay skipped: ${err.message}`);
                }
            }

            const baseRows = intel.universeRows || [];
            gemPick = marketScanService.pickHiddenGem(
                baseRows,
                intel.movers,
                intel.marketNews,
                discovery.hiddenGem,
                discovery.hiddenGemReason
            );

            if (gemPick.hiddenGem && !symbols.includes(gemPick.hiddenGem)) {
                symbols = [gemPick.hiddenGem, ...symbols].slice(0, this.discoveryCount);
            }
            symbols = marketScanService.finalizeWatchlist(symbols, baseRows, this.discoveryCount);
        }

        const scannedAt = intel.scannedAt || new Date();
        const result = {
            symbols,
            hiddenGem: gemPick.hiddenGem,
            hiddenGemReason: gemPick.hiddenGemReason,
            movers: intel.movers,
            moversBrief: intel.moversBrief,
            marketNews: intel.marketNews,
            scannedAt,
            macro: intel.macro,
            hotSectors: intel.hotSectors,
            phase4Picks: intel.phase4Picks,
            momentumAlerts: intel.momentumAlerts,
            smartMoney: intel.smartMoney,
            catalystHighlights: intel.catalystHighlights,
            symbolMeta: intel.symbolMeta,
            delta: intel.delta,
            marketMode: intel.marketMode,
            marketModeLabel: intel.marketModeLabel,
            freshness: intel.freshness,
            gates: intel.gates,
            niftyGl: intel.niftyGl || null,
            heatmap: intel.heatmap || null,
            discoverySource,
            intelligence: intel,
        };

        this._discoveryCache = { date: dateStr, source: discoverySource, ...result };

        if (persist && this._discoveryCollection) {
            await this._discoveryCollection.updateOne(
                { alert_date: dateStr, discovery_source: discoverySource },
                {
                    $set: {
                        symbols,
                        discovery_source: discoverySource,
                        hidden_gem: gemPick.hiddenGem,
                        hidden_gem_reason: gemPick.hiddenGemReason,
                        movers: intel.movers,
                        movers_brief: intel.moversBrief,
                        market_news: intel.marketNews,
                        intelligence: {
                            macro: intel.macro,
                            hotSectors: intel.hotSectors,
                            phase4Picks: intel.phase4Picks,
                            momentumAlerts: intel.momentumAlerts,
                            catalystHighlights: intel.catalystHighlights,
                            delta: intel.delta,
                            gates: intel.gates,
                            marketMode: intel.marketMode,
                            niftyGl: intel.niftyGl || null,
                            heatmap: intel.heatmap
                                ? {
                                      sentiment: intel.heatmap.sentiment,
                                      picks: (intel.heatmap.picks || []).map((p) => ({
                                          symbol: p.symbol,
                                          sector: p.sector,
                                          changePct: p.changePct,
                                          side: p.side,
                                          setup: p.setup,
                                      })),
                                  }
                                : null,
                        },
                        created_at: scannedAt,
                    },
                },
                { upsert: true }
            );
        }

        const gemNote = gemPick.hiddenGem ? ` · 💎 ${gemPick.hiddenGem}` : '';
        logger.info(
            `🤖 Watchlist [${discoverySource}] (${symbols.length}): ${symbols.join(', ')}${gemNote}`
        );
        return result;
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
            macro: this._discoveryCache.intelligence?.macro || this._discoveryCache.macro || null,
            hotSectors: this._discoveryCache.intelligence?.hotSectors || this._discoveryCache.hotSectors || null,
            phase4Picks: this._discoveryCache.intelligence?.phase4Picks || this._discoveryCache.phase4Picks || [],
            momentumAlerts: this._discoveryCache.intelligence?.momentumAlerts || this._discoveryCache.momentumAlerts || [],
            smartMoney: this._discoveryCache.smartMoney || null,
            catalystHighlights: this._discoveryCache.intelligence?.catalystHighlights || this._discoveryCache.catalystHighlights || [],
            symbolMeta: this._discoveryCache.symbolMeta || [],
            delta: this._discoveryCache.intelligence?.delta || this._discoveryCache.delta || null,
            marketMode: this._discoveryCache.intelligence?.marketMode || this._discoveryCache.marketMode,
            marketModeLabel: this._discoveryCache.marketModeLabel,
            freshness: this._discoveryCache.freshness,
            gates: this._discoveryCache.intelligence?.gates || this._discoveryCache.gates,
            niftyGl: this._discoveryCache.niftyGl || this._discoveryCache.intelligence?.niftyGl || null,
            heatmap: this._discoveryCache.heatmap || this._discoveryCache.intelligence?.heatmap || null,
            discoverySource: this._discoveryCache.discoverySource || this._discoveryCache.source || this.defaultDiscoverySource,
        };
    }

    _formatScanResultLine(entry) {
        const gemTag = entry.isHiddenGem ? ' 💎' : '';
        const confTag = entry.confluence != null ? ` · conf ${entry.confluence}` : '';
        if (entry.posted) {
            const softTag = entry.softGate ? ' ⚡soft' : '';
            return `✅ *${entry.symbol}*${gemTag}${softTag} — ${entry.recommendation} (${entry.confidence}%)${confTag}`;
        }
        if (entry.isActionable) {
            return `⚠️ ${entry.symbol}${gemTag} — ${entry.recommendation} (${entry.confidence}%)${confTag} · not posted (daily limit)`;
        }
        const why = entry.gateReason ? ` · ${entry.gateReason}` : '';
        return `— ${entry.symbol}${gemTag} — NO TRADE (CE ${entry.ceConfidence}% / PE ${entry.peConfidence}%)${why}`;
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
        if (!this.tradeLlm.isConfigured()) {
            logger.warn('Trade alert: no trade LLM API key (GEMINI, GROQ, or NVIDIA)');
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

        /** @type {Map<string, object>} */
        const discoveriesBySource = new Map();

        for (const group of groups) {
            const mode = await this.resolveModeForGroup(group);
            let symbols;
            let autoDiscovery = null;
            if (mode === 'manual') {
                const groupSymbols = await this.groupManager.getTradeAlertSymbols(group.group_id);
                symbols = groupSymbols.length ? groupSymbols : this.defaultSymbols;
            } else {
                const source = await this.resolveDiscoverySourceForGroup(group.group_id);
                if (!discoveriesBySource.has(source)) {
                    try {
                        discoveriesBySource.set(
                            source,
                            await this.runDiscovery({ forceRefresh: true, persist: true, source })
                        );
                    } catch (err) {
                        logger.error(`Daily discovery (${source}) failed, using fallback: ${err.message}`);
                        discoveriesBySource.set(source, {
                            symbols: this.defaultSymbols.slice(0, this.discoveryCount),
                            hiddenGem: null,
                            hiddenGemReason: null,
                            moversBrief: 'Discovery unavailable — using default watchlist',
                            marketNews: '',
                            scannedAt: new Date(),
                            discoverySource: source,
                        });
                    }
                }
                autoDiscovery = discoveriesBySource.get(source);
                symbols = autoDiscovery.symbols;
                if (autoDiscovery.movers && source !== 'nse' && source !== 'heatmap') {
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
            const softRegular = [];
            let actionableGem = null;
            let softGem = null;

            if (mode === 'auto') {
                const intro = formatDailyScanIntro(autoDiscovery, {
                    symbols,
                    hiddenGem: hiddenGemSymbol,
                    hiddenGemReason,
                    maxSends: this.maxSendsPerGroup,
                });
                // Fire-and-forget — don't block analysis for ~9:22 posts
                sock.sendMessage(group.group_id, { text: intro }).catch(() => {});
            }

            const marketMode = getIndiaMarketMode();
            const discoveryFreshness = checkQuoteFreshness(autoDiscovery?.scannedAt);
            const strictMinConv = autoDiscovery?.gates?.minConfluence ?? this.minConfluence;
            const concurrency = Math.max(1, Math.min(3, Number(this.config.TRADE_ALERT_SCAN_CONCURRENCY) || 2));

            const scanRows = await this._mapPool(symbols, concurrency, async (symbol) => {
                try {
                    if (await this.wasDailySent(group.group_id, symbol, dateStr)) {
                        return { kind: 'already' };
                    }

                    const isHiddenGem = Boolean(hiddenGemSymbol && symbol === hiddenGemSymbol);
                    const { text, signal, entryState } = await this._runDailyAnalysis(symbol, { isHiddenGem });

                    const metaRow = autoDiscovery?.symbolMeta?.find((m) => m.symbol === symbol);
                    const confluence = metaRow
                        ? {
                              score: metaRow.confluence,
                              blocked: metaRow.blocked,
                              blockReason: metaRow.blocked ? 'catalyst' : null,
                              passes: metaRow.confluencePass,
                          }
                        : scoreConfluence({
                              symbol,
                              movers: autoDiscovery?.movers,
                              macro: autoDiscovery?.macro,
                          });

                    const discoveryForGates = {
                        ...autoDiscovery,
                        freshness: discoveryFreshness,
                    };
                    const gate = this._passesSendGates({
                        signal,
                        confluence,
                        entryState,
                        marketMode,
                        discovery: discoveryForGates,
                    });

                    const resultEntry = {
                        symbol,
                        recommendation: signal.recommendation,
                        confidence: signal.confidence,
                        ceConfidence: signal.ceConfidence,
                        peConfidence: signal.peConfidence,
                        isActionable: signal.isActionable && gate.pass,
                        confluence: confluence.score,
                        gateReason: gate.pass ? null : gate.reason,
                        isHiddenGem,
                        posted: false,
                        softGate: false,
                    };

                    if (this.onlyBuySignals && !resultEntry.isActionable) {
                        const softOk = this._isSoftDailyEligible({
                            signal,
                            confluence,
                            gate,
                            discovery: discoveryForGates,
                        });
                        const cePe = `CE ${signal.ceConfidence}% / PE ${signal.peConfidence}%`;
                        const why = gate.pass ? '' : ` · ${gate.reason}`;
                        const skipLine = `${symbol} (${gate.pass ? 'NO TRADE' : 'blocked'} · ${cePe}${why})`;

                        if (softOk) {
                            const softItem = {
                                symbol,
                                text: this._wrapSoftDailyAlert(text, {
                                    symbol,
                                    confluence,
                                    strictMin: strictMinConv,
                                }),
                                signal,
                                resultEntry,
                                softGate: true,
                            };
                            return { kind: 'soft', softItem, isHiddenGem, skipLine, resultEntry };
                        }
                        await this.markDailySent(group.group_id, symbol, dateStr, {
                            skipped: true,
                            signal: signal.recommendation,
                            confidence: signal.confidence,
                        });
                        return { kind: 'skip', skipLine, resultEntry };
                    }

                    const item = { symbol, text, signal, resultEntry, softGate: false };
                    return { kind: 'actionable', item, isHiddenGem, resultEntry };
                } catch (err) {
                    logger.error(`Trade alert failed ${symbol} in ${group.group_id}: ${err.message}`);
                    const short = isTradeLlmRateLimitError(err)
                        ? 'rate limit'
                        : this.isTimeoutError(err)
                          ? 'timeout'
                          : 'error';
                    return { kind: 'error', skipLine: `${symbol} (scan error · ${short})` };
                }
            });

            for (const row of scanRows) {
                if (!row || row.kind === 'already') continue;
                if (row.skipLine) skipped.push(row.skipLine);
                if (row.resultEntry) scanResults.push(row.resultEntry);
                if (row.kind === 'soft') {
                    if (row.isHiddenGem) softGem = row.softItem;
                    else softRegular.push(row.softItem);
                } else if (row.kind === 'actionable') {
                    if (row.isHiddenGem) actionableGem = row.item;
                    else actionableRegular.push(row.item);
                }
            }

            let toPost = this._selectDailyPosts(actionableRegular, actionableGem);
            let usedSoftFallback = false;

            if (!toPost.length && this.softDailyFallback) {
                softRegular.sort(
                    (a, b) =>
                        (b.signal.confidence || 0) - (a.signal.confidence || 0) ||
                        (b.resultEntry.confluence || 0) - (a.resultEntry.confluence || 0)
                );
                toPost = this._selectDailyPosts(softRegular, softGem);
                usedSoftFallback = toPost.length > 0;
                if (usedSoftFallback) {
                    logger.info(
                        `📈 Daily soft fallback: posting ${toPost.length} AI≥70% alert(s) (confluence ≥${this.softMinConfluence})`
                    );
                }
            }

            // Soft candidates not selected → mark skipped
            for (const item of [...softRegular, ...(softGem ? [softGem] : [])]) {
                if (toPost.some((p) => p.symbol === item.symbol)) continue;
                await this.markDailySent(group.group_id, item.symbol, dateStr, {
                    skipped: true,
                    reason: usedSoftFallback ? 'soft_not_selected' : 'confluence',
                    signal: item.signal.recommendation,
                    confidence: item.signal.confidence,
                }).catch(() => {});
            }

            const postSymbols = new Set(toPost.map((p) => p.symbol));

            for (const item of toPost) {
                try {
                    await sock.sendMessage(group.group_id, { text: item.text });
                    item.resultEntry.posted = true;
                    item.resultEntry.softGate = Boolean(item.softGate);
                    item.resultEntry.isActionable = true;
                    await this.markDailySent(group.group_id, item.symbol, dateStr, {
                        skipped: false,
                        soft_gate: Boolean(item.softGate),
                        signal: item.signal.recommendation,
                        confidence: item.signal.confidence,
                        hidden_gem: item.resultEntry.isHiddenGem,
                    });
                    sentCount += 1;
                    const softTag = item.softGate ? ' ⚡' : '';
                    actionableSent.push(
                        `${item.resultEntry.isHiddenGem ? `${item.symbol} 💎` : item.symbol}${softTag}`
                    );
                    logger.info(
                        `✅ Trade alert sent: ${item.symbol}${item.resultEntry.isHiddenGem ? ' 💎' : ''}${item.softGate ? ' (soft)' : ''} → ${group.group_name || group.group_id}`
                    );
                    await new Promise((r) => setTimeout(r, 800));
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
                const softNote = usedSoftFallback
                    ? `\n_⚡ Soft gate day — AI ≥70% with confluence ≥${this.softMinConfluence} (strict ≥${strictMinConv})._`
                    : '';
                await sock.sendMessage(group.group_id, {
                    text:
                        `📈 *Daily F&O scan complete*\n` +
                        `Posted *${sentCount}* alert(s): *${actionableSent.join(', ')}*` +
                        softNote +
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
                        `No BUY setups today (AI ≥70% + confluence ≥${this.softMinConfluence}).${skipNote}` +
                        scanSummary +
                        `\n\nUse \`/tradenow SYMBOL\` for full analysis including NO TRADE.`,
                }).catch(() => {});
            }
        }
    }

    /** Manual preview — always fresh live scan (does not reuse all-day cache). */
    async previewDiscovery(source = null) {
        const discoverySource = normalizeDiscoverySource(source || this.defaultDiscoverySource);
        return this.runDiscovery({ forceRefresh: true, persist: false, source: discoverySource });
    }
}

export default TradeAlertController;
