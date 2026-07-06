/**
 * Self-heal: Nemotron proposes code fixes (auto summary issues or owner /fix).
 * Owner must approve before GitHub push.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import GeminiHealService from './GeminiHealService.js';
import { horoscopeService } from './HoroscopeService.js';
import { resolveNotificationJid, normalizePhoneNumber } from '../utils/permissions.js';

const execFileAsync = promisify(execFile);

const DEFAULT_HEAL_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const SUMMARY_ALLOWED_FILES = [
    'src/controllers/GroupSummaryController.js',
    'src/services/GroupChatLogService.js',
    'src/services/NvidiaDeepSeekService.js',
    'src/config/config.js',
];

const HOROSCOPE_ALLOWED_FILES = [
    'src/services/HoroscopeService.js',
    'src/controllers/CommandController.js',
    'src/commands/registry.js',
];

/** Min gap between auto horoscope heal proposals (avoid spam on every /horo) */
const HOROSCOPE_HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** Min gap between auto summary heal proposals */
const SUMMARY_HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const BLOCKED_PATH_PARTS = ['.env', 'node_modules', 'auth_info', 'credentials', '.git'];

/** Hard security: heal agent may ONLY read/update file contents — never delete the repo */
const GITHUB_ALLOWED_METHODS = new Set(['GET', 'PUT']);
const REPO_DELETE_INSTRUCTION_RE =
    /\b(delete|remove|destroy|wipe|drop)\b.{0,40}\b(repo|repository|github|project|codebase|entire\s+code)\b/i;

/** Must-keep symbols per file so /fix cannot gut critical APIs */
const FILE_INTEGRITY_RULES = {
    'src/services/NvidiaDeepSeekService.js': [
        'completeTrade',
        'summarizeGroupChat',
        'completeWithModelFallback',
        'export default',
    ],
    'src/controllers/GroupSummaryController.js': [
        'postSummaryForGroup',
        'postDailySummaries',
        'export default',
    ],
    'src/services/GroupChatLogService.js': [
        'buildPrompt',
        'computeStats',
        'export default',
    ],
    'src/controllers/TradeAlertController.js': [
        'postDailyAlerts',
        'analyzeSymbol',
        'export default',
    ],
    'src/controllers/CommandController.js': [
        'handleCommand',
        'export default',
    ],
    'src/commands/registry.js': [
        'COMMAND_REGISTRY',
        'findCommand',
    ],
    'src/services/SummarySelfHealService.js': [
        'proposeFromInstruction',
        'approveAndPush',
        'export default',
    ],
    'src/services/HoroscopeService.js': [
        'fetchHoroscope',
        'formatMessage',
        'normalizeSign',
        'export default',
    ],
};

const JSON_SHAPE = `{
  "summary": "one-line description of the fix",
  "changelog": ["bullet what changed 1", "bullet what changed 2"],
  "files": [
    {
      "path": "src/path/File.js",
      "replacements": [
        { "old_string": "exact existing code block", "new_string": "replacement code block" }
      ]
    }
  ]
}`;

const SUMMARY_HEAL_SYSTEM_PROMPT = `You are a senior Node.js engineer fixing WhatsApp group SUMMARY/RECAP bugs only.

Return ONLY valid JSON (no markdown fences) in this shape:
${JSON_SHAPE}

RULES:
• Only touch summary/recap reliability (timeouts, empty topics, JSON parse, chunking, prompts).
• path must be one of: ${SUMMARY_ALLOWED_FILES.join(', ')}
• old_string must match the file EXACTLY (unique snippet).
• Max 4 replacements total.
• If no code change is needed, return {"summary":"no change","changelog":[],"files":[]}`;

const INSTRUCTION_HEAL_SYSTEM_PROMPT = `You are an expert coding agent for a WhatsApp bot (Baileys, Node ESM), same quality bar as a senior engineer in Cursor.

The owner gives a natural-language instruction. Implement it COMPLETELY and PROPERLY — not a hack.

Return ONLY valid JSON (no markdown fences) in this shape:
${JSON_SHAPE}

QUALITY RULES (mandatory):
1. Prefer CONFIG / feature flags over deleting logic.
   - Example: disable good-morning → set MORNING_MESSAGES_ENABLED default/check to false in src/config/config.js
     and keep sendDailyMorning implementation intact so it can be re-enabled.
   - NEVER gut a method to only \`return;\` when a flag already exists.
2. Touch ALL related entry points for the feature (controller + scheduler + config + bot wiring if present).
3. Keep changes reversible: owner should turn the feature back on via env/config without rewriting code.
4. Minimal but COMPLETE: no drive-by refactors, but do not leave dead timers/schedulers running for disabled features.
5. Preserve exports and public method names.
6. Valid ESM JavaScript only.
7. old_string must match the file EXACTLY — copy verbatim from the snippet below (min 2 lines or 60 chars, unique context).
8. Max 8 replacements total across all files.
9. Do not touch secrets, .env files, or auth sessions (config.js defaults are OK).
10. changelog must explain the proper approach (not "emptied function").
11. NEVER delete the GitHub repository, wipe the project, or empty critical files.
12. If you cannot do it safely, return files:[].

NEW COMMAND RULES (when owner asks to add /foo or API command):
A) src/commands/registry.js — add { names, key, scope, role, help } to COMMAND_REGISTRY
B) src/controllers/CommandController.js — add case 'key': handler in switch
C) src/services/FeatureService.js — API logic in a dedicated service (axios, timeout, formatMessage)
D) Do NOT put command handlers inside unrelated controllers (NewsController, MovieController, etc.)
E) Match patterns of /horo (HoroscopeService + registry + switch case)`;

const COMPLETENESS_SYSTEM_PROMPT = `You review a code change for completeness (like a senior PR review).

The owner instruction and the CURRENT patched file contents are provided.
If the change is incomplete or hacky, return MORE replacements to finish it properly.
If already complete and proper, return {"summary":"complete","changelog":[],"files":[]}.

Return ONLY valid JSON:
${JSON_SHAPE}

REJECT these incomplete patterns:
• Emptying a function to \`return;\` / \`return null;\` when a feature flag exists
• Disabling a feature in one file but leaving its scheduler/timer still running
• Deleting implementation that should stay for re-enable via config

PREFER:
• config.js flag defaults (e.g. MORNING_MESSAGES_ENABLED === 'true' so default is off)
• Early-return guards that check the flag
• Stopping schedulers when the flag is false (scheduler already no-ops if flag false — ensure flag is false by default)

NEW COMMAND completeness:
• registry.js must list the command with names/key/help
• CommandController.js must have switch case for the command key
• API logic belongs in src/services/*Service.js, not random controllers`;

const REPAIR_SYSTEM_PROMPT = `You repair a failed code patch. The previous patch failed validation or was incomplete/hacky.

Return ONLY valid JSON (no markdown fences) in this shape:
${JSON_SHAPE}

RULES:
• Fix the validation / completeness errors listed by the user.
• Prefer proper config-flag disable over gutting methods.
• old_string must match the provided file content exactly.
• Keep the owner's original intent.
• Preserve exports and public methods.`;

const PLAN_JSON_SHAPE = `{
  "summary": "one-line what we will do",
  "approach": "config-first|code|both",
  "files_to_edit": ["src/path/File.js"],
  "steps": ["short action 1", "short action 2"],
  "changelog": ["bullet for owner"]
}`;

const PLAN_SYSTEM_PROMPT = `You are a senior engineer planning a WhatsApp bot code fix (Cursor agent style).

The owner gives an instruction. You have a list of candidate files — pick which to edit and HOW (config-first when disabling features).

Return ONLY valid JSON (no markdown):
${PLAN_JSON_SHAPE}

RULES:
• files_to_edit: subset of candidates only (max 6), include ALL entry points (config + controller + scheduler if needed)
• steps: 2–6 concrete actions the agent will take in order
• approach: prefer config-first for disable/remove feature requests
• Do not plan repo deletion or wiping files
• NEW COMMAND: must plan registry.js entry + CommandController switch case + dedicated service (src/services/XxxService.js). Never only patch an unrelated controller.`;

const PER_FILE_HEAL_SYSTEM_PROMPT = `You are a precise coding agent editing ONE file in a WhatsApp bot (Node ESM).

Return ONLY valid JSON (no markdown):
${JSON_SHAPE}

RULES:
• files[] must contain ONLY the one file path you were given — no other paths
• Max 3 replacements per response — small, exact snippets
• old_string: copy VERBATIM from the file content (min 2 lines or 80 chars, unique)
• new_string: the replacement
• If a previous attempt failed, fix the old_string to match the file EXACTLY
• Prefer config flags over deleting logic
• If nothing to change in this file, return files:[]`;

const NEW_COMMAND_WIRING_FILES = [
    'src/commands/registry.js',
    'src/controllers/CommandController.js',
];

/** Keyword → files that must be considered for a complete fix */
const FEATURE_FILE_MAP = [
    {
        re: /morning|good\s*morning|romantic\s*morning/i,
        files: [
            'src/config/config.js',
            'src/controllers/MorningMessageController.js',
            'src/utils/morningScheduler.js',
            'src/services/MorningMessageScraper.js',
            'src/models/MorningMessageDatabase.js',
        ],
    },
    {
        re: /summary|recap|group\s*chat\s*log/i,
        files: [
            'src/controllers/GroupSummaryController.js',
            'src/services/GroupChatLogService.js',
            'src/services/NvidiaDeepSeekService.js',
            'src/utils/groupSummaryScheduler.js',
            'src/config/config.js',
        ],
    },
    {
        re: /trade|stock|f&o|option/i,
        files: [
            'src/controllers/TradeAlertController.js',
            'src/services/MarketScanService.js',
            'src/services/TradeResearchService.js',
            'src/config/config.js',
        ],
    },
    {
        re: /movie|zip|hdhub|moviesdrive/i,
        files: [
            'src/services/HdHubMoviesService.js',
            'src/controllers/MovieController.js',
            'src/config/config.js',
        ],
    },
    {
        re: /heal|self-?heal|\/fix/i,
        files: [
            'src/services/SummarySelfHealService.js',
            'src/controllers/handlers/healHandlers.js',
            'src/config/config.js',
        ],
    },
    {
        re: /sticker/i,
        files: [
            'src/services/StickerForwarder.js',
            'src/controllers/StickerController.js',
            'src/config/config.js',
        ],
    },
    {
        re: /advice|adviceslip/i,
        files: [
            'src/services/AdviceService.js',
            'src/commands/registry.js',
            'src/controllers/CommandController.js',
        ],
    },
    {
        re: /horo|horoscope|zodiac|ohmanda|vedika/i,
        files: [
            'src/services/HoroscopeService.js',
            'src/commands/registry.js',
            'src/controllers/CommandController.js',
        ],
    },
    {
        re: /\b(add|new|create)\b.{0,40}\b(command|\/[a-z])/i,
        files: [
            'src/commands/registry.js',
            'src/controllers/CommandController.js',
            'src/services',
        ],
    },
];

function shortId() {
    return crypto.randomBytes(3).toString('hex');
}

function isNewCommandInstruction(instruction) {
    const text = String(instruction || '');
    return (
        /\b(add|new|create|implement)\b.{0,40}\b(command|\/[a-z])/i.test(text) ||
        /\/[a-z][a-z0-9_]*\b.{0,50}\b(api|command|feature|endpoint)/i.test(text) ||
        /\busing\b.{0,30}\bapi\b/i.test(text) && /\/[a-z]/i.test(text)
    );
}

function extractCommandNamesFromInstruction(instruction) {
    const matches = String(instruction || '').match(/\/[a-z][a-z0-9_]*/gi) || [];
    return [...new Set(matches.map((m) => m.toLowerCase()))];
}

function commandKeyFromName(cmdName) {
    return String(cmdName || '').replace(/^\//, '').toLowerCase();
}

/**
 * Rule-based root cause for horoscope failures (shown in auto-heal WhatsApp messages).
 * @param {{ source: string, ok: boolean, reason?: string }[]} diagnostics
 */
function analyzeHoroscopeFailure(diagnostics = []) {
    const ohmanda = diagnostics.find((d) => /ohmanda/i.test(d.source));
    const vedika = diagnostics.find((d) => /vedika/i.test(d.source));
    const app = diagnostics.find((d) => /horoscope-app|vercel/i.test(d.source));

    if (ohmanda && !ohmanda.ok && /empty|whitespace/i.test(String(ohmanda.reason || ''))) {
        const fallbackOk = Boolean(vedika?.ok || app?.ok);
        return {
            rootCause:
                'Primary API (ohmanda.com) returned HTTP 200 but the horoscope field was empty/whitespace only.',
            impact:
                '/horo showed "temporarily unavailable" when the code treated blank Ohmanda text as success and skipped fallbacks.',
            fixPlan: fallbackOk
                ? 'Pick the first non-empty result: Vedika or horoscope-app-api when Ohmanda text is blank after trim.'
                : 'Add multi-API fallback (Ohmanda → Vedika → horoscope-app-api) and reject empty/whitespace responses.',
            alreadyFixedHint:
                'HoroscopeService.js should throw on empty Ohmanda and chain fallbacks — if that code is already on main, redeploy Render.',
        };
    }

    const failed = diagnostics.filter((d) => !d.ok);
    if (failed.length === diagnostics.length && diagnostics.length > 0) {
        const detail = failed.map((d) => `• ${d.source}: ${d.reason || 'failed'}`).join('\n');
        return {
            rootCause: 'All horoscope API sources failed.',
            impact: '/horo cannot return any sign until at least one upstream API responds.',
            fixPlan: 'Verify network from Render, increase axios timeouts, and keep multiple fallback APIs.',
            apiDetails: detail,
        };
    }

    if (failed.length) {
        return {
            rootCause: failed.map((d) => `${d.source}: ${d.reason || 'failed'}`).join('; '),
            impact: '/horo failed for the requested sign.',
            fixPlan: 'Ensure HoroscopeService uses the first working non-empty API response.',
            apiDetails: diagnostics
                .map((d) => `• ${d.source}: ${d.ok ? 'ok' : d.reason || 'failed'}`)
                .join('\n'),
        };
    }

    return {
        rootCause: 'Horoscope fetch failed for an unknown reason.',
        impact: '/horo returned an error to the user.',
        fixPlan: 'Review HoroscopeService fetch and fallback logic.',
    };
}

/**
 * Rule-based root cause for group summary (/summaryon) failures.
 */
function analyzeSummaryFailure(ctx = {}) {
    const err = String(ctx.errorMessage || '');
    const count = ctx.messageCount ?? '?';
    const chunked = ctx.useChunks ? ' (chunked map-reduce)' : '';

    if (/timeout/i.test(err)) {
        return {
            rootCause: `NVIDIA recap LLM timed out with ${count} messages${chunked}.`,
            impact: 'Group got generic heuristic topics instead of a real chat-based recap.',
            fixPlan:
                'Shrink prompts in GroupChatLogService, raise GROUP_SUMMARY_LLM_TIMEOUT_MS, or reduce chunk count / sample size.',
        };
    }
    if (/503|502|429|rate/i.test(err)) {
        return {
            rootCause: `NVIDIA API unavailable or rate-limited during recap (${count} msgs${chunked}).`,
            impact: 'Daily recap fell back to heuristic summary or failed silently.',
            fixPlan: 'Add retry/backoff in NvidiaDeepSeekService.summarizeGroupChat and reduce prompt size.',
        };
    }
    if (/json|parse|invalid/i.test(err)) {
        return {
            rootCause: 'Recap LLM returned invalid JSON — parser could not build topics/notable/wrap_up.',
            impact: 'Group recap used fallback heuristics instead of conversation summary.',
            fixPlan: 'Harden parseSummaryJson and tighten SUMMARY_SYSTEM_PROMPT output shape.',
        };
    }
    if (/All recap chunks failed/i.test(err)) {
        return {
            rootCause: `Every map-reduce chunk failed for a busy day (${count} messages).`,
            impact: 'Large groups get no LLM recap — only offline heuristic topics.',
            fixPlan: 'Use fewer/smaller chunks, lower GROUP_SUMMARY_CHUNK_THRESHOLD, or single-sample fallback.',
        };
    }
    if (/NVIDIA_API_KEY|not configured/i.test(err)) {
        return {
            rootCause: 'NVIDIA_API_KEY missing or invalid on the server.',
            impact: '/summaryon groups never get LLM recaps — scheduler skips entirely.',
            fixPlan: 'Set NVIDIA_API_KEY on Render and restart the bot.',
        };
    }

    return {
        rootCause: err || 'Group recap LLM failed',
        impact: '/summaryon groups may receive generic fallback recap instead of chat-based summary.',
        fixPlan: 'Review GroupChatLogService.buildPrompt narrative instructions and NvidiaDeepSeekService summarize retry.',
    };
}

function extractJsonObject(raw) {
    let text = String(raw || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        return JSON.parse(text);
    } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
            return JSON.parse(m[0]);
        } catch {
            return null;
        }
    }
}

class SummarySelfHealService {
    /**
     * @param {object} cfg
     * @param {import('mongodb').Db|null} mongoDb
     */
    constructor(cfg = config, mongoDb = null) {
        this.config = cfg;
        this.enabled = cfg.SUMMARY_SELF_HEAL_ENABLED !== false;
        this.healModel = cfg.NVIDIA_HEAL_MODEL || DEFAULT_HEAL_MODEL;
        // Prefer reliable models first; Nemotron Ultra often 503s under load
        // Order: GLM (stable) → DeepSeek (fast) → Nemotron (best when up)
        this.healModels = [
            ...new Set(
                [
                    cfg.NVIDIA_TRADE_MODEL || 'z-ai/glm-5.2',
                    cfg.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash',
                    cfg.NVIDIA_HEAL_MODEL || DEFAULT_HEAL_MODEL,
                ].filter(Boolean)
            ),
        ];
        // Optional: put Nemotron first when NVIDIA_HEAL_PREFER_NEMOTRON=true
        if (cfg.NVIDIA_HEAL_PREFER_NEMOTRON === true || process.env.NVIDIA_HEAL_PREFER_NEMOTRON === 'true') {
            this.healModels = [
                ...new Set(
                    [
                        cfg.NVIDIA_HEAL_MODEL || DEFAULT_HEAL_MODEL,
                        cfg.NVIDIA_TRADE_MODEL || 'z-ai/glm-5.2',
                        cfg.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash',
                    ].filter(Boolean)
                ),
            ];
        }
        this.githubToken = cfg.GITHUB_TOKEN || '';
        this.githubRepo = cfg.GITHUB_REPO || 'officeboy12242/WA-BOT';
        this.githubBranch = cfg.GITHUB_BRANCH || 'main';
        this.notifyNumber = normalizePhoneNumber(cfg.SUMMARY_SELF_HEAL_NOTIFY || cfg.BOT_LOG_NUMBER || '917887499710');
        this.gemini = new GeminiHealService(cfg);
        this.nvidia = new NvidiaDeepSeekService(cfg);
        this._collection = null;
        this._sock = null;
        this._inflight = false;
        this._horoscopeHealLastAt = 0;
        this._summaryHealLastAt = 0;
        this.rootDir = process.cwd();

        if (mongoDb) {
            this._collection = mongoDb.collection('summary_self_heal');
        }
    }

    async init() {
        if (!this._collection) return;
        await this._collection.createIndex({ heal_id: 1 }, { unique: true });
        await this._collection.createIndex({ status: 1, created_at: -1 });
    }

    setSock(sock) {
        this._sock = sock;
    }

    /** Always read token from env so Render/local updates apply after restart. */
    getGithubToken() {
        return (process.env.GITHUB_TOKEN || this.config.GITHUB_TOKEN || this.githubToken || '').trim();
    }

    /**
     * Normalize owner/repo — accepts full URLs or trailing .git
     * e.g. https://github.com/officeboy12242/WA-BOT.git → officeboy12242/WA-BOT
     */
    getGithubRepo() {
        let repo = (
            process.env.GITHUB_REPO ||
            this.config.GITHUB_REPO ||
            this.githubRepo ||
            'officeboy12242/WA-BOT'
        ).trim();
        repo = repo
            .replace(/^https?:\/\/github\.com\//i, '')
            .replace(/^git@github\.com:/i, '')
            .replace(/\.git$/i, '')
            .replace(/^\/+|\/+$/g, '');
        // If only owner was set, append default repo name
        if (repo && !repo.includes('/')) {
            repo = `${repo}/WA-BOT`;
        }
        return repo || 'officeboy12242/WA-BOT';
    }

    getGithubBranch() {
        return (
            process.env.GITHUB_BRANCH ||
            this.config.GITHUB_BRANCH ||
            this.githubBranch ||
            'main'
        ).trim() || 'main';
    }

    isReady() {
        return this._isHealInfrastructureReady();
    }

    /** Summary auto-heal feature flag + infrastructure */
    isSummaryHealReady() {
        return this.enabled && this._isHealInfrastructureReady();
    }

    /** Horoscope auto-heal feature flag + infrastructure */
    isHoroscopeHealReady() {
        return this.config.HOROSCOPE_SELF_HEAL_ENABLED !== false && this._isHealInfrastructureReady();
    }

    _isHealInfrastructureReady() {
        const hasLlm = this.gemini.isConfigured() || this.nvidia.isConfigured();
        return (
            hasLlm &&
            Boolean(this.getGithubToken()) &&
            Boolean(this._collection)
        );
    }

    /** Label for /heal status and error messages */
    getHealModelLabel() {
        const parts = [];
        if (this.gemini.isConfigured()) {
            parts.push(`Gemini: ${this.gemini.getModelChain().join(' → ')}`);
        }
        if (this.nvidia.isConfigured()) {
            parts.push(`NVIDIA: ${this.healModels.join(' → ')}`);
        }
        return parts.join(' · ') || 'none';
    }

    /**
     * Heal LLM: Gemini first (if configured), then NVIDIA fallback.
     * @returns {Promise<{ content: string, model: string }>}
     */
    async _callHealLlm(systemPrompt, userPrompt, opts = {}) {
        const progress = typeof opts.onProgress === 'function' ? opts.onProgress : async () => {};
        let geminiErr;

        if (this.gemini.isConfigured()) {
            try {
                return await this.gemini.completeWithModelFallback(
                    this.gemini.getModelChain(),
                    systemPrompt,
                    userPrompt,
                    opts,
                );
            } catch (err) {
                geminiErr = err;
                logger.warn(`Gemini heal chain failed: ${err.message}`);
                await progress(`⚠️ Gemini failed — trying NVIDIA fallback…`);
            }
        }

        if (!this.nvidia.isConfigured()) {
            throw geminiErr || new Error('No heal LLM configured (set GEMINI_API_KEY or NVIDIA_API_KEY)');
        }

        return this.nvidia.completeWithModelFallback(this.healModels, systemPrompt, userPrompt, opts);
    }

    async _notify(text) {
        const sock = this._sock;
        if (!sock) return;

        const ownerJids = (this.config.OWNER_NUMBERS || [])
            .map((n) => `${normalizePhoneNumber(n)}@s.whatsapp.net`)
            .filter(Boolean);

        const logJid = resolveNotificationJid(sock, [this.notifyNumber, this.config.BOT_LOG_NUMBER]);

        const targets = new Set(ownerJids);
        if (logJid) targets.add(logJid);
        if (this.notifyNumber) targets.add(`${this.notifyNumber}@s.whatsapp.net`);

        for (const jid of targets) {
            await sock.sendMessage(jid, { text }).catch((err) => {
                logger.warn(`Self-heal notify failed ${jid}: ${err.message}`);
            });
        }
    }

    async _notifyOwnersOnly(text) {
        const sock = this._sock;
        if (!sock) return;
        for (const n of this.config.OWNER_NUMBERS || []) {
            const phone = normalizePhoneNumber(n);
            if (!phone) continue;
            await sock.sendMessage(`${phone}@s.whatsapp.net`, { text }).catch(() => {});
        }
        // Also logs number so you see the permission request
        if (this.notifyNumber) {
            await sock
                .sendMessage(`${this.notifyNumber}@s.whatsapp.net`, { text })
                .catch(() => {});
        }
    }

    async _readLocalFile(relPath) {
        const full = path.join(this.rootDir, relPath);
        return fs.readFile(full, 'utf8');
    }

    async _hasPendingOrRecent(source = null) {
        if (!this._collection) return true;
        const pendingQuery = { status: 'pending' };
        if (source) pendingQuery.source = source;
        const pending = await this._collection.findOne(pendingQuery);
        if (pending) return true;

        const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const recentQuery = {
            created_at: { $gte: since },
            status: { $in: ['pending', 'pushed', 'failed'] },
        };
        if (source) recentQuery.source = source;
        const recent = await this._collection.findOne(recentQuery);
        return Boolean(recent);
    }

    /**
     * Called when group summary LLM fails. Non-blocking.
     */
    triggerFromSummaryFailure(ctx) {
        if (!this.isSummaryHealReady()) {
            logger.info('Summary self-heal skipped (disabled or missing GITHUB_TOKEN / Mongo / LLM)');
            return;
        }
        if (this._inflight) {
            logger.info('Summary self-heal already running — skip');
            return;
        }
        const now = Date.now();
        if (now - this._summaryHealLastAt < SUMMARY_HEAL_COOLDOWN_MS) {
            logger.info('Summary self-heal cooldown — skip');
            return;
        }

        void this._runHealCycle(ctx);
    }

    /**
     * Called when /horo fails (all APIs down or unexpected error). Non-blocking.
     */
    triggerFromHoroscopeFailure({ sign, errorMessage, chatId, diagnostics }) {
        if (!this.isHoroscopeHealReady()) {
            logger.info('Horoscope self-heal skipped (disabled or missing GITHUB_TOKEN / Mongo / LLM)');
            return;
        }
        if (this._inflight) {
            logger.info('Self-heal already running — skip horoscope trigger');
            return;
        }
        const now = Date.now();
        if (now - this._horoscopeHealLastAt < HOROSCOPE_HEAL_COOLDOWN_MS) {
            logger.info('Horoscope self-heal cooldown — skip');
            return;
        }

        void this._runHoroscopeHealCycle({ sign, errorMessage, chatId, diagnostics });
    }

    async _isHoroscopeFixAlreadyInCode() {
        try {
            const content = await this._readLocalFile('src/services/HoroscopeService.js');
            return (
                content.includes('_fetchHoroscopeApp') &&
                content.includes('_probeSources') &&
                content.includes('empty horoscope') &&
                content.includes('vedikaResult.value.horoscope')
            );
        } catch {
            return false;
        }
    }

    _formatDiagnosticsBlock(diagnostics = []) {
        if (!diagnostics.length) return '';
        return diagnostics
            .map((d) => `  • ${d.source}: ${d.ok ? '✅ ok' : `❌ ${d.reason || 'failed'}`}`)
            .join('\n');
    }

    _formatHoroscopeAnalysisMessage({ sign, analysis, diagnostics, healId, proposal, alreadyFixed }) {
        const apiBlock = diagnostics?.length
            ? `\n📡 *API probe:*\n${this._formatDiagnosticsBlock(diagnostics)}\n`
            : '';

        const proposalBlock = proposal?.files?.length
            ? `\n📁 *Patch files:*\n${proposal.files.map((f) => `• \`${f.path}\``).join('\n')}\n` +
              (proposal.changelog?.length
                  ? `\n📋 *What the patch does:*\n${proposal.changelog.slice(0, 6).map((c) => `• ${c}`).join('\n')}\n`
                  : '')
            : '';

        const actionBlock = healId
            ? `\n🆔 Heal ID: *${healId}*\n` +
              `✅ \`/heal approve ${healId}\` — push to GitHub\n` +
              `❌ \`/heal reject ${healId}\` — discard\n`
            : '';

        const redeployBlock = alreadyFixed
            ? diagnostics.length > 0 && diagnostics.every((d) => !d.ok)
                ? `\n⚡ *Action:* Fallback code is already in the repo, but all APIs are down right now. Wait for upstream recovery — no deploy will fix this immediately.\n`
                : `\n⚡ *Action:* Fix is already in the codebase — *redeploy Render* if production still runs an older build.\n`
            : '';

        return (
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
            `┃  🔮 *HOROSCOPE AUTO-HEAL* 🔮  ┃\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
            `♑ *Sign:* ${sign || 'unknown'}\n\n` +
            `🔍 *Root cause:*\n${analysis.rootCause}\n\n` +
            `💥 *Impact:*\n${analysis.impact}\n\n` +
            `🛠️ *Fix:*\n${analysis.fixPlan}\n` +
            (analysis.alreadyFixedHint && alreadyFixed ? `\n_${analysis.alreadyFixedHint}_\n` : '') +
            apiBlock +
            redeployBlock +
            proposalBlock +
            actionBlock +
            `_Nothing is pushed until you confirm._`
        );
    }

    async _runHoroscopeHealCycle(ctx) {
        this._inflight = true;
        const status = this._makeStatusTracker('HOROSCOPE AUTO-HEAL');
        try {
            if (await this._hasPendingOrRecent('auto_horoscope')) {
                logger.info('Horoscope self-heal: pending/recent horoscope heal exists — skip');
                const analysis = analyzeHoroscopeFailure(ctx.diagnostics || []);
                await this._notify(
                    `🔧 *Horoscope self-heal skipped*\n` +
                        `(Another horoscope heal is pending or ran in the last 12h.)\n\n` +
                        `🔍 *Root cause:* ${analysis.rootCause}\n` +
                        `🛠️ *Fix:* ${analysis.fixPlan}`
                );
                return;
            }

            const diagnostics = ctx.diagnostics?.length
                ? ctx.diagnostics
                : (await horoscopeService.diagnoseSources(ctx.sign).catch(() => ({ diagnostics: [] })))
                      .diagnostics || [];

            const analysis = analyzeHoroscopeFailure(diagnostics);
            const alreadyFixed = await this._isHoroscopeFixAlreadyInCode();

            await status.step(`🔍 *Root cause:* ${analysis.rootCause.slice(0, 120)}…`);
            await status.step(`🛠️ *Fix plan:* ${analysis.fixPlan.slice(0, 120)}…`);
            if (diagnostics.length) {
                await status.step('📡 *API probe:*');
                for (const d of diagnostics) {
                    await status.note(`  • ${d.source}: ${d.ok ? 'ok' : d.reason || 'failed'}`);
                }
            }

            await this._notify(
                this._formatHoroscopeAnalysisMessage({
                    sign: ctx.sign,
                    analysis,
                    diagnostics,
                    alreadyFixed,
                })
            );

            if (alreadyFixed) {
                const allApisDown = diagnostics.length > 0 && diagnostics.every((d) => !d.ok);
                if (allApisDown) {
                    await status.step('⚠️ Fallback code exists but all APIs are down — upstream outage, not a code bug');
                } else {
                    await status.step('✅ Code fix already in repo — redeploy Render if production still runs old build');
                }
                await status.flush();
                logger.info('Horoscope auto-heal: fix already in code — analysis sent, skipping LLM patch');
                this._horoscopeHealLastAt = Date.now();
                return;
            }

            const instruction =
                `Auto-fix /horo horoscope failure: ${ctx.errorMessage}. ` +
                `Sign: ${ctx.sign || 'unknown'}. ` +
                `Root cause: ${analysis.rootCause} ` +
                `Fix: ${analysis.fixPlan} ` +
                'HoroscopeService must try multiple free APIs in parallel and use the first non-empty horoscope text.';

            await status.step('🤖 Generating code patch…');

            const picked = await this._pickCandidateFiles(instruction);
            const candidates = [...new Set([...HOROSCOPE_ALLOWED_FILES, ...picked])].slice(0, 8);

            let proposal = await this._generateAgentProposal({
                allowedPaths: candidates,
                instruction,
                userPromptParts: [
                    'Horoscope (/horo) failure report:',
                    `Sign requested: ${ctx.sign || 'unknown'}`,
                    `Error: ${ctx.errorMessage}`,
                    `Root cause: ${analysis.rootCause}`,
                    `Recommended fix: ${analysis.fixPlan}`,
                    `API probe:\n${this._formatDiagnosticsBlock(diagnostics)}`,
                    `Chat: ${ctx.chatId || 'n/a'}`,
                ],
                onProgress: (line) => status.step(line),
            });

            proposal = await this._ensureCompleteProposal(
                instruction,
                proposal,
                candidates,
                (line) => status.step(line)
            );

            if (!proposal?.files?.length) {
                await status.step('❌ Heal agent found no safe code change');
                await status.flush();
                await this._notify(
                    `🔧 *Horoscope self-heal*\nNo code patch produced.\n\n` +
                        `🔍 *Root cause:* ${analysis.rootCause}\n` +
                        `🛠️ *Try manually:* \`/fix ${analysis.fixPlan.slice(0, 80)}\``
                );
                return;
            }

            const healId = await this._storeProposal({
                source: 'auto_horoscope',
                instruction,
                error: String(ctx.errorMessage || '').slice(0, 1000),
                root_cause: analysis.rootCause,
                fix_plan: analysis.fixPlan,
                diagnostics,
                proposal,
            });

            await this._notifyOwnersOnly(
                this._formatHoroscopeAnalysisMessage({
                    sign: ctx.sign,
                    analysis,
                    diagnostics,
                    healId,
                    proposal,
                    alreadyFixed: false,
                })
            );
            await status.step(`✅ Proposal ready — heal ID *${healId}*`);
            await status.flush();
            logger.info(`Horoscope self-heal proposal ${healId} awaiting owner approval`);
            this._horoscopeHealLastAt = Date.now();
        } catch (err) {
            logger.error(`Horoscope self-heal cycle failed: ${err.message}`);
            await this._notify(
                `🔧 *Horoscope self-heal error*\n${err.message}\n\n` +
                    `_Check GITHUB_TOKEN, Mongo, and GEMINI_API_KEY on Render._`
            ).catch(() => {});
        } finally {
            this._inflight = false;
        }
    }

    async _isSummaryNarrativeFixAlreadyInCode() {
        try {
            const logSvc = await this._readLocalFile('src/services/GroupChatLogService.js');
            const nvidia = await this._readLocalFile('src/services/NvidiaDeepSeekService.js');
            return (
                logSvc.includes('what people actually discussed') &&
                logSvc.includes('buildPrompt') &&
                logSvc.includes('GROUP_SUMMARY_NARRATIVE') &&
                nvidia.includes('actual WhatsApp group CONVERSATION')
            );
        } catch {
            return false;
        }
    }

    _formatSummaryAnalysisMessage({ ctx, analysis, healId, proposal, alreadyFixed }) {
        const proposalBlock = proposal?.files?.length
            ? `\n📁 *Patch files:*\n${proposal.files.map((f) => `• \`${f.path}\``).join('\n')}\n` +
              (proposal.changelog?.length
                  ? `\n📋 *What the patch does:*\n${proposal.changelog.slice(0, 6).map((c) => `• ${c}`).join('\n')}\n`
                  : '')
            : '';

        const actionBlock = healId
            ? `\n🆔 Heal ID: *${healId}*\n` +
              `✅ \`/heal approve ${healId}\` — push to GitHub\n` +
              `❌ \`/heal reject ${healId}\` — discard\n`
            : '';

        const redeployBlock = alreadyFixed
            ? `\n⚡ *Action:* Narrative recap prompts are already in the codebase — *redeploy Render* if production still gives generic summaries.\n`
            : '';

        return (
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
            `┃  🗓️ *SUMMARY AUTO-HEAL* 🗓️  ┃\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
            `📢 *Group:* ${ctx.groupName || 'unknown'}\n` +
            `📅 *Date:* ${ctx.dateStr || 'n/a'}\n` +
            `💬 *Messages:* ${ctx.messageCount ?? '?'}` +
            (ctx.useChunks ? ' _(chunked)_' : '') +
            `\n\n` +
            `🔍 *Root cause:*\n${analysis.rootCause}\n\n` +
            `💥 *Impact:*\n${analysis.impact}\n\n` +
            `🛠️ *Fix:*\n${analysis.fixPlan}\n` +
            redeployBlock +
            proposalBlock +
            actionBlock +
            `_Nothing is pushed until you confirm._`
        );
    }

    async _runHealCycle(ctx) {
        this._inflight = true;
        const status = this._makeStatusTracker('SUMMARY AUTO-HEAL');
        try {
            const analysis = analyzeSummaryFailure(ctx);
            const alreadyFixed = await this._isSummaryNarrativeFixAlreadyInCode();

            if (await this._hasPendingOrRecent('auto_summary')) {
                logger.info('Summary self-heal: pending/recent summary heal exists — skip');
                await this._notify(
                    `🔧 *Summary self-heal skipped*\n` +
                        `(Another summary heal is pending or ran in the last 12h.)\n\n` +
                        `🔍 *Root cause:* ${analysis.rootCause}\n` +
                        `🛠️ *Fix:* ${analysis.fixPlan}\n` +
                        `📢 *Group:* ${ctx.groupName || 'n/a'}`
                );
                return;
            }

            await status.step(`🔍 *Root cause:* ${analysis.rootCause.slice(0, 120)}…`);
            await status.step(`🛠️ *Fix plan:* ${analysis.fixPlan.slice(0, 120)}…`);

            await this._notify(
                this._formatSummaryAnalysisMessage({ ctx, analysis, alreadyFixed })
            );

            if (alreadyFixed && !/NVIDIA_API_KEY|timeout|503|502|429|chunks failed/i.test(String(ctx.errorMessage || ''))) {
                await status.step('✅ Narrative recap prompts already in repo — redeploy if prod still generic');
                await status.flush();
                logger.info('Summary auto-heal: narrative fix already in code — analysis sent');
                this._summaryHealLastAt = Date.now();
                return;
            }

            const instruction =
                `Auto-fix group day recap (/summaryon) failure: ${ctx.errorMessage}. ` +
                `Group: ${ctx.groupName || 'unknown'}, date: ${ctx.dateStr || 'n/a'}, ` +
                `${ctx.messageCount || 0} messages${ctx.useChunks ? ', chunked mode' : ''}. ` +
                `Root cause: ${analysis.rootCause} Fix: ${analysis.fixPlan} ` +
                'Ensure buildPrompt uses narrative conversation instructions (who said what, themes, decisions) not generic event lists.';

            await status.step('🤖 Generating code patch…');

            const picked = await this._pickCandidateFiles(instruction);
            const candidates = [...new Set([...SUMMARY_ALLOWED_FILES, ...picked])].slice(0, 8);

            let proposal = await this._generateAgentProposal({
                allowedPaths: candidates,
                instruction,
                userPromptParts: [
                    'Summary/recap failure report:',
                    `Group: ${ctx.groupName}`,
                    `Date: ${ctx.dateStr}`,
                    `Message count: ${ctx.messageCount}`,
                    `Chunked: ${ctx.useChunks ? 'yes' : 'no'}`,
                    `Error: ${ctx.errorMessage}`,
                    `Root cause: ${analysis.rootCause}`,
                    `Recommended fix: ${analysis.fixPlan}`,
                ],
                onProgress: (line) => status.step(line),
            });

            proposal = await this._ensureCompleteProposal(
                instruction,
                proposal,
                candidates,
                (line) => status.step(line)
            );

            if (!proposal?.files?.length) {
                await status.step('❌ Heal agent found no safe code change');
                await status.flush();
                await this._notify(
                    `🔧 *Summary self-heal*\nNo code patch produced.\n\n` +
                        `🔍 *Root cause:* ${analysis.rootCause}\n` +
                        `🛠️ *Try manually:* \`/fix ${analysis.fixPlan.slice(0, 80)}\``
                );
                return;
            }

            const healId = await this._storeProposal({
                source: 'auto_summary',
                instruction: `Auto-fix summary failure: ${ctx.errorMessage}`,
                group_name: ctx.groupName || '',
                recap_date: ctx.dateStr || '',
                error: String(ctx.errorMessage || '').slice(0, 1000),
                root_cause: analysis.rootCause,
                fix_plan: analysis.fixPlan,
                message_count: ctx.messageCount || 0,
                proposal,
            });

            await this._notifyOwnersOnly(
                this._formatSummaryAnalysisMessage({
                    ctx,
                    analysis,
                    healId,
                    proposal,
                    alreadyFixed: false,
                })
            );
            await status.step(`✅ Proposal ready — heal ID *${healId}*`);
            await status.flush();
            logger.info(`Summary self-heal proposal ${healId} awaiting owner approval`);
            this._summaryHealLastAt = Date.now();
        } catch (err) {
            logger.error(`Summary self-heal cycle failed: ${err.message}`);
            await this._notify(
                `🔧 *Summary self-heal error*\n${err.message}\n\n` +
                    `_Check GITHUB_TOKEN, Mongo, and GEMINI_API_KEY on Render._`
            ).catch(() => {});
        } finally {
            this._inflight = false;
        }
    }

    /**
     * Build a live status updater that keeps a rolling log of steps.
     * @param {string} title
     * @param {(text: string) => void|Promise<void>} [onProgress]
     */
    _makeStatusTracker(title, onProgress) {
        const lines = [];
        let lastAt = 0;
        const render = async (force = false) => {
            if (typeof onProgress !== 'function') return;
            const now = Date.now();
            if (!force && now - lastAt < 280) return;
            lastAt = now;
            const body = [
                `🔧 *${title}*`,
                '',
                ...lines.slice(-14),
            ].join('\n');
            try {
                await onProgress(body);
            } catch {
                // ignore edit failures
            }
        };
        return {
            async step(line) {
                lines.push(line);
                await render(true);
            },
            async note(line) {
                lines.push(line);
                await render(false);
            },
            async flush() {
                await render(true);
            },
            lines,
        };
    }

    /**
     * Owner-driven fix: `/fix remove testing thing`
     * @param {string} instruction
     * @param {{ byPhone?: string, onProgress?: (text: string) => void|Promise<void> }} [opts]
     * @returns {Promise<{ ok: boolean, message: string, healId?: string }>}
     */
    async proposeFromInstruction(instruction, { byPhone = '', onProgress } = {}) {
        const text = String(instruction || '').trim();
        if (!text) {
            return { ok: false, message: '❌ Usage: `/fix <what to change>`\nExample: `/fix remove testing thing`' };
        }
        if (REPO_DELETE_INSTRUCTION_RE.test(text)) {
            return {
                ok: false,
                message:
                    '🚫 *Blocked for security*\n' +
                    'This agent can **never** delete the GitHub repository or wipe the project.\n' +
                    '_Ask for a specific code change instead._',
            };
        }
        if (!this.isReady()) {
            return {
                ok: false,
                message:
                    '❌ Self-heal not ready. Set `GITHUB_TOKEN` + Mongo + `GEMINI_API_KEY` (or `NVIDIA_API_KEY`) on Render.',
            };
        }
        if (this._inflight) {
            return { ok: false, message: '⏳ Another heal is running — try again in a minute.' };
        }

        const status = this._makeStatusTracker('AI FIX IN PROGRESS', onProgress);
        this._inflight = true;
        try {
            await status.step(`🗣️ *Instruction:* ${text.slice(0, 120)}`);
            await status.step('🧠 Agent mode: plan → per-file patch → validate');
            await status.step('📂 Scanning `src/` for matching files…');

            const candidates = await this._pickCandidateFiles(text);
            if (!candidates.length) {
                return { ok: false, message: '❌ No matching source files found under `src/`.' };
            }

            await status.step(`📁 Candidates (${candidates.length}):`);
            for (const f of candidates) {
                await status.note(`  • \`${f}\``);
            }

            let proposal = await this._generateAgentProposal({
                allowedPaths: candidates,
                instruction: text,
                userPromptParts: [
                    `Owner instruction: ${text}`,
                    `Requested by: ${byPhone || 'owner'}`,
                ],
                onProgress: (line) => status.step(line),
            });

            if (!proposal?.files?.length) {
                await status.step('❌ No safe changes produced');
                await status.flush();
                return {
                    ok: false,
                    message:
                        `❌ Model could not apply that safely with the available files.\n` +
                        `_Tried:_ ${candidates.slice(0, 6).join(', ')}`,
                };
            }

            // Completeness review (catches morning-message style incomplete fixes)
            await status.step('🔎 Completeness review (agent-style)…');
            proposal = await this._ensureCompleteProposal(text, proposal, candidates, (line) =>
                status.step(line)
            );

            await status.step('📝 Building change preview…');
            for (const f of proposal.files) {
                await status.note(`  ✓ will update \`${f.path}\``);
            }
            if (proposal.validationNotes?.length) {
                await status.step('🛡️ Validation passed:');
                for (const n of proposal.validationNotes.slice(0, 6)) {
                    await status.note(`  • ${n}`);
                }
            }
            if (proposal.qualityNotes?.length) {
                await status.step('✨ Quality:');
                for (const n of proposal.qualityNotes.slice(0, 4)) {
                    await status.note(`  • ${n}`);
                }
            }

            const healId = await this._storeProposal({
                source: 'owner_fix',
                instruction: text,
                requested_by: byPhone,
                proposal,
            });

            await status.step(`🆔 Proposal *${healId}* ready — waiting for approve`);
            await status.flush();

            const preview = this._formatProposalMessage(healId, proposal, {
                title: 'OWNER /FIX PROPOSAL',
                context:
                    `🗣️ *You asked:* ${text}\n` +
                    `🛡️ *Checks:* syntax · integrity · related files · completeness (config-first)` +
                    (proposal.validationNotes?.length
                        ? `\n_${proposal.validationNotes.slice(0, 3).join(' · ')}_`
                        : '') +
                    (proposal.qualityNotes?.length
                        ? `\n✨ ${proposal.qualityNotes.slice(0, 2).join(' · ')}`
                        : ''),
            });

            await this._notify(preview);
            return { ok: true, message: preview, healId };
        } catch (err) {
            logger.error(`Owner /fix failed: ${err.message}`);
            const hint = /timeout|ETIMEDOUT/i.test(err.message)
                ? '\n_NVIDIA timed out — try a shorter instruction (e.g. one file/area)._'
                : /429|overloaded|503/i.test(err.message)
                  ? '\n_NVIDIA is busy — wait 1–2 min and retry._'
                  : '';
            await status.step(`❌ Failed: ${err.message}`).catch(() => {});
            await status.flush().catch(() => {});
            await this._notify(`🔧 */fix failed*\n${err.message}${hint}`).catch(() => {});
            return {
                ok: false,
                message: `❌ Fix failed: ${err.message}${hint}\n_Tried:_ ${this.getHealModelLabel()}`,
            };
        } finally {
            this._inflight = false;
        }
    }

    async _storeProposal(row) {
        const healId = shortId();
        await this._collection.insertOne({
            heal_id: healId,
            status: 'pending',
            source: row.source || 'manual',
            instruction: row.instruction || '',
            requested_by: row.requested_by || '',
            group_name: row.group_name || '',
            recap_date: row.recap_date || '',
            error: row.error || '',
            root_cause: row.root_cause || '',
            fix_plan: row.fix_plan || '',
            diagnostics: row.diagnostics || [],
            message_count: row.message_count || 0,
            summary: row.proposal.summary,
            changelog: row.proposal.changelog || [],
            change_preview: row.proposal.changePreview || '',
            validation_notes: row.proposal.validationNotes || [],
            files: row.proposal.files,
            model: row.proposal.usedModel || this.healModel,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        return healId;
    }

    _formatProposalMessage(healId, proposal, { title, context, rootCause, fixPlan }) {
        const fileList = proposal.files.map((f) => `• \`${f.path}\``).join('\n');
        const changes = (proposal.changelog || [])
            .slice(0, 8)
            .map((c) => `• ${c}`)
            .join('\n');
        const preview = proposal.changePreview
            ? `\n🔎 *Diff preview*\n${proposal.changePreview}\n`
            : '';

        const analysisBlock =
            rootCause || fixPlan
                ? `\n🔍 *Root cause:*\n${rootCause || '—'}\n\n🛠️ *Fix:*\n${fixPlan || proposal.summary}\n\n`
                : '';

        const planBlock =
            proposal.agentPlan?.steps?.length
                ? `📋 *Agent plan:*\n${proposal.agentPlan.steps.map((s) => `  → ${s}`).join('\n')}\n\n`
                : '';

        return (
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
            `┃  🔧 *${title}* 🔧  ┃\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
            `${context}\n` +
            analysisBlock +
            `🧠 *Model:* ${proposal.usedModel || this.healModel}\n` +
            `📝 *Summary:* ${proposal.summary}\n\n` +
            planBlock +
            (changes ? `📋 *What changed:*\n${changes}\n\n` : '') +
            `📁 *Files:*\n${fileList}\n` +
            preview +
            `\n🆔 Heal ID: *${healId}*\n\n` +
            `Reply as *owner*:\n` +
            `✅ \`/heal approve ${healId}\` — push to GitHub\n` +
            `❌ \`/heal reject ${healId}\` — discard\n\n` +
            `_Nothing is pushed until you confirm._`
        );
    }

    _isSafePath(rel) {
        const p = String(rel || '').replace(/\\/g, '/');
        if (!p.startsWith('src/') || !p.endsWith('.js')) return false;
        if (p.includes('..')) return false;
        return !BLOCKED_PATH_PARTS.some((b) => p.includes(b));
    }

    async _listSrcJsFiles() {
        const out = [];
        const walk = async (dir, prefix) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const ent of entries) {
                const rel = `${prefix}/${ent.name}`.replace(/^\//, '');
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (BLOCKED_PATH_PARTS.some((b) => ent.name.includes(b))) continue;
                    await walk(full, rel);
                } else if (ent.isFile() && ent.name.endsWith('.js') && this._isSafePath(rel)) {
                    out.push(rel);
                }
            }
        };
        await walk(path.join(this.rootDir, 'src'), 'src');
        return out;
    }

    async _pickCandidateFiles(instruction) {
        const all = await this._listSrcJsFiles();
        const allSet = new Set(all);
        const words = String(instruction)
            .toLowerCase()
            .split(/[^a-z0-9_/.-]+/)
            .filter((w) => w.length > 2);

        const forced = new Set();
        // Always include config for enable/disable/remove/stop instructions
        if (/disable|enable|remove|stop|don'?t|do not|turn\s*off|no longer|want tha/i.test(instruction)) {
            if (allSet.has('src/config/config.js')) forced.add('src/config/config.js');
        }
        for (const feat of FEATURE_FILE_MAP) {
            if (feat.re.test(instruction)) {
                for (const f of feat.files) {
                    if (f === 'src/services') continue;
                    if (allSet.has(f)) forced.add(f);
                }
            }
        }

        if (isNewCommandInstruction(instruction)) {
            for (const f of NEW_COMMAND_WIRING_FILES) {
                if (allSet.has(f)) forced.add(f);
            }
            // Reference pattern for new API commands
            if (allSet.has('src/services/HoroscopeService.js')) {
                forced.add('src/services/HoroscopeService.js');
            }
        }

        const scored = [];
        for (const rel of all) {
            let score = forced.has(rel) ? 20 : 0;
            const low = rel.toLowerCase();
            for (const w of words) {
                if (low.includes(w)) score += 5;
            }
            if (/test|debug|temp|todo|mock/i.test(instruction) && /test|debug|temp|mock/i.test(low)) {
                score += 8;
            }
            if (/summary|recap/i.test(instruction) && /summary|groupchat|nvidia/i.test(low)) score += 8;
            if (/trade|stock|alert/i.test(instruction) && /trade|market|stock/i.test(low)) score += 8;
            if (/movie|zip/i.test(instruction) && /movie|hdhub/i.test(low)) score += 8;
            if (/morning/i.test(instruction) && /morning/i.test(low)) score += 10;
            if (/advice/i.test(instruction) && /advice/i.test(low)) score += 10;
            if (/horo|horoscope|zodiac/i.test(instruction) && /horo|horoscope/i.test(low)) score += 10;
            if (isNewCommandInstruction(instruction) && /registry|commandcontroller|service/i.test(low)) {
                score += 12;
            }
            if (/config\.js$/i.test(rel) && /disable|enable|remove|stop|off/i.test(instruction)) {
                score += 12;
            }

            if (score > 0) scored.push({ rel, score });
        }

        scored.sort((a, b) => b.score - a.score);

        for (const row of scored.slice(0, 12)) {
            try {
                const body = (await this._readLocalFile(row.rel)).toLowerCase().slice(0, 12_000);
                for (const w of words.slice(0, 5)) {
                    if (body.includes(w)) row.score += 2;
                }
            } catch {
                // ignore
            }
        }

        scored.sort((a, b) => b.score - a.score);
        let picks = [...forced];
        for (const s of scored) {
            if (!picks.includes(s.rel)) picks.push(s.rel);
            if (picks.length >= 8) break;
        }

        if (!picks.length) {
            picks = [
                'src/config/config.js',
                'src/controllers/GroupSummaryController.js',
                'src/services/GroupChatLogService.js',
                'src/commands/registry.js',
            ].filter((p) => allSet.has(p));
        }

        const withRelated = await this._expandWithRelatedFiles(picks, all);
        return withRelated.slice(0, 8);
    }

    /**
     * Detect hacky "empty the function" patches (like the morning-message bot fix).
     */
    _findHackyGutting(originals, files) {
        const issues = [];
        for (const f of files) {
            const before = originals.get(f.path) || '';
            const after = f.content || '';
            if (!before || !after) continue;

            // Method body reduced to bare return
            const guttedFns = after.match(
                /async\s+\w+\s*\([^)]*\)\s*\{\s*return\s*;?\s*\}/g
            ) || after.match(
                /\b\w+\s*\([^)]*\)\s*\{\s*return\s*;?\s*\}/g
            ) || [];
            for (const stub of guttedFns) {
                const name = stub.match(/(?:async\s+)?(\w+)\s*\(/)?.[1];
                if (!name) continue;
                const beforeFn = before.match(
                    new RegExp(`(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm')
                );
                const body = beforeFn?.[1] || '';
                if (body.split('\n').length >= 8) {
                    issues.push(
                        `${f.path}: gutted \`${name}()\` to empty return — prefer a config/feature flag instead`
                    );
                }
            }

            // Large deletion without touching config when instruction was disable/remove
            if (
                after.length < before.length * 0.55 &&
                !files.some((x) => x.path.includes('config.js'))
            ) {
                issues.push(
                    `${f.path}: large deletion without config.js change — incomplete disable`
                );
            }
        }
        return issues;
    }

    /**
     * Second pass: reject hacky patches and ask model to finish properly.
     */
    async _ensureCompleteProposal(instruction, proposal, candidates, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const originals = new Map();
        for (const rel of candidates) {
            try {
                originals.set(rel, await this._readLocalFile(rel));
            } catch {
                // ignore
            }
        }
        // Map current proposal onto originals for gutting detection
        const baseOriginals = new Map(originals);
        for (const f of proposal.files) {
            if (!baseOriginals.has(f.path)) {
                try {
                    baseOriginals.set(f.path, await this._readLocalFile(f.path));
                } catch {
                    baseOriginals.set(f.path, '');
                }
            }
        }

        let working = proposal;
        const hacky = this._findHackyGutting(baseOriginals, working.files);
        const needsReview =
            hacky.length > 0 ||
            /disable|remove|stop|don'?t|do not|turn\s*off|no longer|want tha/i.test(instruction);

        if (!needsReview && !hacky.length) {
            working.qualityNotes = ['no hacky gutting detected'];
            return working;
        }

        if (hacky.length) {
            await progress('⚠️ Incomplete/hacky pattern detected — fixing properly…');
            for (const h of hacky.slice(0, 4)) await progress(`  • ${h}`);
        } else {
            await progress('🔎 Reviewing related entry points…');
        }

        // Build view of patched world for review
        const patchedView = new Map(baseOriginals);
        for (const f of working.files) patchedView.set(f.path, f.content);

        const reviewPayload = [];
        for (const rel of candidates.slice(0, 8)) {
            const content = patchedView.get(rel);
            if (!content) continue;
            reviewPayload.push({
                path: rel,
                content: content.length > 10_000
                    ? `${content.slice(0, 5000)}\n\n/* ... */\n\n${content.slice(-5000)}`
                    : content,
            });
        }

        const userPrompt = [
            `Owner instruction: ${instruction}`,
            hacky.length ? `Problems found:\n${hacky.map((h) => `• ${h}`).join('\n')}` : '',
            'Review whether this change is COMPLETE and PROPER (config-first, all entry points).',
            'If incomplete, return additional/replacement patches. Prefer config flags over empty methods.',
            ...reviewPayload.map((f) => `\n===== FILE: ${f.path} =====\n${f.content}`),
        ]
            .filter(Boolean)
            .join('\n');

        try {
            const { content: raw, model } = await this._callHealLlm(
                COMPLETENESS_SYSTEM_PROMPT,
                userPrompt,
                { maxTokens: 2500, onProgress: progress }
            );
            const parsed = extractJsonObject(raw);
            if (parsed?.files?.length) {
                // Apply completeness patches on top of CURRENT patched content
                const applyBase = new Map(patchedView);
                const extra = await this._applyParsedProposal(
                    parsed,
                    applyBase,
                    new Set(candidates),
                    progress
                );
                if (extra.files.length) {
                    // Merge: keep prior files; completeness files use original baseHash for clean GitHub sync
                    const mergedByPath = new Map(working.files.map((f) => [f.path, f]));
                    for (const f of extra.files) {
                        const orig = baseOriginals.get(f.path) || '';
                        mergedByPath.set(f.path, {
                            path: f.path,
                            content: f.content,
                            baseHash: this._hashContent(orig),
                            // Full content vs original base — push if remote still at base
                            replacements: f.replacements || [],
                        });
                    }
                    working = {
                        summary: parsed.summary || working.summary,
                        changelog: [
                            ...(working.changelog || []),
                            ...(extra.changelog || []),
                            'completeness review applied',
                        ].slice(0, 12),
                        files: [...mergedByPath.values()],
                        usedModel: model || working.usedModel,
                        qualityNotes: ['completeness review improved the patch'],
                    };

                    await progress('🛡️ Re-validating after completeness review…');
                    const validation = await this._validatePatchedFiles(
                        baseOriginals,
                        working.files,
                        progress
                    );
                    if (!validation.ok) {
                        await progress('⚠️ Completeness patch failed checks — keeping prior valid patch');
                        // fall through with previous proposal if it was valid
                    } else {
                        working.validationNotes = validation.notes;
                        working.changePreview = this._buildChangePreview(baseOriginals, working.files);
                    }
                }
            } else {
                working.qualityNotes = working.qualityNotes || ['completeness review: no extra changes'];
            }
        } catch (err) {
            logger.warn(`Completeness review failed: ${err.message}`);
            await progress(`⚠️ Completeness review skipped: ${err.message.slice(0, 60)}`);
        }

        // Final anti-gutting gate
        const stillHacky = this._findHackyGutting(baseOriginals, working.files);
        if (stillHacky.length) {
            // Try one repair toward config-first
            await progress('🛠️ Forcing config-first repair…');
            const repaired = await this._repairProposal(
                `${instruction}\n\nREJECT empty-function gutting. Use config flags. Problems:\n${stillHacky.join('\n')}`,
                baseOriginals,
                working.files,
                stillHacky,
                progress
            );
            if (repaired?.files?.length) {
                const validation = await this._validatePatchedFiles(
                    baseOriginals,
                    repaired.files,
                    progress
                );
                if (validation.ok && !this._findHackyGutting(baseOriginals, repaired.files).length) {
                    repaired.validationNotes = validation.notes;
                    repaired.qualityNotes = ['config-first repair applied'];
                    repaired.changePreview = this._buildChangePreview(baseOriginals, repaired.files);
                    return repaired;
                }
            }
            throw new Error(
                `Rejected incomplete fix:\n${stillHacky.map((h) => `• ${h}`).join('\n')}\n` +
                    `_Agent requires config-first / full entry-point changes._`
            );
        }

        return working;
    }

    /** Follow local imports so patches don't break callers/callees. */
    async _expandWithRelatedFiles(picks, allFiles) {
        const allSet = new Set(allFiles);
        const out = [...picks];
        const seen = new Set(picks);

        for (const rel of picks.slice(0, 4)) {
            try {
                const body = await this._readLocalFile(rel);
                const importRe = /from\s+['"](\.[^'"]+)['"]/g;
                let m;
                while ((m = importRe.exec(body))) {
                    let imp = m[1];
                    if (!imp.endsWith('.js')) imp = `${imp}.js`;
                    const resolved = path.posix.normalize(
                        path.posix.join(path.posix.dirname(rel), imp)
                    );
                    if (allSet.has(resolved) && !seen.has(resolved) && this._isSafePath(resolved)) {
                        seen.add(resolved);
                        out.push(resolved);
                    }
                }
            } catch {
                // ignore
            }
        }
        return out;
    }

    /**
     * Syntax + integrity checks (same class of safety as a careful agent review).
     * @returns {Promise<{ ok: boolean, notes: string[], errors: string[] }>}
     */
    async _validatePatchedFiles(originals, files, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const notes = [];
        const errors = [];

        for (const f of files) {
            const before = originals.get(f.path) || '';
            const after = f.content || '';

            await progress(`🔍 Validating \`${f.path}\`…`);

            // Size guard — accidental mass deletion
            if (before && after.length < before.length * 0.4) {
                errors.push(`${f.path}: lost >60% of file size (possible accidental wipe)`);
                continue;
            }
            if (!after.includes('export')) {
                errors.push(`${f.path}: missing export (broken module)`);
                continue;
            }

            // Required symbols (critical APIs must survive)
            const rules = FILE_INTEGRITY_RULES[f.path] || ['export'];
            const missing = rules.filter((must) => !after.includes(must));
            if (missing.length) {
                for (const must of missing) {
                    errors.push(`${f.path}: missing required \`${must}\``);
                }
                continue;
            }

            // Real Node syntax check (authoritative)
            const syntax = await this._syntaxCheckJs(after, f.path);
            if (!syntax.ok) {
                errors.push(`${f.path}: syntax error — ${syntax.error}`);
                continue;
            }

            notes.push(`syntax OK · integrity OK — \`${f.path}\``);
            await progress(`  ✅ \`${f.path}\` passed checks`);
        }

        return { ok: errors.length === 0 && notes.length > 0, notes, errors };
    }

    /**
     * Ensures "add /foo command" tasks wire registry + dispatcher + service (not a random controller).
     * @returns {{ ok: boolean, errors: string[], notes: string[] }}
     */
    _validateNewCommandWiring(instruction, originals, patchedFiles) {
        if (!isNewCommandInstruction(instruction)) {
            return { ok: true, errors: [], notes: [] };
        }

        const cmdNames = extractCommandNamesFromInstruction(instruction);
        const errors = [];
        const notes = [];

        const mergedContent = (rel) => {
            const patched = patchedFiles.find((f) => f.path === rel);
            if (patched?.content) return patched.content;
            return originals.get(rel) || '';
        };

        const registryContent = mergedContent('src/commands/registry.js');
        const controllerContent = mergedContent('src/controllers/CommandController.js');
        const patchedPaths = new Set(patchedFiles.map((f) => f.path));

        if (!patchedPaths.has('src/commands/registry.js')) {
            errors.push('New command requires editing src/commands/registry.js');
        }
        if (!patchedPaths.has('src/controllers/CommandController.js')) {
            errors.push('New command requires editing src/controllers/CommandController.js');
        }

        const hasServicePatch = [...patchedPaths].some(
            (p) => p.startsWith('src/services/') && /Service\.js$/i.test(p),
        );
        if (!hasServicePatch) {
            errors.push(
                'New API command needs a dedicated src/services/*Service.js (do not put handler in NewsController etc.)',
            );
        }

        for (const cmd of cmdNames) {
            const key = commandKeyFromName(cmd);
            const inRegistry =
                registryContent.includes(`'${cmd}'`) ||
                registryContent.includes(`"${cmd}"`) ||
                registryContent.includes(`'/${key}'`) ||
                registryContent.includes(`"/${key}"`) ||
                registryContent.includes(`key: '${key}'`) ||
                registryContent.includes(`key: "${key}"`);
            if (!inRegistry) {
                errors.push(`registry.js missing entry for ${cmd} (key: ${key})`);
            }

            const inSwitch =
                controllerContent.includes(`case '${key}':`) ||
                controllerContent.includes(`case "${key}":`);
            if (!inSwitch) {
                errors.push(`CommandController.js missing case '${key}':`);
            }
        }

        if (!errors.length) {
            notes.push('new command wiring OK (registry + switch + service)');
        }

        return { ok: errors.length === 0, errors, notes };
    }

    async _syntaxCheckJs(content, relPath) {
        // .mjs so node --check treats ESM (import/export) correctly outside package.json type:module
        const base = path.basename(relPath).replace(/[^\w.-]/g, '_').replace(/\.js$/i, '');
        const tmp = path.join(tmpdir(), `heal-check-${Date.now()}-${base}.mjs`);
        try {
            await fs.writeFile(tmp, content, 'utf8');
            await execFileAsync(process.execPath, ['--check', tmp], {
                timeout: 10_000,
                windowsHide: true,
            });
            return { ok: true };
        } catch (err) {
            const msg = String(err.stderr || err.stdout || err.message || 'syntax error')
                .replaceAll(tmp, relPath)
                .split('\n')
                .filter((l) => !/Warning:|trace-warnings/i.test(l))
                .join(' ')
                .trim()
                .slice(0, 200);
            return { ok: false, error: msg || 'syntax error' };
        } finally {
            await fs.unlink(tmp).catch(() => {});
        }
    }

    /** One repair pass when validation fails. */
    async _repairProposal(instruction, originals, failedFiles, errors, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        await progress('🛠️ Repairing failed patches…');

        const payload = failedFiles.map((f) => {
            const original = originals.get(f.path) || '';
            const broken = f.content || '';
            return {
                path: f.path,
                content:
                    `--- ORIGINAL ---\n${original.slice(0, 5000)}\n\n` +
                    `--- PATCHED (INVALID) ---\n${broken.slice(0, 5000)}`,
            };
        });

        const userPrompt = [
            `Owner instruction: ${instruction}`,
            'Validation errors:',
            ...errors.map((e) => `• ${e}`),
            '',
            'Fix the files. Prefer restoring required exports and valid syntax while keeping the intent.',
            ...payload.map((f) => `\n===== FILE: ${f.path} =====\n${f.content}`),
        ].join('\n');

        const { content: raw, model } = await this._callHealLlm(
            REPAIR_SYSTEM_PROMPT,
            userPrompt,
            { maxTokens: 2500, onProgress: progress }
        );

        const parsed = extractJsonObject(raw);
        if (!parsed) return null;

        // Apply repairs against ORIGINAL sources (safer)
        const result = await this._applyParsedProposal(
            parsed,
            originals,
            new Set(failedFiles.map((f) => f.path)),
            progress
        );
        if (!result.files.length) return null;
        result.usedModel = model;
        return result;
    }

    _buildChangePreview(originals, files) {
        const lines = [];
        for (const f of files) {
            const before = originals.get(f.path) || '';
            const after = f.content || '';
            if (before === after) continue;
            const beforeLines = before.split('\n');
            const afterLines = after.split('\n');
            let removed = 0;
            let added = 0;
            // Simple line-count delta
            if (afterLines.length >= beforeLines.length) {
                added = afterLines.length - beforeLines.length;
            } else {
                removed = beforeLines.length - afterLines.length;
            }
            // Show a short snippet of first differing region
            let snippet = '';
            const max = Math.min(beforeLines.length, afterLines.length);
            for (let i = 0; i < max; i++) {
                if (beforeLines[i] !== afterLines[i]) {
                    const oldBit = beforeLines[i].trim().slice(0, 60);
                    const newBit = afterLines[i].trim().slice(0, 60);
                    snippet = `  - ${oldBit || '(empty)'}\n  + ${newBit || '(empty)'}`;
                    break;
                }
            }
            lines.push(`\`${f.path}\` (Δ lines ~${added - removed >= 0 ? '+' : ''}${added - removed})`);
            if (snippet) lines.push(snippet);
        }
        return lines.join('\n').slice(0, 1200);
    }

    async _generateProposal({ allowedPaths, systemPrompt, userPromptParts, onProgress, instruction }) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const pathList = allowedPaths.slice(0, 8);
        const originals = new Map();
        const filePayload = [];
        for (const rel of pathList) {
            if (!this._isSafePath(rel) && !SUMMARY_ALLOWED_FILES.includes(rel)) continue;
            try {
                await progress(`📖 Reading \`${rel}\`…`);
                const content = await this._readLocalFile(rel);
                originals.set(rel, content);
                const snippet =
                    content.length > 8_000
                        ? `${content.slice(0, 4000)}\n\n/* ... middle omitted ... */\n\n${content.slice(-4000)}`
                        : content;
                filePayload.push({ path: rel, content: snippet });
            } catch (err) {
                logger.warn(`Self-heal could not read ${rel}: ${err.message}`);
                await progress(`⚠️ Could not read \`${rel}\``);
            }
        }

        if (!filePayload.length) {
            throw new Error('No readable source files for heal');
        }

        const buildUserPrompt = (payload) =>
            [
                ...userPromptParts,
                '',
                'Source files (may be truncated — old_string must still match exactly):',
                ...payload.map((f) => `\n===== FILE: ${f.path} =====\n${f.content}`),
                '',
                'Return JSON with precise replacements and a changelog. Keep replacements small.',
            ].join('\n');

        const payloadAttempts = [
            filePayload,
            filePayload.slice(0, 2),
            filePayload.slice(0, 1),
        ];

        let lastErr;
        for (let p = 0; p < payloadAttempts.length; p++) {
            const payload = payloadAttempts[p];
            if (!payload.length) continue;
            try {
                const userPrompt = buildUserPrompt(payload);
                await progress(`📦 Prompt ready (${payload.length} file(s), ${userPrompt.length} chars)`);
                logger.info(
                    `Self-heal LLM call (${payload.length} file(s), ${userPrompt.length} chars), ` +
                        `models: ${this.getHealModelLabel()}`
                );

                const { content: raw, model: usedModel } = await this._callHealLlm(
                    systemPrompt,
                    userPrompt,
                    { maxTokens: 2500, onProgress: progress }
                );

                await progress('🧩 Applying patches to files…');
                const parsed = extractJsonObject(raw);
                if (!parsed || !Array.isArray(parsed.files)) {
                    throw new Error('Heal model returned invalid JSON');
                }

                let result = await this._applyParsedProposal(parsed, originals, new Set(pathList), progress);
                if (!result.files.length) {
                    throw new Error('Heal model returned no applicable replacements');
                }
                result.usedModel = usedModel;

                await progress('🛡️ Running syntax + integrity checks…');
                let validation = await this._validatePatchedFiles(originals, result.files, progress);

                if (!validation.ok) {
                    await progress('⚠️ Checks failed — attempting auto-repair…');
                    for (const e of validation.errors.slice(0, 5)) {
                        await progress(`  • ${e.slice(0, 100)}`);
                    }
                    const instructionHint =
                        instruction ||
                        userPromptParts.find((l) => /instruction|Error:/i.test(l)) ||
                        '';
                    const repaired = await this._repairProposal(
                        instructionHint,
                        originals,
                        result.files,
                        validation.errors,
                        progress
                    );
                    if (!repaired?.files?.length) {
                        throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
                    }
                    await progress('🛡️ Re-checking after repair…');
                    validation = await this._validatePatchedFiles(originals, repaired.files, progress);
                    if (!validation.ok) {
                        throw new Error(`Validation failed after repair: ${validation.errors.join('; ')}`);
                    }
                    result = repaired;
                    result.changelog = [
                        ...(parsed.changelog || []),
                        ...(repaired.changelog || []),
                        'auto-repaired after validation',
                    ].slice(0, 10);
                }

                result.validationNotes = validation.notes;
                result.changePreview = this._buildChangePreview(originals, result.files);
                return result;
            } catch (err) {
                lastErr = err;
                logger.warn(`Self-heal proposal attempt ${p + 1} failed: ${err.message}`);
                await progress(`⚠️ Attempt ${p + 1} failed: ${String(err.message).slice(0, 80)}`);
            }
        }

        throw lastErr || new Error('Heal proposal failed');
    }

    _hashContent(text) {
        return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
    }

    _tryApplyReplacement(content, oldStr, newStr) {
        if (!oldStr || oldStr === newStr) return null;
        if (content.includes(oldStr)) {
            return content.replace(oldStr, newStr);
        }
        const variants = [
            oldStr.trim(),
            oldStr.replace(/\r\n/g, '\n'),
            oldStr.replace(/\n/g, '\r\n'),
            oldStr.replace(/\t/g, '    '),
        ];
        for (const v of variants) {
            if (v && v !== oldStr && content.includes(v)) {
                const trimmedNew = oldStr.trim() === oldStr ? newStr.trim() : newStr;
                return content.replace(v, trimmedNew);
            }
        }
        return null;
    }

    async _applyParsedProposal(parsed, originals, allowed, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const files = [];
        const appliedNotes = [];
        /** @type {{ path: string, old_string: string }[]} */
        const failedReplacements = [];

        for (const f of parsed.files || []) {
            const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
            if (!allowed.has(rel) || (!this._isSafePath(rel) && !SUMMARY_ALLOWED_FILES.includes(rel))) {
                logger.warn(`Self-heal rejected path: ${rel}`);
                continue;
            }

            const baseContent = originals.get(rel);
            if (baseContent == null) continue;
            let next = baseContent;
            /** @type {{ old_string: string, new_string: string }[]} */
            const appliedReplacements = [];

            await progress(`✏️ \`${rel}\` — applying changes…`);

            if (typeof f.content === 'string' && f.content.length > 50) {
                // Full rewrite only if file is small enough to be trustworthy
                if (f.content.length < 25_000) {
                    next = f.content;
                    appliedNotes.push(`${rel}: full file rewrite`);
                    await progress(`  ✓ \`${rel}\` — full file rewrite`);
                }
            } else if (Array.isArray(f.replacements)) {
                let applied = 0;
                const reps = f.replacements.slice(0, 4);
                await progress(`  📝 ${reps.length} replacement(s) in \`${rel}\``);
                for (const rep of reps) {
                    const oldStr = String(rep.old_string ?? rep.old ?? '');
                    const newStr = String(rep.new_string ?? rep.new ?? '');
                    const label = oldStr.trim().slice(0, 48).replace(/\n/g, ' ');
                    await progress(`  • patching: \`${label || '(snippet)'}…\``);

                    const replaced = this._tryApplyReplacement(next, oldStr, newStr);
                    if (replaced == null) {
                        logger.warn(`Self-heal old_string not found in ${rel}`);
                        failedReplacements.push({ path: rel, old_string: oldStr });
                        await progress(`  ⚠️ no match in \`${rel}\` for: \`${label}…\``);
                        continue;
                    }
                    next = replaced;
                    appliedReplacements.push({
                        old_string: oldStr,
                        new_string: newStr,
                    });
                    applied += 1;
                    await progress(`  ✓ applied in \`${rel}\``);
                    appliedNotes.push(`${rel}: replaced “${label}…”`);
                }
                if (!applied) continue;
                await progress(`  ✅ \`${rel}\` — ${applied}/${reps.length} patch(es) applied`);
            } else {
                continue;
            }

            if (next === baseContent) continue;
            // Never allow wiping a file (GitHub "delete file" equivalent)
            if (!String(next).trim() || String(next).trim().length < 20) {
                logger.warn(`Self-heal rejected wipe of ${rel}`);
                await progress(`  🚫 blocked wipe of \`${rel}\``);
                continue;
            }
            if (rel.includes('NvidiaDeepSeek') && !next.includes('completeTrade')) {
                logger.warn(`Self-heal rejected NvidiaDeepSeekService change that removes trade API`);
                await progress(`  ⛔ blocked unsafe change in \`${rel}\``);
                continue;
            }
            files.push({
                path: rel,
                content: next,
                baseHash: this._hashContent(baseContent),
                replacements: appliedReplacements,
            });
        }

        const changelog = Array.isArray(parsed.changelog)
            ? parsed.changelog.map((c) => String(c).trim()).filter(Boolean).slice(0, 10)
            : appliedNotes.slice(0, 10);

        return {
            summary: String(parsed.summary || 'Code fix').slice(0, 200),
            changelog,
            changePreview: this._buildChangePreview(originals, files),
            files,
            failedReplacements,
        };
    }

    /**
     * Cursor-style step 1: plan which files to touch and how.
     */
    async _createHealPlan(instruction, candidatePaths, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const paths = candidatePaths.slice(0, 8);
        const cmdHint = isNewCommandInstruction(instruction)
            ? [
                  '',
                  'IMPORTANT — NEW COMMAND CHECKLIST:',
                  '1) src/commands/registry.js — COMMAND_REGISTRY entry',
                  '2) src/controllers/CommandController.js — switch case',
                  '3) src/services/XxxService.js — axios API + formatMessage (like HoroscopeService)',
                  'Do NOT add handlers to NewsController or other unrelated controllers.',
              ].join('\n')
            : '';
        const userPrompt = [
            `Owner instruction: ${instruction}`,
            cmdHint,
            '',
            'Candidate files (pick subset to edit):',
            ...paths.map((p) => `• ${p}`),
            '',
            'Return the plan JSON only.',
        ]
            .filter(Boolean)
            .join('\n');

        await progress('🧠 Planning (which files + approach)…');
        const { content: raw, model } = await this._callHealLlm(PLAN_SYSTEM_PROMPT, userPrompt, {
            maxTokens: 2000,
            onProgress: progress,
        });

        const parsed = extractJsonObject(raw);
        if (!parsed) {
            return {
                summary: instruction.slice(0, 120),
                approach: 'both',
                files_to_edit: paths.slice(0, 4),
                steps: ['Read files', 'Apply patches', 'Validate syntax'],
                changelog: [],
                usedModel: model,
            };
        }

        const filesToEdit = (Array.isArray(parsed.files_to_edit) ? parsed.files_to_edit : [])
            .map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, ''))
            .filter((p) => paths.includes(p));

        let finalFiles = filesToEdit.length ? filesToEdit.slice(0, 6) : paths.slice(0, 4);
        if (isNewCommandInstruction(instruction)) {
            const merged = new Set(finalFiles);
            for (const f of NEW_COMMAND_WIRING_FILES) {
                if (paths.includes(f)) merged.add(f);
            }
            finalFiles = [...merged].slice(0, 6);
        }

        return {
            summary: String(parsed.summary || 'Code fix').slice(0, 200),
            approach: String(parsed.approach || 'both'),
            files_to_edit: finalFiles,
            steps: (Array.isArray(parsed.steps) ? parsed.steps : [])
                .map((s) => String(s).trim())
                .filter(Boolean)
                .slice(0, 6),
            changelog: (Array.isArray(parsed.changelog) ? parsed.changelog : [])
                .map((c) => String(c).trim())
                .filter(Boolean)
                .slice(0, 6),
            usedModel: model,
        };
    }

    /**
     * Cursor-style step 2: one file at a time with patch retries.
     */
    async _proposeSingleFileWithRetries(instruction, rel, plan, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        if (!this._isSafePath(rel) && !SUMMARY_ALLOWED_FILES.includes(rel)) {
            return null;
        }

        let originalContent;
        try {
            await progress(`📖 Reading \`${rel}\`…`);
            originalContent = await this._readLocalFile(rel);
        } catch (err) {
            logger.warn(`Agent could not read ${rel}: ${err.message}`);
            await progress(`⚠️ Could not read \`${rel}\``);
            return null;
        }

        let working = originalContent;
        const maxAttempts = 3;
        /** @type {string[]} */
        let lastErrors = [];
        let usedModel = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await progress(`🤖 \`${rel}\` — attempt ${attempt}/${maxAttempts}…`);

            const snippet =
                working.length > 14_000
                    ? `${working.slice(0, 7000)}\n\n/* ... middle omitted ... */\n\n${working.slice(-7000)}`
                    : working;

            const userPrompt = [
                `Owner instruction: ${instruction}`,
                `Plan: ${plan.summary || ''}`,
                `Approach: ${plan.approach || 'both'}`,
                attempt > 1 && lastErrors.length
                    ? `PREVIOUS ATTEMPT FAILED — fix these issues:\n${lastErrors.map((e) => `• ${e}`).join('\n')}`
                    : '',
                `You must edit ONLY this file: ${rel}`,
                'File content below — old_string must match EXACTLY:',
                `===== FILE: ${rel} =====`,
                snippet,
                '',
                'Return JSON with replacements for this file only (max 3).',
            ]
                .filter(Boolean)
                .join('\n');

            const { content: raw, model } = await this._callHealLlm(PER_FILE_HEAL_SYSTEM_PROMPT, userPrompt, {
                maxTokens: 6000,
                onProgress: progress,
            });
            usedModel = model;

            const parsed = extractJsonObject(raw);
            if (!parsed?.files?.length) {
                lastErrors = ['Model returned no patches for this file'];
                continue;
            }

            const applyBase = new Map([[rel, working]]);
            const result = await this._applyParsedProposal(parsed, applyBase, new Set([rel]), progress);

            if (!result.files.length) {
                lastErrors =
                    result.failedReplacements?.length
                        ? result.failedReplacements.map(
                              (f) => `old_string not found in ${f.path}: "${String(f.old_string).slice(0, 72)}…"`,
                          )
                        : ['No replacements could be applied — old_string did not match'];
                continue;
            }

            working = result.files[0].content;
            if (working === originalContent) {
                lastErrors = ['Patches did not change the file'];
                continue;
            }

            await progress(`🛡️ Validating \`${rel}\`…`);
            const validation = await this._validatePatchedFiles(
                new Map([[rel, originalContent]]),
                [{ path: rel, content: working }],
                progress,
            );

            if (!validation.ok) {
                lastErrors = validation.errors;
                working = originalContent;
                continue;
            }

            await progress(`✅ \`${rel}\` — done`);
            return {
                path: rel,
                content: working,
                baseHash: this._hashContent(originalContent),
                replacements: result.files[0].replacements || [],
                model: usedModel,
                changelog: result.changelog || [],
            };
        }

        await progress(`❌ Gave up on \`${rel}\` after ${maxAttempts} attempts`);
        return null;
    }

    /**
     * Cursor-style agent: plan → per-file patch+validate+retry → merge.
     */
    async _generateAgentProposal({ allowedPaths, instruction, userPromptParts, onProgress }) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const pathList = allowedPaths.slice(0, 8);

        await progress('📋 *Step 1/4* — Plan');
        const plan = await this._createHealPlan(instruction, pathList, progress);

        await progress(`📌 *${plan.summary}*`);
        if (plan.steps?.length) {
            for (const step of plan.steps) {
                await progress(`  → ${step}`);
            }
        }

        const filesToEdit = plan.files_to_edit?.length ? plan.files_to_edit : pathList.slice(0, 4);
        await progress(`📁 Will edit ${filesToEdit.length} file(s)`);

        await progress('🔧 *Step 2/4* — Per-file patches');
        const originals = new Map();
        /** @type {object[]} */
        const patchedFiles = [];
        const changelog = [...(plan.changelog || [])];
        let usedModel = plan.usedModel || '';

        for (const rel of filesToEdit) {
            try {
                originals.set(rel, await this._readLocalFile(rel));
            } catch {
                await progress(`⚠️ Skip unreadable \`${rel}\``);
                continue;
            }

            const fileResult = await this._proposeSingleFileWithRetries(instruction, rel, plan, progress);
            if (!fileResult) continue;

            patchedFiles.push({
                path: fileResult.path,
                content: fileResult.content,
                baseHash: fileResult.baseHash,
                replacements: fileResult.replacements,
            });
            if (fileResult.model) usedModel = fileResult.model;
            changelog.push(...(fileResult.changelog || []));
        }

        if (!patchedFiles.length) {
            throw new Error('Agent could not apply patches to any file');
        }

        await progress('🛡️ *Step 3/4* — Final validation');
        let validation = await this._validatePatchedFiles(originals, patchedFiles, progress);

        const wiring = this._validateNewCommandWiring(instruction, originals, patchedFiles);
        if (!wiring.ok) {
            validation = {
                ok: false,
                notes: [...(validation.notes || []), ...(wiring.notes || [])],
                errors: [...(validation.errors || []), ...wiring.errors],
            };
            for (const err of wiring.errors) {
                await progress(`⚠️ Wiring: ${err}`);
            }
        } else if (wiring.notes?.length) {
            validation.notes = [...(validation.notes || []), ...wiring.notes];
        }

        if (!validation.ok) {
            await progress('⚠️ Final check failed — repair pass…');
            const repaired = await this._repairProposal(
                instruction,
                originals,
                patchedFiles,
                validation.errors,
                progress,
            );
            if (!repaired?.files?.length) {
                throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
            }
            validation = await this._validatePatchedFiles(originals, repaired.files, progress);
            if (!validation.ok) {
                throw new Error(`Validation failed after repair: ${validation.errors.join('; ')}`);
            }
            return {
                summary: plan.summary,
                changelog: [...changelog, ...(repaired.changelog || []), 'auto-repaired after validation'].slice(
                    0,
                    10,
                ),
                files: repaired.files,
                usedModel: repaired.usedModel || usedModel,
                validationNotes: validation.notes,
                changePreview: this._buildChangePreview(originals, repaired.files),
                agentPlan: plan,
            };
        }

        await progress('✅ *Step 4/4* — Proposal ready');
        return {
            summary: plan.summary,
            changelog: [...new Set(changelog)].slice(0, 10),
            files: patchedFiles,
            usedModel,
            validationNotes: validation.notes,
            changePreview: this._buildChangePreview(originals, patchedFiles),
            agentPlan: plan,
        };
    }

    async getProposal(healId) {
        if (!this._collection) return null;
        return this._collection.findOne({ heal_id: String(healId || '').trim().toLowerCase() });
    }

    async reject(healId, byPhone = '') {
        const id = String(healId || '').trim().toLowerCase();
        const row = await this.getProposal(id);
        if (!row) return { ok: false, message: `No heal proposal \`${id}\`` };
        if (row.status !== 'pending') {
            return { ok: false, message: `Heal \`${id}\` is already *${row.status}*` };
        }

        await this._collection.updateOne(
            { heal_id: id },
            { $set: { status: 'rejected', rejected_at: new Date(), rejected_by: byPhone } }
        );
        await this._notify(`🔧 Heal *${id}* rejected by owner. No push.`);
        return { ok: true, message: `✅ Heal \`${id}\` rejected. Nothing pushed.` };
    }

    async approveAndPush(healId, byPhone = '', { onProgress } = {}) {
        const status = this._makeStatusTracker('PUSHING TO GITHUB', onProgress);
        const id = String(healId || '').trim().toLowerCase();
        const row = await this.getProposal(id);
        if (!row) {
            return {
                ok: false,
                message:
                    `❌ No heal proposal \`${id}\`.\n` +
                    `_It may have expired or this is a different bot instance. Run \`/fix …\` again._`,
            };
        }
        if (row.status !== 'pending') {
            return {
                ok: false,
                message:
                    `❌ Heal \`${id}\` is already *${row.status}*.\n` +
                    (row.error_push ? `_Last error:_ ${row.error_push}\n` : '') +
                    `_Run \`/fix …\` again for a new proposal._`,
            };
        }
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
            await this._collection.updateOne({ heal_id: id }, { $set: { status: 'expired' } });
            return { ok: false, message: `❌ Heal \`${id}\` expired. Run \`/fix …\` again.` };
        }
        if (!row.files?.length) {
            return { ok: false, message: `❌ Heal \`${id}\` has no file changes to push.` };
        }

        const token = this.getGithubToken();
        const repo = this.getGithubRepo();
        const branch = this.getGithubBranch();
        if (!token) {
            return {
                ok: false,
                message:
                    '❌ `GITHUB_TOKEN` is not set on the server.\n' +
                    '_Add it on Render → Environment, then restart the service._',
            };
        }
        this.githubToken = token;
        this.githubRepo = repo;
        this.githubBranch = branch;

        await status.step(`🆔 Heal *${id}*`);
        await status.step(`🌿 Target \`${repo}@${branch}\``);
        await this._notify(
            `🔧 Owner approved heal *${id}* — pushing to \`${repo}@${branch}\`…`
        );

        try {
            await status.step('🔑 Checking GitHub access…');
            await this._assertGithubAccess(repo, branch);
            await status.step('✅ GitHub access OK');

            // Sync with latest GitHub (avoids conflicts with Cursor / other pushes)
            await status.step('🔄 Syncing with latest GitHub (rebase patches)…');
            const toPush = [];
            const syncOriginals = new Map();
            for (const file of row.files || []) {
                await status.step(`📥 Fetching latest \`${file.path}\`…`);
                const resolved = await this._resolveContentAgainstGithub(file, (line) => status.note(line));
                syncOriginals.set(file.path, resolved.baseContent);
                toPush.push({
                    path: file.path,
                    content: resolved.content,
                    sha: resolved.sha,
                });
            }

            await status.step('🛡️ Validating rebased patches…');
            const prePush = await this._validatePatchedFiles(
                syncOriginals,
                toPush,
                (line) => status.step(line)
            );
            if (!prePush.ok) {
                throw new Error(
                    `Pre-push validation failed after sync:\n${prePush.errors.map((e) => `• ${e}`).join('\n')}\n` +
                        `_Remote changed — run /fix again. Nothing was pushed._`
                );
            }
            await status.step('✅ Pre-push validation passed');

            await status.step('🔒 Security check (no repo delete / no file wipe)…');
            this._assertSafePushPayload(toPush);
            await status.step('✅ Security check passed');

            const pushed = [];
            for (const file of toPush) {
                await status.step(`⬆️ Pushing \`${file.path}\`…`);
                const commitMsg = row.instruction
                    ? `fix: ${String(row.instruction).slice(0, 72)} [${id}]`
                    : `fix(summary): ${row.summary} [${id}]`;
                await this._pushFileToGitHub(file.path, file.content, commitMsg, file.sha);
                pushed.push(file.path);
                await status.note(`  ✓ \`${file.path}\``);
            }
            await status.step('🎉 Push complete (synced with remote)');
            await status.flush();

            await this._collection.updateOne(
                { heal_id: id },
                {
                    $set: {
                        status: 'pushed',
                        pushed_at: new Date(),
                        approved_by: byPhone,
                        pushed_files: pushed,
                    },
                }
            );

            const changes = (row.changelog || []).slice(0, 6).map((c) => `• ${c}`).join('\n');
            const analysisBlock = row.root_cause
                ? `\n🔍 *Root cause:* ${row.root_cause}\n🛠️ *Fix:* ${row.fix_plan || row.summary}\n`
                : '';
            const msg =
                `✅ *Self-heal pushed*\n` +
                `🆔 ${id}\n` +
                (row.instruction ? `🗣️ *Asked:* ${row.instruction}\n` : '') +
                analysisBlock +
                `📝 ${row.summary}\n` +
                (changes ? `\n📋 *Changes:*\n${changes}\n` : '') +
                `📁 ${pushed.join(', ')}\n` +
                `🌿 ${repo}@${branch}\n` +
                `_Render will redeploy from main._`;
            await this._notify(msg);
            return { ok: true, message: msg };
        } catch (err) {
            const detail = this._formatGithubError(err);
            await status.step(`❌ ${detail.slice(0, 120)}`).catch(() => {});
            await status.flush().catch(() => {});
            await this._collection.updateOne(
                { heal_id: id },
                { $set: { status: 'failed', error_push: detail, failed_at: new Date() } }
            );
            const msg = `❌ Heal push failed for *${id}*:\n${detail}`;
            await this._notify(msg);
            return { ok: false, message: msg };
        }
    }

    async _assertGithubAccess(repo, branch) {
        try {
            const { data } = await this._githubRequest(
                'GET',
                `https://api.github.com/repos/${repo}`,
                { timeout: 20_000 }
            );
            if (data.permissions && data.permissions.push === false) {
                throw Object.assign(new Error('Token cannot push to this repo'), {
                    response: {
                        status: 403,
                        data: { message: 'Token lacks push permission on repository' },
                    },
                });
            }
            // Admin delete-repo permission is irrelevant — we never call delete APIs
            logger.info(`GitHub access OK: ${repo} (push=${data.permissions?.push})`);
        } catch (err) {
            if (err.response?.status === 404) {
                throw Object.assign(
                    new Error(
                        `Repo not found or token has no access. Set GITHUB_REPO=officeboy12242/WA-BOT ` +
                            `(not just "officeboy"). Current: ${repo}`
                    ),
                    { response: err.response }
                );
            }
            throw err;
        }

        // Confirm branch exists
        try {
            await this._githubRequest(
                'GET',
                `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(branch)}`,
                { timeout: 20_000 }
            );
        } catch (err) {
            if (err.response?.status === 404) {
                throw Object.assign(
                    new Error(`Branch "${branch}" not found on ${repo}. Set GITHUB_BRANCH=main`),
                    { response: err.response }
                );
            }
            throw err;
        }
    }

    _formatGithubError(err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const ghMsg = body?.message || body?.error || err.message;
        const repo = this.getGithubRepo();
        if (status === 401) {
            return `GitHub 401 — invalid/expired token. Update GITHUB_TOKEN on Render. (${ghMsg})`;
        }
        if (status === 403) {
            return (
                `GitHub 403 — token needs *Contents: Read and write* on \`${repo}\`.\n` +
                `For fine-grained PAT: Repository access → only select WA-BOT → Permissions → Contents: Read and write.\n` +
                `(${ghMsg})`
            );
        }
        if (status === 404) {
            return (
                `GitHub 404 — cannot access \`${repo}\`.\n` +
                `On Render set exactly:\n` +
                `• GITHUB_REPO=\`officeboy12242/WA-BOT\`\n` +
                `• GITHUB_BRANCH=\`main\`\n` +
                `• GITHUB_TOKEN= classic PAT with *repo* scope, or fine-grained with Contents R/W\n` +
                `(${ghMsg})`
            );
        }
        if (status === 409 || status === 422) {
            return `GitHub ${status} — file conflict (branch moved). Run /fix again. (${ghMsg})`;
        }
        return status ? `GitHub ${status}: ${ghMsg}` : String(ghMsg || err.message);
    }

    async _githubHeaders() {
        const token = this.getGithubToken();
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'WA-BOT-summary-self-heal',
        };
    }

    /**
     * SECURITY: only GET/PUT on allowlisted repo endpoints.
     * Never DELETE the repository or any other destructive GitHub API.
     */
    _assertSafeGithubUrl(method, url) {
        const m = String(method || '').toUpperCase();
        if (!GITHUB_ALLOWED_METHODS.has(m)) {
            throw new Error(
                `🚫 Security block: GitHub method ${m} is forbidden (repo delete/wipe disabled)`
            );
        }
        if (m === 'DELETE') {
            throw new Error('🚫 Security block: DELETE is never allowed (cannot delete repo or files)');
        }

        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error('🚫 Security block: invalid GitHub URL');
        }
        if (parsed.hostname !== 'api.github.com') {
            throw new Error('🚫 Security block: only api.github.com is allowed');
        }

        const repo = this.getGithubRepo();
        const repoPrefix = `/repos/${repo}`;
        const pathName = parsed.pathname;

        // Explicitly block repository delete endpoint and related destructive paths
        if (/\/repos\/[^/]+\/[^/]+\/?$/.test(pathName) && m !== 'GET') {
            throw new Error('🚫 Security block: cannot modify/delete the repository itself');
        }
        if (/\/(hooks|keys|collaborators|pages|actions|environments|vulnerability|secret|pages)\b/i.test(pathName)) {
            throw new Error('🚫 Security block: forbidden GitHub admin endpoint');
        }
        if (!pathName.startsWith(repoPrefix)) {
            throw new Error(`🚫 Security block: URL outside allowed repo ${repo}`);
        }

        const allowed =
            (m === 'GET' && (
                pathName === repoPrefix ||
                pathName === `${repoPrefix}/` ||
                pathName.startsWith(`${repoPrefix}/contents/`) ||
                pathName.startsWith(`${repoPrefix}/branches/`)
            )) ||
            (m === 'PUT' && pathName.startsWith(`${repoPrefix}/contents/`));

        if (!allowed) {
            throw new Error(`🚫 Security block: ${m} ${pathName} is not an allowed heal operation`);
        }
    }

    async _githubRequest(method, url, options = {}) {
        const m = String(method || 'GET').toUpperCase();
        this._assertSafeGithubUrl(m, url);
        const headers = { ...(await this._githubHeaders()), ...(options.headers || {}) };
        if (m === 'GET') {
            return axios.get(url, { ...options, headers, method: 'GET' });
        }
        if (m === 'PUT') {
            return axios.put(url, options.data, { ...options, headers, method: 'PUT' });
        }
        throw new Error(`🚫 Security block: method ${m} is not allowed`);
    }

    /** Never push empty/wiped files or mass-delete the tree. */
    _assertSafePushPayload(files) {
        if (!files?.length) {
            throw new Error('🚫 Security block: no files to push');
        }
        if (files.length > 12) {
            throw new Error('🚫 Security block: refusing to touch more than 12 files in one push');
        }
        for (const f of files) {
            const content = String(f.content ?? '');
            if (!f.path || (!this._isSafePath(f.path) && !SUMMARY_ALLOWED_FILES.includes(f.path))) {
                throw new Error(`🚫 Security block: unsafe path ${f.path}`);
            }
            if (!content.trim()) {
                throw new Error(
                    `🚫 Security block: refusing to wipe \`${f.path}\` (empty content = file delete)`
                );
            }
            if (content.trim().length < 15) {
                throw new Error(
                    `🚫 Security block: refusing near-empty \`${f.path}\` (possible wipe)`
                );
            }
        }
    }

    _contentsUrl(relPath) {
        const repo = this.getGithubRepo();
        // Encode each path segment but keep slashes as path separators
        const encoded = String(relPath || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter(Boolean)
            .map((s) => encodeURIComponent(s))
            .join('/');
        return `https://api.github.com/repos/${repo}/contents/${encoded}`;
    }

    /**
     * Fetch latest file from GitHub (source of truth for conflict-free push).
     * @returns {Promise<{ content: string, sha: string|null, exists: boolean }>}
     */
    async _fetchGithubFile(relPath) {
        const branch = this.getGithubBranch();
        const url = this._contentsUrl(relPath);
        try {
            const { data } = await this._githubRequest('GET', url, {
                params: { ref: branch },
                timeout: 30_000,
            });
            const content = Buffer.from(data.content || '', 'base64').toString('utf8');
            return { content, sha: data.sha || null, exists: true };
        } catch (err) {
            if (err.response?.status === 404) {
                return { content: '', sha: null, exists: false };
            }
            throw err;
        }
    }

    /**
     * Rebase proposal onto latest GitHub so Cursor pushes don't conflict.
     * @param {{ path: string, content: string, baseHash?: string, replacements?: {old_string:string,new_string:string}[] }} file
     */
    async _resolveContentAgainstGithub(file, onNote) {
        const note = typeof onNote === 'function' ? onNote : async () => {};
        const remote = await this._fetchGithubFile(file.path);

        // New file on remote
        if (!remote.exists) {
            await note(`  • new file on remote`);
            return { content: file.content, sha: null, baseContent: '' };
        }

        const remoteHash = this._hashContent(remote.content);

        // Remote unchanged since proposal — safe to push proposed content
        if (file.baseHash && remoteHash === file.baseHash) {
            await note(`  • remote unchanged — direct push`);
            return { content: file.content, sha: remote.sha, baseContent: remote.content };
        }

        // Remote already equals our proposal (maybe we pushed before)
        if (remoteHash === this._hashContent(file.content)) {
            await note(`  • remote already has our changes — skip`);
            return { content: file.content, sha: remote.sha, baseContent: remote.content };
        }

        // Rebase: apply stored replacements onto latest remote
        const reps = Array.isArray(file.replacements) ? file.replacements : [];
        if (reps.length) {
            let next = remote.content;
            let applied = 0;
            for (const rep of reps) {
                if (rep.old_string && next.includes(rep.old_string)) {
                    next = next.replace(rep.old_string, rep.new_string ?? '');
                    applied += 1;
                }
            }
            if (applied === reps.length) {
                await note(`  • rebased ${applied} patch(es) onto latest remote`);
                return { content: next, sha: remote.sha, baseContent: remote.content };
            }
            await note(`  • rebase partial (${applied}/${reps.length}) — using best effort`);
            if (applied > 0) {
                return { content: next, sha: remote.sha, baseContent: remote.content };
            }
        }

        // Full rewrite proposals: if remote diverged, refuse to overwrite blindly
        throw new Error(
            `\`${file.path}\` changed on GitHub since the proposal (Cursor or another push).\n` +
                `_Run /fix again on latest code — nothing was pushed._`
        );
    }

    async _pushFileToGitHub(relPath, content, message, knownSha = undefined) {
        // Final hard stop: never wipe a file (GitHub file-delete uses empty/delete APIs)
        if (!String(content || '').trim() || String(content).trim().length < 20) {
            throw new Error(`🚫 Security block: refusing to push empty/wiped \`${relPath}\``);
        }

        const branch = this.getGithubBranch();
        const url = this._contentsUrl(relPath);

        let sha = knownSha;
        if (sha === undefined) {
            try {
                const { data } = await this._githubRequest('GET', url, {
                    params: { ref: branch },
                    timeout: 30_000,
                });
                sha = data.sha;
            } catch (err) {
                if (err.response?.status !== 404) {
                    throw err;
                }
                sha = null;
            }
        }

        const body = {
            message,
            content: Buffer.from(content, 'utf8').toString('base64'),
            branch,
            ...(sha ? { sha } : {}),
        };

        try {
            await this._githubRequest('PUT', url, { data: body, timeout: 60_000 });
        } catch (err) {
            // Retry with fresh SHA if someone pushed between sync and put
            if (err.response?.status === 409 || err.response?.status === 422) {
                const fresh = await this._fetchGithubFile(relPath);
                // If remote already matches, treat as success
                if (this._hashContent(fresh.content) === this._hashContent(content)) {
                    logger.info(`Self-heal ${relPath} already up to date on remote`);
                    return;
                }
                await this._githubRequest('PUT', url, {
                    data: {
                        message,
                        content: Buffer.from(content, 'utf8').toString('base64'),
                        branch,
                        ...(fresh.sha ? { sha: fresh.sha } : {}),
                    },
                    timeout: 60_000,
                });
            } else {
                throw err;
            }
        }
        logger.info(`Self-heal pushed ${relPath} to ${this.getGithubRepo()}@${branch}`);
    }

    async listPending() {
        if (!this._collection) return [];
        return this._collection.find({ status: 'pending' }).sort({ created_at: -1 }).limit(5).toArray();
    }
}

export default SummarySelfHealService;
