/**
 * Configuration
 * Centralized configuration management
 */

import dotenv from 'dotenv';

dotenv.config();

function parsePhoneList(value) {
    if (!value) {
        return [];
    }
    return value
        .split(',')
        .map((n) => n.trim().replace(/^\+/, '').replace(/\s/g, ''))
        .filter(Boolean);
}

export const config = {
    WHATSAPP_CHAT_ID: process.env.WHATSAPP_CHAT_ID || '',
    CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 180, // seconds
    NEWS_POST_TIMES: (process.env.NEWS_POST_TIMES || '10:00,22:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    NEWS_TIMEZONE: process.env.NEWS_TIMEZONE || 'Asia/Kolkata',
    NEWS_SCRAPE_INTERVAL: parseInt(process.env.NEWS_SCRAPE_INTERVAL) || 1800, // seconds — queue only, no post
    NEWS_MIN_ARTICLES: parseInt(process.env.NEWS_MIN_ARTICLES) || 10,
    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'telegramUdemy',
    OWNER_NUMBERS: parsePhoneList(process.env.OWNER_NUMBERS),
    MODERATOR_NUMBERS: parsePhoneList(process.env.MODERATOR_NUMBERS),
    MORNING_MESSAGES_ENABLED: process.env.MORNING_MESSAGES_ENABLED !== 'false',
    MORNING_MESSAGE_NUMBERS: parsePhoneList(process.env.MORNING_MESSAGE_NUMBERS),
    MORNING_MESSAGE_TIME_START: (
        process.env.MORNING_MESSAGE_TIME_START ||
        process.env.MORNING_MESSAGE_TIME ||
        '08:00'
    ).trim(),
    MORNING_MESSAGE_TIME_END: (process.env.MORNING_MESSAGE_TIME_END || '10:30').trim(),
    MORNING_TIMEZONE: process.env.MORNING_TIMEZONE || 'Asia/Kolkata',
    STICKER_TARGET_GROUPS: process.env.STICKER_TARGET_GROUPS
        ? process.env.STICKER_TARGET_GROUPS.split(',').map((g) => g.trim()).filter(Boolean)
        : [],
    STICKER_SOURCE_CHANNELS: process.env.STICKER_SOURCE_CHANNELS
        ? process.env.STICKER_SOURCE_CHANNELS.split(',').map((c) => c.trim()).filter(Boolean)
        : [],
    STICKER_PACK_NAME: process.env.STICKER_PACK_NAME?.trim() || '',
    STICKER_PACK_AUTHOR: process.env.STICKER_PACK_AUTHOR?.trim() || '',
    /** Parallel sticker download/send workers (1–8, default 3). */
    STICKER_FORWARD_CONCURRENCY: Math.max(1, Math.min(8, parseInt(process.env.STICKER_FORWARD_CONCURRENCY, 10) || 3)),
    STICKER_INTER_SEND_DELAY_MS: Math.max(50, parseInt(process.env.STICKER_INTER_SEND_DELAY_MS, 10) || 150),
    TMDB_API_KEY: process.env.TMDB_API_KEY?.trim() || '',
    /** HDHub4u movie search API (free-udemy-courses-bot). */
    MOVIES_API_URL: process.env.MOVIES_API_URL?.trim() || 'https://free-udemy-courses-bot.onrender.com/api/movies',
    /** Movie search — HDHub API timeout (ms). */
    MOVIE_HD_TIMEOUT_MS: Math.max(12_000, parseInt(process.env.MOVIE_HD_TIMEOUT_MS, 10) || 28_000),
    /** Movie search — Drive/AtoZ timeout (ms). */
    MOVIE_SECONDARY_TIMEOUT_MS: Math.max(4_000, parseInt(process.env.MOVIE_SECONDARY_TIMEOUT_MS, 10) || 8_000),
    /** Movie search — max ms to shorten links before sending results. */
    MOVIE_SHORTEN_BUDGET_MS: Math.max(5_000, parseInt(process.env.MOVIE_SHORTEN_BUDGET_MS, 10) || 15_000),
    /** In-memory HDHub query dedupe (ms). */
    MOVIE_SEARCH_CACHE_TTL_MS: Math.max(60_000, parseInt(process.env.MOVIE_SEARCH_CACHE_TTL_MS, 10) || 5 * 60_000),
    /** MongoDB vault — skip APIs when a fresh cached search exists. */
    MOVIE_CACHE_ENABLED: process.env.MOVIE_CACHE_ENABLED !== 'false',
    /** Vault considered fresh — serve without calling APIs (default 24h). */
    MOVIE_CACHE_FRESH_MS: Math.max(60_000, parseInt(process.env.MOVIE_CACHE_FRESH_MS, 10) || 24 * 60 * 60 * 1000),
    /** Vault stale grace — serve instantly if APIs fail (default 7d). */
    MOVIE_CACHE_STALE_MS: Math.max(3600_000, parseInt(process.env.MOVIE_CACHE_STALE_MS, 10) || 7 * 24 * 60 * 60 * 1000),
    /** Background refresh vault after this age (default 6h) while still serving cached links. */
    MOVIE_CACHE_REVALIDATE_MS: Math.max(60_000, parseInt(process.env.MOVIE_CACHE_REVALIDATE_MS, 10) || 6 * 60 * 60 * 1000),
    /** Nightly pre-warm top searches into vault (default 3:30 AM IST). */
    MOVIE_CACHE_PREWARM_ENABLED: process.env.MOVIE_CACHE_PREWARM_ENABLED !== 'false',
    MOVIE_CACHE_PREWARM_HOUR: Math.min(23, Math.max(0, parseInt(process.env.MOVIE_CACHE_PREWARM_HOUR, 10) || 3)),
    MOVIE_CACHE_PREWARM_MINUTE: Math.min(59, Math.max(0, parseInt(process.env.MOVIE_CACHE_PREWARM_MINUTE, 10) || 30)),
    MOVIE_CACHE_PREWARM_TOP: Math.max(5, parseInt(process.env.MOVIE_CACHE_PREWARM_TOP, 10) || 20),
    /** Daily group chat recap (/summaryon groups). */
    GROUP_SUMMARY_ENABLED: process.env.GROUP_SUMMARY_ENABLED !== 'false',
    /** When recap is sent — default 00:00 = midnight IST (end of calendar day). */
    GROUP_SUMMARY_TIME: (process.env.GROUP_SUMMARY_TIME || '00:00').trim(),
    GROUP_SUMMARY_TIMEZONE: process.env.GROUP_SUMMARY_TIMEZONE || 'Asia/Kolkata',
    /** Produce a chat-based narrative recap (who said what / themes / decisions) instead of only listing events. */
    GROUP_SUMMARY_NARRATIVE: process.env.GROUP_SUMMARY_NARRATIVE !== 'false',
    /** Min member messages that day before a full recap; below this = short quiet note or skip. */
    GROUP_SUMMARY_MIN_MESSAGES: parseInt(process.env.GROUP_SUMMARY_MIN_MESSAGES, 10) || 3,
    GROUP_SUMMARY_MAX_MESSAGES: parseInt(process.env.GROUP_SUMMARY_MAX_MESSAGES, 10) || 400,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY?.trim() || '',
    /** Group summary / recap model */
    NVIDIA_MODEL: process.env.NVIDIA_MODEL?.trim() || 'deepseek-ai/deepseek-r1',
    /** Trade discovery, research, CE/PE analysis — Gemini (not GLM) */
    GEMINI_TRADE_MODEL: process.env.GEMINI_TRADE_MODEL?.trim() || 'gemini-2.5-flash',
    GEMINI_TRADE_MODELS: process.env.GEMINI_TRADE_MODELS?.trim() || 'gemini-2.5-flash,gemini-2.5-pro,gemini-2.0-flash',
    /** Groq fallback for trade alerts (/tradenow when Gemini rate-limited) */
    GROQ_API_KEY: process.env.GROQ_API_KEY?.trim() || '',
    GROQ_TRADE_MODEL: process.env.GROQ_TRADE_MODEL?.trim() || 'llama-3.3-70b-versatile',
    GROQ_TRADE_MODELS: process.env.GROQ_TRADE_MODELS?.trim() || 'llama-3.3-70b-versatile,llama-3.1-8b-instant',
    /** Provider order: gemini,groq,nvidia */
    TRADE_LLM_PROVIDERS: (process.env.TRADE_LLM_PROVIDERS || 'gemini,groq,nvidia').trim(),
    /** @deprecated Trade alerts use Gemini; kept for group summaries only */
    NVIDIA_TRADE_MODEL: process.env.NVIDIA_TRADE_MODEL?.trim() || 'z-ai/glm-5.2',
    /** Summary self-heal model (code fix proposals) */
    NVIDIA_HEAL_MODEL: process.env.NVIDIA_HEAL_MODEL?.trim() || 'nvidia/nemotron-3-ultra-550b-a55b',
    /** Try Nemotron first (often 503); default false = GLM → DeepSeek → Nemotron */
    NVIDIA_HEAL_PREFER_NEMOTRON: process.env.NVIDIA_HEAL_PREFER_NEMOTRON === 'true',
    /** Google Gemini API key — preferred for /fix heal (better JSON + replacements) */
    GEMINI_API_KEY: process.env.GEMINI_API_KEY?.trim() || '',
    /** Primary Gemini model for heal (comma-separated chain in GEMINI_HEAL_MODELS) */
    GEMINI_HEAL_MODEL: process.env.GEMINI_HEAL_MODEL?.trim() || 'gemini-2.5-flash',
    GEMINI_HEAL_MODELS: process.env.GEMINI_HEAL_MODELS?.trim() || 'gemini-2.5-flash,gemini-2.5-pro,gemini-2.0-flash',
    /** Owner DM assistant — replies as ASSIST_OWNER_NAME in personal chats when /assist on */
    ASSIST_OWNER_NAME: process.env.ASSIST_OWNER_NAME?.trim() || 'Jacky',
    ASSIST_GEMINI_MODEL: process.env.ASSIST_GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    ASSIST_GEMINI_MODELS: process.env.ASSIST_GEMINI_MODELS?.trim() || 'gemini-2.5-flash,gemini-2.0-flash,gemini-2.5-pro',
    /** Assist fallback — Groq / NVIDIA (same keys as trade) */
    ASSIST_GROQ_MODEL: process.env.ASSIST_GROQ_MODEL?.trim() || 'llama-3.1-8b-instant',
    ASSIST_GROQ_MODELS: process.env.ASSIST_GROQ_MODELS?.trim() || 'llama-3.1-8b-instant,llama-3.3-70b-versatile',
    ASSIST_NVIDIA_MODEL: process.env.ASSIST_NVIDIA_MODEL?.trim() || '',
    ASSIST_NVIDIA_MODELS: process.env.ASSIST_NVIDIA_MODELS?.trim() || '',
    /** Provider order for /assist DMs: gemini,groq,nvidia */
    ASSIST_LLM_PROVIDERS: (process.env.ASSIST_LLM_PROVIDERS || process.env.TRADE_LLM_PROVIDERS || 'gemini,groq,nvidia').trim(),
    ASSIST_MAX_HISTORY: Math.max(4, parseInt(process.env.ASSIST_MAX_HISTORY, 10) || 12),
    ASSIST_REPLY_COOLDOWN_MS: Math.max(1500, parseInt(process.env.ASSIST_REPLY_COOLDOWN_MS, 10) || 3500),
    ASSIST_TIMEOUT_MS: Math.min(60_000, Math.max(15_000, parseInt(process.env.ASSIST_TIMEOUT_MS, 10) || 45_000)),
    /** Auto-propose summary code fixes (owner must approve push) */
    SUMMARY_SELF_HEAL_ENABLED: process.env.SUMMARY_SELF_HEAL_ENABLED === 'true',
    /** Auto-propose /horo fixes when all horoscope APIs fail (owner must approve push) */
    HOROSCOPE_SELF_HEAL_ENABLED: process.env.HOROSCOPE_SELF_HEAL_ENABLED !== 'false',
    /** GitHub PAT with contents:write for self-heal push */
    GITHUB_TOKEN: process.env.GITHUB_TOKEN?.trim() || '',
    GITHUB_REPO: process.env.GITHUB_REPO?.trim() || 'officeboy12242/WA-BOT',
    GITHUB_BRANCH: process.env.GITHUB_BRANCH?.trim() || 'main',
    /** WhatsApp notify number for heal status (default logs number) */
    SUMMARY_SELF_HEAL_NOTIFY: process.env.SUMMARY_SELF_HEAL_NOTIFY?.trim() || '917887499710',
    NVIDIA_API_BASE_URL: process.env.NVIDIA_API_BASE_URL?.trim() || 'https://integrate.api.nvidia.com/v1/chat/completions',
    /** Capped at 120s — avoid huge env values (e.g. 900000) that hang recaps. */
    NVIDIA_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.NVIDIA_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 60_000;
        return Math.min(120_000, Math.max(20_000, n));
    })(),
    /** Max chat lines sent to the LLM per recap (rest are sampled). */
    GROUP_SUMMARY_LLM_MAX_MESSAGES: parseInt(process.env.GROUP_SUMMARY_LLM_MAX_MESSAGES, 10) || 100,
    /** Use map-reduce summarization when a day exceeds this many logged messages. */
    GROUP_SUMMARY_CHUNK_THRESHOLD: parseInt(process.env.GROUP_SUMMARY_CHUNK_THRESHOLD, 10) || 150,
    /** Messages per chunk when map-reduce is used. */
    GROUP_SUMMARY_CHUNK_SIZE: parseInt(process.env.GROUP_SUMMARY_CHUNK_SIZE, 10) || 50,
    /** LLM timeout for group recap (defaults to max(90s, NVIDIA_TIMEOUT_MS)). */
    GROUP_SUMMARY_LLM_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.GROUP_SUMMARY_LLM_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.min(120_000, Math.max(30_000, n));
    })(),
    /** Daily F&O trade alerts (/tradelert on groups). */
    TRADE_ALERT_ENABLED: process.env.TRADE_ALERT_ENABLED !== 'false',
    /** Pre-market scan time IST — default 09:20. */
    TRADE_ALERT_TIME: (process.env.TRADE_ALERT_TIME || '09:20').trim(),
    TRADE_ALERT_TIMEZONE: process.env.TRADE_ALERT_TIMEZONE || 'Asia/Kolkata',
    /** Default watchlist when group has no /tradelert stocks set. */
    TRADE_ALERT_STOCKS: (process.env.TRADE_ALERT_STOCKS || 'NIFTY,BANKNIFTY,RELIANCE,TCS')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    /** auto = AI picks stocks from live news/movers; manual = fixed watchlist */
    TRADE_ALERT_MODE: (process.env.TRADE_ALERT_MODE || 'auto').trim().toLowerCase() === 'manual' ? 'manual' : 'auto',
    /** Daily alerts: only post BUY CALL/PUT when confidence ≥ 70% */
    TRADE_ALERT_ONLY_BUY_SIGNALS: process.env.TRADE_ALERT_ONLY_BUY_SIGNALS !== 'false',
    /** Max actionable alerts per group per day */
    TRADE_ALERT_MAX_SENDS: Math.max(1, parseInt(process.env.TRADE_ALERT_MAX_SENDS, 10) || 5),
    /** How many symbols AI discovery picks to scan */
    TRADE_ALERT_DISCOVERY_COUNT: Math.max(8, Math.min(15, parseInt(process.env.TRADE_ALERT_DISCOVERY_COUNT, 10) || 10)),
    /** Strict confluence floor (0–100) for high-quality daily posts */
    TRADE_ALERT_MIN_CONFLUENCE: Math.max(25, Math.min(80, parseInt(process.env.TRADE_ALERT_MIN_CONFLUENCE, 10) || 40)),
    /** If no strict posts, still send daily AI≥70% picks with softer confluence */
    TRADE_ALERT_DAILY_SOFT_FALLBACK: process.env.TRADE_ALERT_DAILY_SOFT_FALLBACK !== 'false',
    /** Soft confluence floor used only when filling empty daily alert days */
    TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE: Math.max(
        0,
        Math.min(50, parseInt(process.env.TRADE_ALERT_DAILY_SOFT_MIN_CONFLUENCE, 10) || 25)
    ),
    /** Step-1 AI research brief before CE/PE trade analysis */
    TRADE_TWO_STEP_RESEARCH: process.env.TRADE_TWO_STEP_RESEARCH !== 'false',
    /** Skip daily trade alerts on NSE holidays and weekends (IST) */
    TRADE_ALERT_SKIP_NON_TRADING_DAYS: process.env.TRADE_ALERT_SKIP_NON_TRADING_DAYS !== 'false',
    TRADE_ALERT_SKIP_WEEKENDS: process.env.TRADE_ALERT_SKIP_WEEKENDS !== 'false',
    /** Extra closed dates YYYY-MM-DD, comma-separated */
    TRADE_ALERT_EXTRA_HOLIDAYS: (process.env.TRADE_ALERT_EXTRA_HOLIDAYS || '').trim(),
    /** Force run on specific dates (e.g. budget Sunday) YYYY-MM-DD, comma-separated */
    TRADE_ALERT_FORCE_TRADING_DAYS: (process.env.TRADE_ALERT_FORCE_TRADING_DAYS || '').trim(),
    /** Job hunt (TinyFish discover + LLM score → WhatsApp digest). */
    JOB_HUNT_ENABLED: process.env.JOB_HUNT_ENABLED !== 'false',
    JOB_HUNT_TIME: (process.env.JOB_HUNT_TIME || '02:30').trim(),
    JOB_HUNT_TIMEZONE: process.env.JOB_HUNT_TIMEZONE || 'Asia/Kolkata',
    JOB_HUNT_OWNER_DM: process.env.JOB_HUNT_OWNER_DM !== 'false',
    JOB_HUNT_MIN_SCORE: Math.max(0, Math.min(100, parseInt(process.env.JOB_HUNT_MIN_SCORE, 10) || 60)),
    JOB_HUNT_TOP_N: Math.max(1, Math.min(20, parseInt(process.env.JOB_HUNT_TOP_N, 10) || 5)),
    JOB_HUNT_MAX_COMPANIES: (() => {
        const n = parseInt(process.env.JOB_HUNT_MAX_COMPANIES, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    JOB_HUNT_FETCH_DELAY_MS: Math.max(500, parseInt(process.env.JOB_HUNT_FETCH_DELAY_MS, 10) || 2500),
    JOB_HUNT_SEARCH_DELAY_MS: Math.max(2000, parseInt(process.env.JOB_HUNT_SEARCH_DELAY_MS, 10) || 13000),
    TINYFISH_API_KEY: process.env.TINYFISH_API_KEY?.trim() || '',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY?.trim() || '',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL?.trim() || 'meta-llama/llama-3.3-70b-instruct:free',
    OPENROUTER_FALLBACK_MODELS: (process.env.OPENROUTER_FALLBACK_MODELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    OPENROUTER_JOB_MODELS: (process.env.OPENROUTER_JOB_MODELS || '').trim(),
    JOB_HUNT_GEMINI_MODELS: (process.env.JOB_HUNT_GEMINI_MODELS || '').trim(),
    JOB_HUNT_GROQ_MODELS: (process.env.JOB_HUNT_GROQ_MODELS || '').trim(),
    JOB_HUNT_CANDIDATE_NAME: (process.env.JOB_HUNT_CANDIDATE_NAME || '').trim(),
    JOB_HUNT_PROFILE: (process.env.JOB_HUNT_PROFILE || '').trim(),
    JOB_HUNT_SEEKING: (process.env.JOB_HUNT_SEEKING || '').trim(),
    JOB_HUNT_NOT_SUITABLE: (process.env.JOB_HUNT_NOT_SUITABLE || '').trim(),
    JOB_HUNT_SEARCH_SENIORITY: (process.env.JOB_HUNT_SEARCH_SENIORITY || '').trim(),
    JOB_HUNT_SEARCH_KEYWORDS: (process.env.JOB_HUNT_SEARCH_KEYWORDS || '').trim(),
    JOB_HUNT_RELOCATION_NOTE: (process.env.JOB_HUNT_RELOCATION_NOTE || '').trim(),
    JOB_HUNT_RESUME: (process.env.JOB_HUNT_RESUME || '').trim(),
    /** Multi-target trade plan on CE/PE sections (1 lot, ₹ P&L) */
    TRADE_PLAN_ENABLED: process.env.TRADE_PLAN_ENABLED !== 'false',
    /** Partial booking % at T1,T2,T3 e.g. 50,30,20 */
    TRADE_PLAN_PARTIALS: (process.env.TRADE_PLAN_PARTIALS || '50,30,20')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0),
    /** NVIDIA timeout for trade analysis step (max 180s) */
    TRADE_ANALYSIS_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.TRADE_ANALYSIS_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 150_000;
        return Math.min(180_000, Math.max(60_000, n));
    })(),
    /** Step-1 research brief timeout (ms) */
    TRADE_RESEARCH_TIMEOUT_MS: (() => {
        const n = parseInt(process.env.TRADE_RESEARCH_TIMEOUT_MS, 10);
        if (!Number.isFinite(n) || n <= 0) return 55_000;
        return Math.min(90_000, Math.max(30_000, n));
    })(),
    BOT_LOG_NUMBER: process.env.BOT_LOG_NUMBER?.trim() || '',
    GITHUB_TRENDING_ENABLED: process.env.GITHUB_TRENDING_ENABLED !== 'false',
    GITHUB_TRENDING_TIMES: (process.env.GITHUB_TRENDING_TIMES || '09:00,11:30,14:00,16:30,19:00')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    GITHUB_TRENDING_TIMEZONE: process.env.GITHUB_TRENDING_TIMEZONE || 'Asia/Kolkata',
    GITHUB_TRENDING_COUNT: parseInt(process.env.GITHUB_TRENDING_COUNT, 10) || 5,
    /** Public URL for short links (Render sets RENDER_EXTERNAL_URL automatically). */
    PUBLIC_URL: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
    RENDER_API_KEY: process.env.RENDER_API_KEY?.trim() || '',
    RENDER_SERVICE_ID: process.env.RENDER_SERVICE_ID?.trim() || '',
    /** Optional bootstrap for drive sources: JSON array of { url, renderServiceId?, renderApiKey? } */
    DRIVE_SOURCES: (() => {
        try {
            const raw = process.env.DRIVE_SOURCES_JSON?.trim();
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    })(),
};
