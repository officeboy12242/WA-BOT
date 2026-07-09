/**
 * NSE macro + sector data (FII/DII, indices, hot sectors).
 */

import { logger } from '../utils/logger.js';
import { nseGetSafe } from '../utils/nseClient.js';
import { NSE_SECTOR_INDICES, KEY_MACRO_INDICES } from '../data/nseSectors.js';
import { NSE_SECTOR_STOCKS } from '../data/nseSectorStocks.js';
import { computeMarketBias } from '../utils/marketBiasScore.js';

function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseIndexRow(row) {
    const name = String(row?.index || row?.indexSymbol || row?.name || '').trim();
    const pct = safeNum(row?.percentChange ?? row?.pChange ?? row?.change);
    const last = safeNum(row?.last ?? row?.lastPrice);
    return { name, pct, last };
}

function parseEquityStockRows(stocks) {
    const movers = stocks
        .filter((s) => s?.symbol && !/NIFTY|INDEX/i.test(s.symbol))
        .map((s) => ({
            symbol: String(s.symbol).trim().toUpperCase(),
            name: s.meta?.companyName || s.companyName || s.symbol,
            changePct: safeNum(s.pChange ?? s.percentChange),
            last: safeNum(s.lastPrice ?? s.ltp),
            volume: safeNum(s.totalTradedVolume),
        }))
        .filter((s) => s.changePct != null)
        .sort((a, b) => b.changePct - a.changePct);

    const indexRow = stocks.find((s) => /NIFTY|INDEX/i.test(String(s?.symbol || '')));
    const indexPct = safeNum(indexRow?.pChange ?? indexRow?.percentChange);

    return { indexPct, gainers: movers.filter((m) => m.changePct > 0), losers: [...movers].sort((a, b) => a.changePct - b.changePct) };
}

function buildStockChangeMap(preOpen) {
    const map = new Map();
    for (const row of preOpen?.data || []) {
        const m = row?.metadata || row;
        const sym = String(m.symbol || '').trim().toUpperCase();
        if (!sym) continue;
        map.set(sym, {
            symbol: sym,
            name: sym,
            changePct: safeNum(m.pChange ?? m.percentChange),
            last: safeNum(m.lastPrice ?? m.iep),
            volume: safeNum(m.finalQuantity ?? m.totalTradedVolume),
        });
    }
    return map;
}

function moversFromSectorStocks(sectorKey, stockMap, stocksPerSector) {
    const symbols = NSE_SECTOR_STOCKS[sectorKey] || [];
    const movers = symbols
        .map((sym) => stockMap.get(sym))
        .filter((s) => s && s.changePct != null)
        .sort((a, b) => b.changePct - a.changePct);

    return {
        gainers: movers.filter((m) => m.changePct > 0).slice(0, stocksPerSector),
        losers: [...movers].sort((a, b) => a.changePct - b.changePct).slice(0, 2),
    };
}

class NseMarketDataService {
    async fetchAllIndicesRows() {
        const allIndices = await nseGetSafe('allIndices');
        const rawList = allIndices?.data || allIndices || [];
        if (!Array.isArray(rawList)) return [];
        return rawList.map(parseIndexRow).filter((i) => i.name);
    }

    async fetchMacroSnapshot() {
        const [indices, fiiDii] = await Promise.all([
            this.fetchAllIndicesRows(),
            nseGetSafe('fiidiiTradeReact'),
        ]);

        const macroIndices = indices.filter((i) =>
            KEY_MACRO_INDICES.some((k) => i.name.toUpperCase().includes(k.replace('NIFTY ', 'NIFTY')))
        );

        const nifty = indices.find((i) => /NIFTY 50/i.test(i.name));
        const vix = indices.find((i) => /VIX/i.test(i.name));

        let fiiNet = null;
        let diiNet = null;
        const fiiRows = fiiDii?.data || fiiDii || [];
        if (Array.isArray(fiiRows)) {
            for (const row of fiiRows) {
                const cat = String(row?.category || row?.type || '').toUpperCase();
                const net = safeNum(row?.netValue ?? row?.net_value ?? row?.netBuy ?? row?.net);
                if (cat.includes('FII') || cat.includes('FPI')) fiiNet = net;
                if (cat.includes('DII')) diiNet = net;
            }
        }

        const bias = computeMarketBias({
            fiiNet,
            diiNet,
            niftyChangePct: nifty?.pct,
            vix: vix?.last,
            vixChangePct: null,
        });

        return {
            indices: macroIndices.length ? macroIndices : indices.slice(0, 8),
            nifty,
            vix,
            fiiNet,
            diiNet,
            bias,
            fetchedAt: new Date(),
        };
    }

    /**
     * Hot sectors ranked by index % change + top stocks per sector.
     * Uses allIndices for sector % (reliable) and pre-open / equity-stockIndices for movers.
     */
    async fetchHotSectors({ topSectors = 5, stocksPerSector = 3 } = {}) {
        const [indices, preOpen, probeSector] = await Promise.all([
            this.fetchAllIndicesRows(),
            nseGetSafe('market-data-pre-open?key=ALL'),
            nseGetSafe(`equity-stockIndices?index=${NSE_SECTOR_INDICES[0].nseIndex}`),
        ]);

        const indexByName = new Map(indices.map((i) => [i.name.toUpperCase(), i]));
        const stockMap = buildStockChangeMap(preOpen);
        const equityApiWorks = Array.isArray(probeSector?.data) && probeSector.data.length > 1;
        const sectorRows = [];

        for (const sector of NSE_SECTOR_INDICES) {
            const idx = indexByName.get(sector.key.toUpperCase());
            let indexPct = idx?.pct ?? null;
            let gainers = [];
            let losers = [];
            let source = 'allIndices';

            if (equityApiWorks) {
                const data = await nseGetSafe(`equity-stockIndices?index=${sector.nseIndex}`);
                const parsed = parseEquityStockRows(data?.data || []);
                if (parsed.indexPct != null) indexPct = parsed.indexPct;
                gainers = parsed.gainers.slice(0, stocksPerSector);
                losers = parsed.losers.slice(0, 2);
                source = 'equity-stockIndices';
            } else if (stockMap.size > 0) {
                const parsed = moversFromSectorStocks(sector.key, stockMap, stocksPerSector);
                gainers = parsed.gainers;
                losers = parsed.losers;
                source = 'pre-open';
            }

            sectorRows.push({
                key: sector.key,
                label: sector.label,
                indexPct,
                gainers,
                losers,
                source,
            });
        }

        const ranked = sectorRows
            .filter((s) => s.indexPct != null)
            .sort((a, b) => b.indexPct - a.indexPct);

        const hot = ranked.slice(0, topSectors);
        const cold = [...ranked].sort((a, b) => a.indexPct - b.indexPct).slice(0, 3);

        logger.info(
            `📊 Hot sectors (${equityApiWorks ? 'equity API' : 'pre-open fallback'}): ${hot.map((s) => `${s.label} ${s.indexPct}%`).join(', ') || 'n/a'}`
        );

        return { hot, cold, all: sectorRows, fetchedAt: new Date() };
    }

    formatMacroBlock(macro) {
        if (!macro) return 'Macro: unavailable';
        const lines = ['=== MACRO (NSE) ==='];
        if (macro.nifty?.pct != null) {
            lines.push(`NIFTY 50: ${macro.nifty.pct >= 0 ? '+' : ''}${macro.nifty.pct}%`);
        }
        if (macro.vix?.last != null) {
            lines.push(`India VIX: ${macro.vix.last}`);
        }
        if (macro.fiiNet != null) {
            const sign = macro.fiiNet >= 0 ? '+' : '';
            lines.push(`FII net: ${sign}₹${Math.abs(macro.fiiNet).toLocaleString('en-IN')} Cr`);
        }
        if (macro.diiNet != null) {
            const sign = macro.diiNet >= 0 ? '+' : '';
            lines.push(`DII net: ${sign}₹${Math.abs(macro.diiNet).toLocaleString('en-IN')} Cr`);
        }
        if (macro.bias) {
            lines.push(`Market bias: ${macro.bias.label} (${macro.bias.score >= 0 ? '+' : ''}${macro.bias.score})`);
        }
        return lines.join('\n');
    }

    formatHotSectorsBlock(hotSectors) {
        if (!hotSectors?.hot?.length) return '';
        const lines = ['=== HOT SECTORS ==='];
        for (const sec of hotSectors.hot) {
            const pct = sec.indexPct != null ? `${sec.indexPct >= 0 ? '+' : ''}${sec.indexPct}%` : 'n/a';
            const leaders = sec.gainers
                .slice(0, 3)
                .map((g) => `${g.symbol} ${g.changePct >= 0 ? '+' : ''}${g.changePct}%`)
                .join(', ');
            lines.push(`${sec.label} ${pct}${leaders ? ` → ${leaders}` : ''}`);
        }
        return lines.join('\n');
    }
}

export const nseMarketDataService = new NseMarketDataService();
export default NseMarketDataService;
