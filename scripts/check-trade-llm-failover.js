/**
 * Self-check: trade LLM router escalates on rate limit and cools the burned provider.
 * Run: node scripts/check-trade-llm-failover.js
 */
import assert from 'assert';
import TradeLlmRouterService, { isTradeLlmRateLimitError } from '../src/services/TradeLlmRouterService.js';

const rl = new Error('Gemini rate limit — switching provider');
rl.isRateLimit = true;
assert.equal(isTradeLlmRateLimitError(rl), true);

class FakeSvc {
    constructor(name, behavior) {
        this.name = name;
        this.behavior = behavior;
        this.calls = 0;
    }
    isConfigured() {
        return true;
    }
    async completeTradeAnalysis() {
        this.calls += 1;
        return this.behavior(this);
    }
    async completeTrade(...args) {
        return this.completeTradeAnalysis(...args);
    }
}

const router = new TradeLlmRouterService({
    TRADE_LLM_PROVIDERS: 'gemini,groq,nvidia',
    TRADE_LLM_COOLDOWN_MS: 60_000,
    GEMINI_API_KEY: '',
    GROQ_API_KEY: '',
    NVIDIA_API_KEY: '',
    OPENROUTER_API_KEY: '',
});

const gemini = new FakeSvc('gemini', () => {
    const e = new Error('Gemini rate limit — switching provider');
    e.isRateLimit = true;
    throw e;
});
const groq = new FakeSvc('groq', () => 'GROQ_OK');
const nvidia = new FakeSvc('nvidia', () => 'NVIDIA_OK');

router.gemini = gemini;
router.groq = groq;
router.nvidia = nvidia;
router.openrouter = { isConfigured: () => false };
router.providerOrder = ['gemini', 'groq', 'nvidia'];

const first = await router.completeTradeAnalysis('sys', 'user');
assert.equal(first, 'GROQ_OK');
assert.equal(gemini.calls, 1);
assert.equal(groq.calls, 1);
assert.ok((router._cooledUntil.get('gemini') || 0) > Date.now());

const second = await router.completeTradeAnalysis('sys', 'user');
assert.equal(second, 'GROQ_OK');
assert.equal(gemini.calls, 1, 'cooled gemini must be skipped on next call');
assert.equal(groq.calls, 2);

console.log('OK trade LLM failover + cooldown');
