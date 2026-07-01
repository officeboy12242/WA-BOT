/**
 * System prompt for NSE/BSE F&O trade analysis (NVIDIA DeepSeek).
 * Always outputs BOTH CE (Call) and PE (Put) scenario analysis.
 */

export const TRADE_ANALYSIS_SYSTEM_PROMPT = `You are an expert options trader for the Indian stock market (NSE/BSE) specializing in FUTURES & OPTIONS.

Analyze the symbol and provide BOTH sides — CALL (CE) and PUT (PE) — every time. Users need full scenario analysis, not just one leg.

Analyze ALL of the following before deciding:

1. PRICE ACTION — intraday + daily trend; breakouts; support/resistance; volume
2. OPTIONS DATA — Call/Put OI, PCR, COI, unusual strikes, premium momentum
3. VOLATILITY — IV level, spike/crush vs historical
4. MARKET SENTIMENT — NIFTY/BANKNIFTY bias
5. NEWS & FUNDAMENTALS — earnings, results, sector/macro (use LIVE NEWS when provided)
6. RISK — minimum 1:2 risk-reward; liquidity

OUTPUT FORMAT (use exactly these section headers, plain text for WhatsApp):

Stock: <NAME>
Spot Price: <PRICE>

Market Bias: Bullish / Bearish / Sideways

━━━ CALL (CE) SETUP ━━━
Verdict: ✅ BUY CE / ⚠️ WEAK / ❌ AVOID
Confidence: <0–100>%
Strike: <strike + weekly/monthly expiry>
Entry: <approx premium>
Target: <premium target>
Stop Loss: <strict SL>
Why:
• <bullet>
• <bullet>

━━━ PUT (PE) SETUP ━━━
Verdict: ✅ BUY PE / ⚠️ WEAK / ❌ AVOID
Confidence: <0–100>%
Strike: <strike + expiry>
Entry: <approx premium>
Target: <premium target>
Stop Loss: <strict SL>
Why:
• <bullet>
• <bullet>

Primary Pick: ✅ BUY CE / ✅ BUY PE / ❌ NO TRADE
Primary Confidence: <0–100>%

RULES:
• ALWAYS fill both CE and PE sections — even if one side is AVOID
• Primary Pick = best side only if confidence ≥70%; else NO TRADE
• Only mark ✅ BUY CE or ✅ BUY PE when that side's confidence ≥70%
• Use WEAK for 50–69%, AVOID for <50% or poor setup
• Use Indian market context (IST, NSE, liquid strikes)
• Keep bullets short
• Do not mention AI or models
• Spot Price MUST match MANDATORY line exactly when provided
• If no live spot price → Primary Pick: NO TRADE; still give cautious CE/PE notes with AVOID`;

export function buildTradeUserPrompt({
    symbol,
    displayName,
    quoteContext,
    quote,
    newsContext,
    marketBrief,
    mode = 'live',
}) {
    const lines = [
        `Analyze this Indian market symbol for F&O options.`,
        `Provide BOTH CALL (CE) and PUT (PE) scenario analysis.`,
        `Symbol: ${symbol}`,
        `Name: ${displayName || symbol}`,
        `Mode: ${mode === 'daily' ? 'Pre-market daily alert' : 'On-demand analysis'}`,
        `Date context: Indian market (IST), use latest NSE expiries.`,
        '',
    ];

    if (quoteContext) {
        lines.push('=== LIVE PRICE DATA (Yahoo Finance) ===');
        lines.push(quoteContext);
        lines.push('');
    } else {
        lines.push('=== LIVE PRICE DATA ===');
        lines.push('Unavailable — Primary Pick must be NO TRADE. Do NOT guess spot price.');
        lines.push('');
    }

    if (quote?.price != null) {
        const currency = quote.currency || 'INR';
        const pct =
            quote.changePct != null
                ? `, ${quote.changePct >= 0 ? '+' : ''}${quote.changePct}% today`
                : '';
        lines.push('=== MANDATORY OUTPUT (Spot Price) ===');
        lines.push(`Copy this EXACTLY into Spot Price line:`);
        lines.push(`Spot Price: ${quote.price} ${currency}${pct} (live market data)`);
        lines.push('');
    } else {
        lines.push('=== MANDATORY OUTPUT ===');
        lines.push('No live price — Primary Pick: ❌ NO TRADE only.');
        lines.push('');
    }

    if (newsContext) {
        lines.push('=== LIVE NEWS (Google News RSS) ===');
        lines.push(newsContext);
        lines.push('');
    }

    if (marketBrief) {
        lines.push('=== BROADER MARKET CONTEXT ===');
        lines.push(marketBrief);
        lines.push('');
    }

    lines.push('Respond using the required OUTPUT FORMAT with BOTH CE and PE sections.');
    return lines.join('\n');
}

export function wrapTradeAlertMessage(symbol, body, { isDaily = false } = {}) {
    let text = '';
    text += '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n';
    text += isDaily ? '┃  📈 *DAILY TRADE ALERT* 📈  ┃\n' : '┃  📊 *TRADE ANALYSIS* 📊  ┃\n';
    text += '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n';
    if (isDaily) {
        text += `🕐 _Morning scan · ${symbol}_\n\n`;
    }
    text += body.trim();
    text += '\n\n─────────────────────────────\n';
    text += '⚠️ _Not financial advice. For education only. Trade at your own risk._';
    return text;
}
