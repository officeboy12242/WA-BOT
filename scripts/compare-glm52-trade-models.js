/**
 * Compare DeepSeek V4 Flash vs z-ai/glm-5.2 on trade prompts (no code changes).
 * Usage: node scripts/compare-glm52-trade-models.js
 */
import 'dotenv/config';
import axios from 'axios';
import { STOCK_DISCOVERY_SYSTEM_PROMPT, buildDiscoveryUserPrompt } from '../src/prompts/stockDiscoveryPrompt.js';
import { TRADE_ANALYSIS_SYSTEM_PROMPT, buildTradeUserPrompt } from '../src/prompts/tradeAnalysisPrompt.js';
import { parseTradeSignal, parseDiscoveryResult } from '../src/utils/tradeSignalParser.js';

const API_KEY = process.env.NVIDIA_API_KEY?.trim();
const BASE_URL = process.env.NVIDIA_API_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1/chat/completions';

const MODELS = {
    current: process.env.NVIDIA_MODEL?.trim() || 'deepseek-ai/deepseek-v4-flash',
    glm52: 'z-ai/glm-5.2',
};

const MOCK_SNAPSHOT = `=== INDICES ===
[NIFTY] NIFTY 50: 24850.30 INR, +0.42%
[BANKNIFTY] NIFTY Bank: 52100.15 INR, +0.38%

=== TOP GAINERS (% change today) ===
TRENT (Trent Ltd): 4850 INR, +2.8%
BEL (Bharat Electronics): 312 INR, +2.1%
VEDL (Vedanta): 445 INR, +1.9%
COALINDIA (Coal India): 428 INR, +1.6%
HINDALCO (Hindalco): 680 INR, +1.4%

=== TOP LOSERS (% change today) ===
TATASTEEL (Tata Steel): 142 INR, -1.8%
BPCL (BPCL): 298 INR, -1.5%
GRASIM (Grasim): 2450 INR, -1.2%

=== LIVE MARKET NEWS (Google News RSS) ===
- Trent Ltd Q1 preview: analysts expect strong same-store sales growth
- BEL wins ₹1,200 crore defence order; stock in focus
- Vedanta board meeting on dividend; metal stocks mixed
- Nifty holds 24800 support ahead of RBI commentary`;

const MOCK_TRADE_INTEL = {
    symbol: 'TRENT',
    displayName: 'Trent Ltd',
    quoteContext: 'TRENT · Trent Ltd\nSpot: ₹4850.00 · +2.8% · Vol: 1.2M',
    quote: { symbol: 'TRENT', price: 4850, changePct: 2.8, volume: 1200000 },
    newsContext: '• Trent Q1 preview: strong SSS growth expected\n• Retail sector seeing institutional buying',
    optionsNewsContext: '• Trent 4800 CE OI building; weekly expiry Friday',
    optionChainContext: `TRENT spot ~4850
PCR: 0.92 | ATM IV ~28%
Top CE OI: 4900 (1.2L), 5000 (98K) | COI +12K on 4900 CE
Top PE OI: 4800 (85K), 4700 (72K) | COI +8K on 4800 PE
Suggested: 4900 CE weekly premium ~₹85-95`,
    researchBrief: 'Bullish retail momentum; 4850 breakout on volume. CE favoured if Nifty stable. Risk: profit booking after 3-day rally.',
    marketBrief: null,
    mode: 'live',
};

async function callModel(model, systemPrompt, userPrompt, { maxTokens = 1200, timeoutMs = 120000 } = {}) {
    const started = Date.now();
    const body = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.35,
        max_tokens: maxTokens,
        stream: false,
    };

    // DeepSeek uses thinking flag; GLM may ignore unknown fields
    if (model.includes('deepseek')) {
        body.chat_template_kwargs = { thinking: false };
    }

    const { data } = await axios.post(BASE_URL, body, {
        timeout: timeoutMs,
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
        },
    });

    const content = data?.choices?.[0]?.message?.content?.trim() || '';
    return {
        content,
        ms: Date.now() - started,
        usage: data?.usage || null,
    };
}

function section(title) {
    console.log('\n' + '='.repeat(72));
    console.log(title);
    console.log('='.repeat(72));
}

async function runDiscoveryTest(model) {
    const userPrompt = buildDiscoveryUserPrompt(MOCK_SNAPSHOT, 10);
    const result = await callModel(model, STOCK_DISCOVERY_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 900,
        timeoutMs: 90000,
    });
    const parsed = parseDiscoveryResult(result.content);
    return { ...result, parsed };
}

async function runAnalysisTest(model) {
    const userPrompt = buildTradeUserPrompt(MOCK_TRADE_INTEL);
    const result = await callModel(model, TRADE_ANALYSIS_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 2200,
        timeoutMs: 150000,
    });
    const signal = parseTradeSignal(result.content);
    return { ...result, signal };
}

async function main() {
    if (!API_KEY) {
        console.error('NVIDIA_API_KEY missing in .env');
        process.exit(1);
    }

    console.log('Trade model comparison');
    console.log(`Current: ${MODELS.current}`);
    console.log(`Candidate: ${MODELS.glm52}`);
    console.log(`Endpoint: ${BASE_URL}`);

    const results = {};

    for (const [label, model] of Object.entries(MODELS)) {
        section(`DISCOVERY — ${label.toUpperCase()} (${model})`);
        try {
            const d = await runDiscoveryTest(model);
            results[`${label}_discovery`] = d;
            console.log(`Time: ${(d.ms / 1000).toFixed(1)}s`);
            if (d.usage) console.log('Tokens:', JSON.stringify(d.usage));
            console.log('Parsed:', JSON.stringify(d.parsed, null, 2));
            console.log('\n--- Raw (first 1200 chars) ---\n');
            console.log(d.content.slice(0, 1200));
        } catch (err) {
            console.error('FAILED:', err.response?.data?.detail || err.response?.data || err.message);
            results[`${label}_discovery`] = { error: String(err.response?.data?.detail || err.message) };
        }
    }

    for (const [label, model] of Object.entries(MODELS)) {
        section(`TRADE ANALYSIS — ${label.toUpperCase()} (${model})`);
        try {
            const a = await runAnalysisTest(model);
            results[`${label}_analysis`] = a;
            console.log(`Time: ${(a.ms / 1000).toFixed(1)}s`);
            if (a.usage) console.log('Tokens:', JSON.stringify(a.usage));
            console.log('Signal:', JSON.stringify(a.signal, null, 2));
            console.log('\n--- Full output ---\n');
            console.log(a.content);
        } catch (err) {
            console.error('FAILED:', err.response?.data?.detail || err.response?.data || err.message);
            results[`${label}_analysis`] = { error: String(err.response?.data?.detail || err.message) };
        }
    }

    section('SUMMARY');
    for (const key of Object.keys(results)) {
        const r = results[key];
        if (r.error) {
            console.log(`${key}: ERROR — ${r.error}`);
        } else {
            console.log(`${key}: OK in ${(r.ms / 1000).toFixed(1)}s`);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
