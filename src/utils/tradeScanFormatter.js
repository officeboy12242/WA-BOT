/**
 * Rich WhatsApp formatting for trade scan preview & daily intro.
 */

import { formatNowLabelIST } from './dateIST.js';

function fmtPct(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${v}%`;
}

function fmtCr(n) {
    if (n == null || !Number.isFinite(Number(n))) return 'n/a';
    const v = Number(n);
    const sign = v >= 0 ? '+' : '−';
    return `${sign}₹${Math.abs(v).toLocaleString('en-IN')} Cr`;
}

/**
 * Full scan preview — `/tradelert scan` output.
 * @param {object} discovery
 */
export function formatTradeScanPreview(discovery) {
    const d = discovery || {};
    const lines = [];

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('📡 *MARKET INTELLIGENCE SCAN* 📡');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push('');

    const scanned = d.scannedAt
        ? new Date(d.scannedAt).toLocaleString('en-IN', {
              timeZone: 'Asia/Kolkata',
              dateStyle: 'medium',
              timeStyle: 'short',
          })
        : formatNowLabelIST();
    lines.push(`🕐 *Scanned:* ${scanned} IST`);
    lines.push(`📍 *Mode:* ${d.marketModeLabel || d.marketMode || 'MARKET'}`);
    if (d.discoverySource === 'heatmap2') {
        lines.push('📡 *Discovery:* Heatmap v2 — live intraday · VWAP · RS · ATR');
    } else if (d.discoverySource === 'heatmap') {
        lines.push('📡 *Discovery:* NSE Heatmap + 15m OR / 8 EMA');
    } else if (d.discoverySource === 'preopen') {
        lines.push('📡 *Discovery:* Pre-open auction — IEP · order imbalance');
    } else if (d.discoverySource === 'nse') {
        lines.push('📡 *Discovery:* NSE NIFTY50 top gainers + losers');
    }
    if (d.freshness?.ok === false) {
        lines.push(`⚠️ *Freshness:* ${d.freshness.message || 'stale data — watch only'}`);
    } else {
        lines.push('🟢 *Data:* fresh');
    }
    lines.push('');

    // Heatmap v2 — different shape from v1: no `status`, targets are 1R/2R,
    // and a pick may legitimately carry no setup before the opening range closes.
    const hm = d.heatmap;
    // Pre-open has no sector sentiment, no regime and no `status` — rendering it
    // through either heatmap branch would print "15m OR / 8 EMA" for a scan that
    // ran before a single bar existed.
    if (hm?.version === 'preopen' && hm.picks?.length) {
        lines.push('┌─ *PRE-OPEN AUCTION* ─');
        lines.push(`│ Auction closed: ${hm.asOf || '09:08'}`);
        lines.push(`│ Board median: ${fmtPct(hm.marketGapPct)}`);
        for (const p of hm.picks) {
            const s = p.setup;
            const book = `book ${p.imbalance >= 0 ? '+' : ''}${Math.round(p.imbalance * 100)}%`;
            lines.push(
                `│ • *${p.symbol}* ${fmtPct(p.relGapPct)} vs board · ` +
                `${String(p.side).toUpperCase()} · ${book} · score ${p.score}`
            );
            if (s) {
                lines.push(`│    E ${s.entry} · SL ${s.stop} · T1 ${s.target1} · T2 ${s.target2}`);
            } else {
                lines.push(`│    IEP ₹${p.iep} · levels unavailable`);
            }
        }
        lines.push('└────────────────────────────');
        lines.push('│ _Auction consensus only — no opening range or VWAP yet._');
        lines.push('');
    } else if (hm?.version === 2 && hm.picks?.length) {
        lines.push('┌─ *HEATMAP v2 — LIVE BREAKOUTS* ─');
        lines.push(`│ Sectors: ${hm.sentiment?.label || 'n/a'} (G${hm.sentiment?.green ?? '?'} / R${hm.sentiment?.red ?? '?'})`);
        lines.push(`│ Regime: ${hm.regime?.label || 'n/a'}`);
        if (hm.preOpeningRange) {
            lines.push('│ ⏳ Opening range still forming — watchlist only');
        }
        for (const p of hm.picks) {
            const s = p.setup;
            const rs = p.relStrength != null ? ` · RS ${fmtPct(p.relStrength)}` : '';
            if (!s) {
                lines.push(`│ • *${p.symbol}* ${fmtPct(p.changePct)} · ${String(p.side).toUpperCase()}${rs} · watch`);
                continue;
            }
            lines.push(
                `│ • *${p.symbol}* ${fmtPct(p.changePct)} · ${s.direction.toUpperCase()} · score ${s.score}${rs}`
            );
            lines.push(`│    E ${s.entry} · SL ${s.stop} · T1 ${s.target1} · T2 ${s.target2}`);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    } else if (hm?.picks?.length) {
        lines.push('┌─ *HEATMAP + 15m OR / 8 EMA* ─');
        lines.push(`│ Bias: ${hm.sentiment?.label || 'n/a'} (G${hm.sentiment?.green ?? '?'} / R${hm.sentiment?.red ?? '?'})`);
        for (const p of hm.picks) {
            const s = p.setup || {};
            const chg = p.changePct != null ? fmtPct(p.changePct) : '';
            const st = s.status || 'watch';
            const dir = (s.direction || p.side || '').toUpperCase();
            let row = `│ • *${p.symbol}* ${chg} · ${dir} · ${st} (${s.score ?? 0})`;
            if (s.entry != null) row += ` · E ${s.entry} SL ${s.stop}`;
            lines.push(row);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // NSE G/L (when discovery source = nse)
    const gl = d.niftyGl;
    if (gl && (gl.gainers?.length || gl.losers?.length)) {
        lines.push('┌─ *NSE NIFTY 50 GAINERS / LOSERS* ─');
        if (gl.timestamp) lines.push(`│ As of: ${gl.timestamp}`);
        for (const g of gl.gainers || []) {
            lines.push(`│ ▲ *${g.symbol}* ${fmtPct(g.changePct)}${g.last != null ? ` · ₹${g.last}` : ''}`);
        }
        for (const l of gl.losers || []) {
            lines.push(`│ ▼ *${l.symbol}* ${fmtPct(l.changePct)}${l.last != null ? ` · ₹${l.last}` : ''}`);
        }
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // Macro block
    // Built separately so an empty macro (pre-open runs before the index ticks)
    // renders nothing at all rather than a bare header/footer pair.
    const macro = d.macro || {};
    const macroLines = [];
    if (macro.nifty?.pct != null) {
        macroLines.push(`│ NIFTY 50: *${fmtPct(macro.nifty.pct)}*`);
    }
    if (macro.vix?.last != null) {
        macroLines.push(`│ India VIX: *${macro.vix.last}*`);
    }
    if (macro.fiiNet != null) macroLines.push(`│ FII: *${fmtCr(macro.fiiNet)}*`);
    if (macro.diiNet != null) macroLines.push(`│ DII: *${fmtCr(macro.diiNet)}*`);
    if (macro.bias) {
        macroLines.push(
            `│ Bias: *${macro.bias.emoji} ${macro.bias.label}* (${macro.bias.score >= 0 ? '+' : ''}${macro.bias.score})`
        );
    }
    if (macroLines.length) {
        lines.push('┌─ *MACRO PULSE* ─────────────');
        lines.push(...macroLines);
        lines.push('└────────────────────────────');
        lines.push('');
    }

    // Delta
    if (d.delta?.lines?.length) {
        lines.push('📊 *What changed*');
        for (const ln of d.delta.lines) {
            lines.push(`  • ${ln}`);
        }
        lines.push('');
    }

    // Hot sectors
    const hot = d.hotSectors?.hot || [];
    if (hot.length) {
        lines.push('🔥 *HOT SECTORS*');
        for (const sec of hot) {
            const leaders = (sec.gainers || [])
                .slice(0, 3)
                .map((g) => `*${g.symbol}* ${fmtPct(g.changePct)}`)
                .join(' · ');
            lines.push(`  ▲ *${sec.label}* ${fmtPct(sec.indexPct)}`);
            if (leaders) lines.push(`     ${leaders}`);
        }
        lines.push('');
    }

    const cold = d.hotSectors?.cold || [];
    if (cold.length) {
        lines.push('🧊 *LAGGING SECTORS*');
        for (const sec of cold.slice(0, 3)) {
            lines.push(`  ▼ ${sec.label} ${fmtPct(sec.indexPct)}`);
        }
        lines.push('');
    }

    // Phase 4 picks
    if (d.phase4Picks?.length) {
        lines.push('🎯 *PHASE-4 TOP PICKS*');
        for (const p of d.phase4Picks.slice(0, 5)) {
            const score = Math.round(Number(p.score) || 0);
            lines.push(
                `  • *${p.symbol}* (${p.sector || '—'}) score ${score}` +
                    (p.changePct != null ? ` · ${fmtPct(p.changePct)}` : '')
            );
        }
        lines.push('');
    }

    // Momentum
    if (d.momentumAlerts?.length) {
        lines.push('⚡ *MOMENTUM SCANNER*');
        for (const m of d.momentumAlerts.slice(0, 6)) {
            lines.push(
                `  • *${m.symbol}* ${fmtPct(m.changePct)}` +
                    (m.rs != null ? ` RS${m.rs >= 0 ? '+' : ''}${m.rs.toFixed(1)}%` : '') +
                    (m.turnoverCr != null ? ` · ₹${m.turnoverCr}Cr` : '')
            );
        }
        lines.push('');
    }

    // Smart money
    if (d.smartMoney?.deals?.length) {
        lines.push('💰 *SMART MONEY (Bulk/Block)*');
        for (const deal of d.smartMoney.deals.slice(0, 5)) {
            const val = deal.valueCr != null ? ` ₹${deal.valueCr} Cr` : '';
            lines.push(`  • *${deal.symbol}* ${deal.kind}${val}`);
        }
        lines.push('');
    }

    // Catalyst radar
    if (d.catalystHighlights?.length) {
        lines.push('📰 *CATALYST RADAR*');
        for (const h of d.catalystHighlights.slice(0, 5)) {
            lines.push(`  ${h}`);
        }
        lines.push('');
    }

    // Final watchlist
    lines.push('📋 *TODAY\'S WATCHLIST*');
    if (d.symbols?.length) {
        lines.push(`  ${d.symbols.join(' · ')}`);
    } else {
        // A bare "n/a" gave no way to tell a filtered-out day from a broken
        // scan. The reject tally answers that in one line.
        lines.push('  _No qualifying names right now._');
        const r = d.heatmap?.rejects;
        if (r) {
            const why = [
                r.flat ? `${r.flat} moving too little` : null,
                r.noSetup ? `${r.noSetup} with no confirmed breakout` : null,
                r.lowScore ? `${r.lowScore} below the score floor` : null,
                r.wrongRs ? `${r.wrongRs} lagging the index` : null,
                r.illiquid ? `${r.illiquid} too illiquid` : null,
                r.noData ? `${r.noData} with no price data` : null,
                // pre-open reject reasons
                r.thinAuction ? `${r.thinAuction} with too thin an auction` : null,
                r.noRelMove ? `${r.noRelMove} moving with the board` : null,
                r.bookDisagrees ? `${r.bookDisagrees} where the order book disagreed` : null,
                r.lopsided ? `${r.lopsided} with a one-sided book` : null,
                r.noBook ? `${r.noBook} with no resting orders` : null,
            ].filter(Boolean);
            if (why.length) {
                const scanned = d.heatmap.candidatesScanned ?? d.heatmap.scanned ?? '?';
                lines.push(`  _Of ${scanned} scanned: ${why.join(', ')}._`);
            }
        }
    }
    if (d.hiddenGem) {
        lines.push(`  💎 *Gem:* ${d.hiddenGem}${d.hiddenGemReason ? ` — _${d.hiddenGemReason}_` : ''}`);
    }
    lines.push('');

    if (d.symbolMeta?.length) {
        lines.push('🔍 *PICK SOURCES*');
        for (const m of d.symbolMeta.slice(0, 12)) {
            const conf = m.confluence != null ? ` conf ${m.confluence}` : '';
            lines.push(`  • ${m.symbol}: ${m.sources?.join(', ') || 'mover'}${conf}`);
        }
        lines.push('');
    }

    lines.push('─────────────────────────────');
    lines.push(
        `_Gates: confluence ≥${d.gates?.minConfluence ?? 40} · AI confidence ≥${d.gates?.minConfidence ?? 70}%_`
    );
    lines.push('_Full CE+PE analysis at alert time; only VALID high-confluence BUYs posted._');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return lines.join('\n');
}

/**
 * Shorter intro sent before daily analysis in groups.
 */
export function formatDailyScanIntro(discovery, { symbols = [], hiddenGem, hiddenGemReason, maxSends = 5 } = {}) {
    const preview = formatTradeScanPreview({
        ...discovery,
        symbols,
        hiddenGem,
        hiddenGemReason,
    });

    const header =
        `📡 *Daily F&O Scan* · ${formatNowLabelIST()}\n` +
        `_Analyzing ${symbols.length} names — may take several minutes._\n\n`;

    const macro = discovery?.macro;
    let brief = '';
    if (macro?.bias) {
        brief += `${macro.bias.emoji} *${macro.bias.label}* market`;
        if (macro.nifty?.pct != null) brief += ` · NIFTY ${fmtPct(macro.nifty.pct)}`;
        brief += '\n';
    }
    if (discovery?.hotSectors?.hot?.length) {
        const top = discovery.hotSectors.hot
            .slice(0, 3)
            .map((s) => `${s.label} ${fmtPct(s.indexPct)}`)
            .join(' · ');
        brief += `🔥 Hot: ${top}\n`;
    }
    brief += `📋 Scan: *${symbols.join(', ')}*\n`;
    if (hiddenGem) {
        brief += `💎 Gem hunt: *${hiddenGem}*${hiddenGemReason ? ` — _${hiddenGemReason}_` : ''}\n`;
    }
    brief += `_Max ${maxSends} actionable alerts · confluence + ≥70% AI_\n\n`;

    return brief + preview;
}

export function formatAlertMetaFooter(meta = {}) {
    const parts = [];
    if (meta.entryState?.label) parts.push(meta.entryState.label);
    if (meta.confluence != null) parts.push(`Confluence: ${meta.confluence}/100`);
    if (meta.freshness) parts.push(`Fresh: ${meta.freshness}`);
    if (!parts.length) return '';
    return `\n📋 _${parts.join(' · ')}_`;
}
