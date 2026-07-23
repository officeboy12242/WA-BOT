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
    if (d.discoverySource === 'heatmap') {
        lines.push('📡 *Discovery:* NSE Heatmap + 15m OR / 8 EMA');
    } else if (d.discoverySource === 'nse') {
        lines.push('📡 *Discovery:* NSE NIFTY50 top gainers + losers');
    }
    if (d.freshness?.ok === false) {
        lines.push(`⚠️ *Freshness:* ${d.freshness.message || 'stale data — watch only'}`);
    } else {
        lines.push('🟢 *Data:* fresh');
    }
    lines.push('');

    // Heatmap OR/EMA setups
    const hm = d.heatmap;
    if (hm?.picks?.length) {
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
    lines.push('┌─ *MACRO PULSE* ─────────────');
    const macro = d.macro || {};
    if (macro.nifty?.pct != null) {
        lines.push(`│ NIFTY 50: *${fmtPct(macro.nifty.pct)}*`);
    }
    if (macro.vix?.last != null) {
        lines.push(`│ India VIX: *${macro.vix.last}*`);
    }
    if (macro.fiiNet != null) lines.push(`│ FII: *${fmtCr(macro.fiiNet)}*`);
    if (macro.diiNet != null) lines.push(`│ DII: *${fmtCr(macro.diiNet)}*`);
    if (macro.bias) {
        lines.push(
            `│ Bias: *${macro.bias.emoji} ${macro.bias.label}* (${macro.bias.score >= 0 ? '+' : ''}${macro.bias.score})`
        );
    }
    lines.push('└────────────────────────────');
    lines.push('');

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
    lines.push(`  ${(d.symbols || []).join(' · ') || 'n/a'}`);
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
