/**
 * Enhanced trade discovery — combines IMT scanning + copilot gates.
 */

import { logger } from '../utils/logger.js';
import { marketScanService, FNO_UNIVERSE } from './MarketScanService.js';
import { nseMarketDataService } from './NseMarketDataService.js';
import { smartMoneyScanService } from './SmartMoneyScanService.js';
import { catalystRadarService } from './CatalystRadarService.js';
import { stockNewsService } from './StockNewsService.js';
import { scoreConfluence, getMinConfluenceScore, adjustConfidenceFloor } from '../utils/tradeConfluenceScore.js';
import { getIndiaMarketMode, checkQuoteFreshness } from '../utils/indianMarketCalendar.js';
import { createMarketDeltaService } from './MarketDeltaService.js';
import { createTradeOutcomeService } from './TradeOutcomeService.js';

const MOMENTUM_RS_MIN = 1.5;
const MOMENTUM_TURNOVER_MIN_CR = 500;

function estimateTurnoverCr(price, volume) {
    const p = Number(price);
    const v = Number(volume);
    if (!Number.isFinite(p) || !Number.isFinite(v)) return null;
    return Number(((p * v) / 1e7).toFixed(0));
}

function buildPhase4Picks(hotSectors, universeRows, macro, limit = 5) {
    const niftyPct = Number(macro?.nifty?.pct) || 0;
    const picks = [];
    const seen = new Set();

    for (const sec of hotSectors?.hot || []) {
        for (const stock of sec.gainers || []) {
            const sym = stock.symbol;
            if (!sym || seen.has(sym)) continue;
            seen.add(sym);

            let score = 50;
            if (sec.indexPct != null && sec.indexPct > 0) score += 15;
            const chg = Number(stock.changePct) || 0;
            const rs = chg - niftyPct;
            if (rs >= MOMENTUM_RS_MIN) score += 20;
            if (macro?.bias?.label === 'BULLISH') score += 10;

            picks.push({
                symbol: sym,
                sector: sec.label,
                score: Math.min(100, score),
                changePct: stock.changePct,
                reason: `hot ${sec.label} + momentum`,
            });
        }
    }

    for (const row of universeRows || []) {
        const sym = row.symbol;
        if (!sym || seen.has(sym)) continue;
        const chg = Number(row.changePct);
        if (!Number.isFinite(chg)) continue;
        const rs = chg - niftyPct;
        if (rs < MOMENTUM_RS_MIN) continue;
        const turnover = estimateTurnoverCr(row.price, row.volume);
        if (turnover != null && turnover < MOMENTUM_TURNOVER_MIN_CR) continue;

        seen.add(sym);
        picks.push({
            symbol: sym,
            sector: null,
            score: 45 + Math.min(30, rs * 8),
            changePct: chg,
            reason: 'momentum RS + volume',
        });
    }

    return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildMomentumAlerts(universeRows, niftyPct) {
    const out = [];
    for (const row of universeRows || []) {
        const chg = Number(row.changePct);
        if (!Number.isFinite(chg) || chg <= 0) continue;
        const rs = chg - (Number(niftyPct) || 0);
        if (rs < MOMENTUM_RS_MIN) continue;
        const turnoverCr = estimateTurnoverCr(row.price, row.volume);
        if (turnoverCr != null && turnoverCr < MOMENTUM_TURNOVER_MIN_CR) continue;
        out.push({
            symbol: row.symbol,
            changePct: chg,
            rs,
            turnoverCr,
        });
    }
    return out.sort((a, b) => b.rs - a.rs).slice(0, 6);
}

function mergeWatchlist({
    phase4Picks,
    momentumAlerts,
    smartMoneyDeals,
    hiddenGem,
    moversWatchlist,
    targetCount,
}) {
    const ordered = [];
    const seen = new Set();
    const meta = new Map();

    const add = (symbol, source) => {
        const sym = String(symbol || '').trim().toUpperCase();
        if (!sym || seen.has(sym)) {
            if (sym && meta.has(sym)) {
                const m = meta.get(sym);
                if (!m.sources.includes(source)) m.sources.push(source);
            }
            return;
        }
        seen.add(sym);
        ordered.push(sym);
        meta.set(sym, { symbol: sym, sources: [source] });
    };

    if (hiddenGem) add(hiddenGem, 'hidden gem');
    for (const p of phase4Picks || []) add(p.symbol, 'phase4');
    for (const m of momentumAlerts || []) add(m.symbol, 'momentum');
    for (const d of smartMoneyDeals || []) add(d.symbol, 'smart money');
    for (const sym of moversWatchlist || []) add(sym, 'mover');

    return {
        symbols: ordered.slice(0, targetCount),
        symbolMeta: ordered.slice(0, targetCount).map((s) => meta.get(s) || { symbol: s, sources: ['mover'] }),
    };
}

function normalizeDiscoverySource(v) {
    const s = String(v || '').trim().toLowerCase();
    return s === 'nse' || s === 'nse_gl' || s === 'gl' || s === 'gainers' ? 'nse' : 'legacy';
}

class TradeDiscoveryEngine {
    constructor(config = {}, mongoDb = null) {
        this.config = config;
        this.delta = createMarketDeltaService(mongoDb);
        this.outcomes = createTradeOutcomeService(mongoDb, config);
        this.discoveryCount = config.TRADE_ALERT_DISCOVERY_COUNT || 10;
        this.nseGlEach = config.TRADE_ALERT_NSE_GL_EACH || 5;
    }

    async run({ forceRefresh = false, source = null } = {}) {
        const discoverySource = normalizeDiscoverySource(
            source ?? this.config.TRADE_ALERT_DISCOVERY_SOURCE
        );
        if (discoverySource === 'nse') {
            return this.runNseGainersLosers();
        }
        return this.runLegacy({ forceRefresh });
    }

    /** NIFTY 50 top N gainers + top N losers → analyze those only. */
    async runNseGainersLosers() {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();
        const each = this.nseGlEach;

        const [niftyGl, macro, marketNewsPack, calibration] = await Promise.all([
            nseMarketDataService.fetchNiftyTopGainersLosers({ each }),
            nseMarketDataService.fetchMacroSnapshot(),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const headlines = String(marketNewsPack?.context || '')
            .split('\n')
            .filter(Boolean);

        const seen = new Set();
        const symbols = [];
        const symbolMeta = [];
        const universeRows = [];

        const pushSide = (rows, side) => {
            for (const row of rows || []) {
                const sym = row.symbol;
                if (!sym || seen.has(sym)) continue;
                seen.add(sym);
                symbols.push(sym);
                symbolMeta.push({ symbol: sym, sources: [`nse ${side}`] });
                universeRows.push({
                    symbol: sym,
                    changePct: row.changePct,
                    price: row.last,
                    volume: row.volume,
                });
            }
        };
        pushSide(niftyGl.gainers, 'gainer');
        pushSide(niftyGl.losers, 'loser');

        const movers = {
            gainers: (niftyGl.gainers || []).map((r) => ({
                symbol: r.symbol,
                changePct: r.changePct,
                price: r.last,
            })),
            losers: (niftyGl.losers || []).map((r) => ({
                symbol: r.symbol,
                changePct: r.changePct,
                price: r.last,
            })),
        };

        const catalystItems = catalystRadarService.scanHeadlines(headlines, new Set(symbols));
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const enrichedMeta = symbols.map((sym) => {
            const base = symbolMeta.find((m) => m.symbol === sym) || { symbol: sym, sources: ['nse'] };
            const row = universeRows.find((r) => r.symbol === sym);
            const conf = scoreConfluence({
                symbol: sym,
                quote: row,
                movers,
                macro,
                catalystItems,
                smartMoneyDeals: [],
                sectorTag: null,
            });
            return {
                ...base,
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
            };
        });

        const moversBrief = [
            movers.gainers.length
                ? `G: ${movers.gainers.map((x) => `${x.symbol}${x.changePct != null ? ` +${x.changePct}%` : ''}`).join(', ')}`
                : '',
            movers.losers.length
                ? `L: ${movers.losers.map((x) => `${x.symbol}${x.changePct != null ? ` ${x.changePct}%` : ''}`).join(', ')}`
                : '',
        ]
            .filter(Boolean)
            .join(' · ');

        const freshness = checkQuoteFreshness(scannedAt);
        const minConfluence = calibration.minConfluence || getMinConfluenceScore(this.config);
        const minConfidence = calibration.minConfidence || adjustConfidenceFloor(macro, 70);

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            nseMarketDataService.formatNiftyGlBlock(niftyGl),
        ]
            .filter(Boolean)
            .join('\n\n');

        logger.info(
            `📡 NSE G/L discovery: ${symbols.length} symbols (${each}G+${each}L) · bias ${macro?.bias?.label}`
        );

        return {
            symbols,
            symbolMeta: enrichedMeta,
            context,
            universeRows,
            movers,
            moversBrief,
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors: { hot: [], cold: [] },
            phase4Picks: [],
            momentumAlerts: [],
            smartMoney: { deals: [] },
            catalystItems,
            catalystHighlights,
            niftyGl,
            delta: null,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness,
            gates: {
                minConfluence,
                minConfidence,
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'nse',
        };
    }

    async runLegacy({ forceRefresh = false } = {}) {
        const marketMode = getIndiaMarketMode();
        const scannedAt = new Date();

        const [baseSnapshot, macro, hotSectors, smartMoney, marketNewsPack, calibration] = await Promise.all([
            marketScanService.buildDiscoverySnapshot(),
            nseMarketDataService.fetchMacroSnapshot(),
            nseMarketDataService.fetchHotSectors({ topSectors: 5, stocksPerSector: 4 }),
            smartMoneyScanService.fetchTodayDeals(),
            stockNewsService.fetchMarketHeadlines(),
            this.outcomes.getCalibration(),
        ]);

        const universeRows = baseSnapshot.universeRows || [];
        const niftyPct = macro?.nifty?.pct;

        const headlines = String(marketNewsPack?.context || baseSnapshot.marketNews || '')
            .split('\n')
            .filter(Boolean);
        const symbolUniverse = new Set([
            ...FNO_UNIVERSE,
            ...universeRows.map((r) => r.symbol),
            ...(hotSectors.hot || []).flatMap((s) => (s.gainers || []).map((g) => g.symbol)),
        ]);
        const catalystItems = catalystRadarService.scanHeadlines(headlines, symbolUniverse);
        const catalystHighlights = catalystRadarService.formatHighlights(catalystItems);

        const phase4Picks = buildPhase4Picks(hotSectors, universeRows, macro, 5);
        const momentumAlerts = buildMomentumAlerts(universeRows, niftyPct);

        const moversWatchlist = marketScanService.buildFreshMoversWatchlist(
            universeRows,
            this.discoveryCount,
            { hiddenGem: null }
        );

        const { symbols, symbolMeta } = mergeWatchlist({
            phase4Picks,
            momentumAlerts,
            smartMoneyDeals: smartMoney.deals,
            hiddenGem: null,
            moversWatchlist,
            targetCount: this.discoveryCount,
        });

        const finalized = marketScanService.finalizeWatchlist(symbols, universeRows, this.discoveryCount);

        const sectorBySymbol = new Map();
        for (const sec of hotSectors.hot || []) {
            for (const g of sec.gainers || []) {
                sectorBySymbol.set(g.symbol, sec.label);
            }
        }

        const enrichedMeta = [];
        for (const sym of finalized) {
            const base = symbolMeta.find((m) => m.symbol === sym) || { symbol: sym, sources: ['mover'] };
            const row = universeRows.find((r) => r.symbol === sym);
            const conf = scoreConfluence({
                symbol: sym,
                quote: row,
                movers: baseSnapshot.movers,
                macro,
                catalystItems,
                smartMoneyDeals: smartMoney.deals,
                sectorTag: sectorBySymbol.get(sym),
            });
            enrichedMeta.push({
                ...base,
                confluence: conf.score,
                confluencePass: conf.passes,
                blocked: conf.blocked,
            });
        }

        const snapshotPayload = { macro, hotSectors, phase4Picks, momentumAlerts };
        const prev = await this.delta.loadLastSnapshot();
        const delta = this.delta.computeDelta(prev, snapshotPayload);
        await this.delta.saveSnapshot(snapshotPayload);

        const freshness = checkQuoteFreshness(scannedAt);
        const minConfluence = calibration.minConfluence || getMinConfluenceScore(this.config);
        const minConfidence = calibration.minConfidence || adjustConfidenceFloor(macro, 70);

        const context = [
            nseMarketDataService.formatMacroBlock(macro),
            nseMarketDataService.formatHotSectorsBlock(hotSectors),
            baseSnapshot.context,
        ].join('\n\n');

        logger.info(
            `📡 Enhanced discovery: ${finalized.length} symbols · bias ${macro?.bias?.label} · ` +
                `hot ${(hotSectors.hot || []).map((s) => s.label).join(',')}`
        );

        return {
            symbols: finalized,
            symbolMeta: enrichedMeta,
            context,
            universeRows,
            movers: baseSnapshot.movers,
            moversBrief: marketScanService.formatMoversBrief(baseSnapshot.movers),
            marketNews: headlines.slice(0, 6).join('\n'),
            macro,
            hotSectors,
            phase4Picks,
            momentumAlerts,
            smartMoney,
            catalystItems,
            catalystHighlights,
            niftyGl: null,
            delta,
            marketMode: marketMode.mode,
            marketModeLabel: marketMode.label,
            freshness,
            gates: {
                minConfluence,
                minConfidence,
                watchOnly: marketMode.watchOnly,
                allowsLiveEntry: marketMode.allowsLiveEntry,
            },
            scannedAt,
            calibration,
            discoverySource: 'legacy',
        };
    }
}

export function createTradeDiscoveryEngine(config, mongoDb) {
    return new TradeDiscoveryEngine(config, mongoDb);
}

export default TradeDiscoveryEngine;
