/**
 * System prompt for AI-powered option chain deep analysis (DeepSeek V4 Flash).
 *
 * Goes beyond the deterministic rules in IndexAnalysisService — the LLM
 * interprets complex patterns: IV skew, unusual OI clusters, PCR anomalies,
 * strike-wise volume spikes, and synthesizes them into a coherent strategy.
 */

export const CHAIN_AI_SYSTEM_PROMPT = `You are an expert Indian F&O market microstructure analyst specializing in NSE/BSE option chains.

You analyze live option chain snapshots and provide deep, actionable insights that go beyond simple PCR readings.

Analyze ALL of the following from the provided chain data:

1. PCR INTERPRETATION — not just the number, but what it means in context:
   - Is PCR diverging from recent norms?
   - What does the CE/PE OI distribution suggest about market positioning?

2. IV SKEW ANALYSIS — compare IV across strikes:
   - Is there a skew toward puts (fear) or calls (greed)?
   - Are OTM options priced aggressively vs ATM?
   - Any IV crush or IV spike patterns?

3. OI WALL ANALYSIS — beyond just "top strikes":
   - Where are the REAL support/resistance walls?
   - How far is spot from each wall?
   - Are walls shifting (new OI building vs unwinding)?

4. UNUSUAL ACTIVITY — flag anything anomalous:
   - Strikes with disproportionate volume vs OI
   - Large OI changes (COI) at specific strikes
   - CE vs PE volume imbalance at key strikes

5. MAX PAIN DRIFT — where is max pain relative to spot?
   - Is the market being "pulled" toward max pain?
   - How far is spot from max pain?

6. MARKET REGIME — based on all the above:
   - Is the market positioning for a range or breakout?
   - Is there a directional bias?
   - What expiry dynamics are at play?

OUTPUT FORMAT (plain text for WhatsApp):

━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠 *OPTION CHAIN AI ANALYSIS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 *<SYMBOL>* · Spot: ₹<spot> · Expiry: <date>

┌─ *PCR & SENTIMENT* ─
│ PCR: <value> — <interpretation>
│ What it means: <1-2 line insight>
└─────────────────────────

┌─ *IV SKEW* ─
│ ATM IV: CE <x>% / PE <x>%
│ Skew direction: <put-skewed / call-skewed / flat>
│ <insight about what the skew means>
└─────────────────────────

┌─ *OI WALLS* ─
│ 🔴 Resistance: <strike> (OI: <value>, <distance> from spot)
│ 🟢 Support: <strike> (OI: <value>, <distance> from spot)
│ <insight about wall strength/shifts>
└─────────────────────────

┌─ *UNUSUAL ACTIVITY* ─
│ <flag any anomalous OI/volume patterns>
│ <explain what it might indicate>
└─────────────────────────

┌─ *MAX PAIN* ─
│ Max pain: <level> (<distance> from spot)
│ <drift tendency insight>
└─────────────────────────

┌─ *TRADE SETUP* ─
│ 📌 Recommendation: <BUY CE / BUY PE / STRADDLE / SPREAD / NO TRADE>
│ Option: <strike> <CE/PE> @ ₹<current LTP premium>
│ Entry: ₹<entry premium> (limit order at this premium)
│ Target 1: ₹<t1 premium> (<x%> gain) — exit 50% qty
│ Target 2: ₹<t2 premium> (<x%> gain) — exit remaining
│ Stop Loss: ₹<sl premium> (<x%> loss) — strict
│ Max Risk/Lot: ₹<sl × lot size> (1 lot = <lot size> qty)
│ Expected Profit/Lot: ₹<t1 × lot size> (conservative)
│ R:R Ratio: <x>:1
│ Conviction: <HIGH / MEDIUM / LOW>
│ Why this trade: <1-2 line reasoning based on OI walls, IV, PCR, support/resistance>
└─────────────────────────

┌─ *VERDICT* ─
│ Market regime: <range / breakout-pending / trending>
│ Directional lean: <bullish / bearish / neutral>
│ Confidence: <0-100>%
│ Key strikes to watch: <list>
└─────────────────────────

━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULES:
• CRITICAL: Always provide a TRADE SETUP with specific entry premium, target, SL, and lot size.
• Use ACTUAL premium prices from the chain data — do not make up numbers.
• If no good setup exists, say NO TRADE with reasoning.
• Entry premium should be close to current LTP (within 5-10%).
• Target should be realistic based on support/resistance levels and max pain.
• Stop loss should be 20-40% below entry (not too tight, not too loose).
• R:R ratio must be at least 1.5:1 to recommend a trade.
• Be specific — cite actual numbers from the chain data
• Flag when data is thin or market is illiquid
• Distinguish between measured observations and inferences
• Keep it concise — WhatsApp message, not a research report
• Do not mention AI or models
• Use ₹ symbol for all prices
• If any data point is missing, note it rather than guessing
• Lot size for NIFTY is 25, BANKNIFTY is 15, FINNIFTY is 40, MIDCPNIFTY is 75
• For equities, lot size varies — use the strike's lot if known, else note it`;

/**
 * Build user prompt with option chain snapshot + market data.
 * @param {object} snapshot - from NseOptionChainService
 * @param {object} [quote] - from IndianStockQuoteService
 * @param {object} [chainMeta] - max pain, walls, etc. from IndexAnalysisService
 * @returns {string}
 */
export function buildChainAiUserPrompt(snapshot, quote, chainMeta) {
    const lines = [
        'Analyze this live NSE option chain and provide deep microstructure insights.',
        '',
    ];

    if (snapshot) {
        lines.push('=== OPTION CHAIN SNAPSHOT ===');
        lines.push(`Symbol: ${snapshot.symbol} (${snapshot.type})`);
        lines.push(`Expiry: ${snapshot.expiry}`);
        lines.push(`Spot/Underlying: ${snapshot.spot}`);
        lines.push(`PCR: ${snapshot.pcr?.toFixed(3)}`);
        lines.push(`Total CE OI: ${snapshot.totalCeOi?.toLocaleString('en-IN')}`);
        lines.push(`Total PE OI: ${snapshot.totalPeOi?.toLocaleString('en-IN')}`);
        lines.push('');

        if (snapshot.atmStrike) {
            lines.push(`ATM Strike: ${snapshot.atmStrike}`);
            if (snapshot.atmCe) {
                lines.push(`ATM CE: LTP ₹${snapshot.atmCe.ltp}, OI ${snapshot.atmCe.oi}, IV ${snapshot.atmCe.iv}%, COI ${snapshot.atmCe.changeOi}`);
            }
            if (snapshot.atmPe) {
                lines.push(`ATM PE: LTP ₹${snapshot.atmPe.ltp}, OI ${snapshot.atmPe.oi}, IV ${snapshot.atmPe.iv}%, COI ${snapshot.atmPe.changeOi}`);
            }
            lines.push('');
        }

        if (snapshot.topCe?.length) {
            lines.push('Top CE OI strikes:');
            for (const r of snapshot.topCe.slice(0, 7)) {
                lines.push(`  CE ${r.strike}: OI ${r.oi?.toLocaleString('en-IN')}, COI ${r.changeOi}, IV ${r.iv}%, LTP ₹${r.ltp}`);
            }
            lines.push('');
        }

        if (snapshot.topPe?.length) {
            lines.push('Top PE OI strikes:');
            for (const r of snapshot.topPe.slice(0, 7)) {
                lines.push(`  PE ${r.strike}: OI ${r.oi?.toLocaleString('en-IN')}, COI ${r.changeOi}, IV ${r.iv}%, LTP ₹${r.ltp}`);
            }
            lines.push('');
        }

        if (snapshot.strikes?.length && snapshot.atmStrike) {
            const atmIdx = snapshot.strikes.findIndex((s) => s.strike === snapshot.atmStrike);
            if (atmIdx >= 0) {
                const start = Math.max(0, atmIdx - 5);
                const end = Math.min(snapshot.strikes.length, atmIdx + 6);
                const nearby = snapshot.strikes.slice(start, end);
                lines.push('Strike-wise data (±5 from ATM):');
                for (const s of nearby) {
                    const ce = s.ce ? `CE: IV=${s.ce.iv}% OI=${s.ce.oi} LTP=₹${s.ce.ltp}` : 'CE: –';
                    const pe = s.pe ? `PE: IV=${s.pe.iv}% OI=${s.pe.oi} LTP=₹${s.pe.ltp}` : 'PE: –';
                    const marker = s.strike === snapshot.atmStrike ? ' ← ATM' : '';
                    lines.push(`  ${s.strike}:${marker}`);
                    lines.push(`    ${ce}`);
                    lines.push(`    ${pe}`);
                }
                lines.push('');
            }
        }
    }

    if (quote) {
        lines.push('=== MARKET DATA ===');
        lines.push(`Price: ₹${quote.price} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct}%)`);
        lines.push(`Day range: ₹${quote.low} – ₹${quote.high}`);
        lines.push(`Volume: ${quote.volume?.toLocaleString('en-IN')}`);
        lines.push('');
    }

    if (chainMeta) {
        lines.push('=== CHAIN METADATA ===');
        if (chainMeta.maxPain != null) lines.push(`Max Pain: ${chainMeta.maxPain}`);
        if (chainMeta.walls?.resistance) {
            lines.push(`Call wall: ${chainMeta.walls.resistance.strike} (OI: ${chainMeta.walls.resistance.oi?.toLocaleString('en-IN')})`);
        }
        if (chainMeta.walls?.support) {
            lines.push(`Put wall: ${chainMeta.walls.support.strike} (OI: ${chainMeta.walls.support.oi?.toLocaleString('en-IN')})`);
        }
        if (chainMeta.pcrLabel) lines.push(`PCR interpretation: ${chainMeta.pcrLabel}`);
        lines.push('');
    }

    const LOT_SIZES = { NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 40, MIDCPNIFTY: 75 };
    const lotSize = LOT_SIZES[snapshot?.symbol?.toUpperCase()] || null;
    if (lotSize) lines.push(`Lot size for ${snapshot.symbol}: ${lotSize} qty per lot`);
    lines.push('');
    lines.push('CRITICAL: Include a TRADE SETUP with specific entry premium (from the actual LTP data), target 1, target 2, stop loss, R:R ratio, and expected profit per lot. If no trade setup is viable, explicitly say NO TRADE with reasoning.');
    lines.push('Respond with the full OPTION CHAIN AI ANALYSIS using the required OUTPUT FORMAT.');
    return lines.join('\n');
}

/**
 * Format the LLM response for WhatsApp delivery.
 * @param {string} text - raw LLM output
 * @returns {string}
 */
export function formatChainAiAnalysis(text) {
    if (!text) return '⚠️ No analysis generated';
    return text.trim();
}
