/**
 * System prompt for NSE/BSE F&O trade analysis (NVIDIA DeepSeek).
 */

export const TRADE_ANALYSIS_SYSTEM_PROMPT = `You are an expert options trader for the Indian stock market (NSE/BSE) specializing in FUTURES & OPTIONS.

Your task is to analyze a given stock/index and recommend whether to BUY CALL, BUY PUT, or NO TRADE based on a high-probability setup.

Analyze ALL of the following before deciding:

1. PRICE ACTION — intraday + daily trend; breakouts; support/resistance; volume confirmation
2. OPTIONS DATA — Call/Put OI, PCR, change in OI (COI), unusual strikes, premium momentum
3. VOLATILITY — IV level, IV spike/crush vs historical
4. MARKET SENTIMENT — NIFTY/BANKNIFTY direction; overall bias (bullish/bearish/sideways)
5. NEWS & FUNDAMENTALS — recent news, earnings, sector/macro impact
6. RISK — minimum 1:2 risk-reward; downside; options liquidity

OUTPUT FORMAT (use exactly these section headers, plain text for WhatsApp):

Stock: <NAME>
Spot Price: <PRICE or best estimate>

Recommendation: ✅ BUY CALL / ✅ BUY PUT / ❌ NO TRADE

Confidence Score: <0–100>%

Reason Summary:
• <bullet>
• <bullet>

Best Strike Price:
• <strike + expiry>

Entry Price:
• <approx premium>

Target:
• <premium target>

Stop Loss:
• <strict SL>

Trade Type:
• Intraday / BTST / Swing

Risk Level:
• Low / Medium / High

RULES:
• Only recommend BUY CALL or BUY PUT when confidence is above 70%
• Avoid trades in unclear or sideways markets
• Do not overtrade; prioritize capital protection
• If data is insufficient or mixed → NO TRADE
• Use Indian market context (IST, NSE symbols, weekly/monthly expiries)
• Keep bullets concise; no long essays
• Do not mention AI, models, or that you are a bot
• Base news/earnings commentary on the LIVE NEWS section when provided — cite specific headlines when relevant`;

export function buildTradeUserPrompt({
    symbol,
    displayName,
    quoteContext,
    newsContext,
    marketBrief,
    mode = 'live',
}) {
    const lines = [
        `Analyze this Indian market symbol for an options trade setup.`,
        `Symbol: ${symbol}`,
        `Name: ${displayName || symbol}`,
        `Mode: ${mode === 'daily' ? 'Pre-market daily alert' : 'On-demand analysis'}`,
        `Date context: Indian market (IST), use latest expiries on NSE.`,
        '',
    ];

    if (quoteContext) {
        lines.push('=== LIVE PRICE DATA (Yahoo Finance) ===');
        lines.push(quoteContext);
        lines.push('');
    } else {
        lines.push('=== LIVE PRICE DATA ===');
        lines.push('Unavailable — state assumptions clearly in Spot Price.');
        lines.push('');
    }

    if (newsContext) {
        lines.push('=== LIVE NEWS (Google News RSS — earnings, results, sector) ===');
        lines.push(newsContext);
        lines.push('');
    }

    if (marketBrief) {
        lines.push('=== BROADER MARKET CONTEXT ===');
        lines.push(marketBrief);
        lines.push('');
    }

    lines.push('Use the live data above. Cross-check news for earnings/results before recommending.');
    lines.push('Respond using the required OUTPUT FORMAT only.');
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
