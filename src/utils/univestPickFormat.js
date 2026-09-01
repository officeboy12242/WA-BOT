/** Normalize Univest-style research pick payloads for WhatsApp. */

const ACTION_EMOJI = {
    BUY: '🟢',
    SELL: '🔴',
    HOLD: '🟡',
    EXIT: '🔴',
    LONG: '🟢',
    SHORT: '🔴',
};

export function normalizeUnivestPick(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const symbol = String(raw.symbol || raw.ticker || raw.scrip || '').trim().toUpperCase();
    const action = String(raw.action || raw.side || raw.call || raw.rating || 'BUY')
        .trim()
        .toUpperCase();
    if (!symbol) return null;

    const num = (v) => {
        const n = parseFloat(String(v ?? '').replace(/,/g, ''));
        return Number.isFinite(n) ? n : null;
    };

    return {
        symbol,
        action,
        entry: num(raw.entry ?? raw.entryPrice ?? raw.buyPrice),
        target: num(raw.target ?? raw.targetPrice ?? raw.tp),
        stopLoss: num(raw.stopLoss ?? raw.stop_loss ?? raw.sl ?? raw.stoploss),
        segment: String(raw.segment || raw.type || 'STOCK').trim().toUpperCase(),
        title: String(raw.title || raw.name || '').trim(),
        note: String(raw.note || raw.reason || raw.thesis || '').trim(),
        reportUrl: String(raw.reportUrl || raw.report_url || raw.link || '').trim(),
        horizon: String(raw.horizon || raw.duration || raw.term || '').trim(),
    };
}

export function formatUnivestPick(pick) {
    const p = normalizeUnivestPick(pick);
    if (!p) return null;

    const emoji = ACTION_EMOJI[p.action] || '📊';
    const lines = [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `${emoji} *UNIVEST ${p.action}* — *${p.symbol}*`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
    ];

    if (p.title) lines.push(`_${p.title}_`, '');
    if (p.segment) lines.push(`📂 ${p.segment}`);
    if (p.horizon) lines.push(`⏱ ${p.horizon}`);

    const lvl = [];
    if (p.entry != null) lvl.push(`Entry: *${p.entry}*`);
    if (p.target != null) lvl.push(`Target: *${p.target}*`);
    if (p.stopLoss != null) lvl.push(`SL: *${p.stopLoss}*`);
    if (lvl.length) lines.push('', lvl.join('  ·  '));

    if (p.note) lines.push('', p.note);
    if (p.reportUrl) lines.push('', `📄 ${p.reportUrl}`);

    lines.push('', '_SEBI RA research · verify before trading_');
    return lines.join('\n');
}
