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
import { resolveNotificationJid, normalizePhoneNumber } from '../utils/permissions.js';

const execFileAsync = promisify(execFile);

const DEFAULT_HEAL_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const SUMMARY_ALLOWED_FILES = [
    'src/controllers/GroupSummaryController.js',
    'src/services/GroupChatLogService.js',
    'src/services/NvidiaDeepSeekService.js',
];

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
7. old_string must match the file EXACTLY (unique snippet).
8. Max 8 replacements total across all files.
9. Do not touch secrets, .env files, or auth sessions (config.js defaults are OK).
10. changelog must explain the proper approach (not "emptied function").
11. NEVER delete the GitHub repository, wipe the project, or empty critical files.
12. If you cannot do it safely, return files:[].`;

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
• Stopping schedulers when the flag is false (scheduler already no-ops if flag false — ensure flag is false by default)`;

const REPAIR_SYSTEM_PROMPT = `You repair a failed code patch. The previous patch failed validation or was incomplete/hacky.

Return ONLY valid JSON (no markdown fences) in this shape:
${JSON_SHAPE}

RULES:
• Fix the validation / completeness errors listed by the user.
• Prefer proper config-flag disable over gutting methods.
• old_string must match the provided file content exactly.
• Keep the owner's original intent.
• Preserve exports and public methods.`;

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
];

function shortId() {
    return crypto.randomBytes(3).toString('hex');
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
        this.nvidia = new NvidiaDeepSeekService(cfg);
        this._collection = null;
        this._sock = null;
        this._inflight = false;
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
        return (
            this.enabled &&
            this.nvidia.isConfigured() &&
            Boolean(this.getGithubToken()) &&
            Boolean(this._collection)
        );
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

    async _hasPendingOrRecent() {
        if (!this._collection) return true;
        const pending = await this._collection.findOne({ status: 'pending' });
        if (pending) return true;

        const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
        const recent = await this._collection.findOne({
            created_at: { $gte: since },
            status: { $in: ['pending', 'pushed', 'failed'] },
        });
        return Boolean(recent);
    }

    /**
     * Called when group summary LLM fails. Non-blocking.
     */
    triggerFromSummaryFailure({ groupName, dateStr, errorMessage, messageCount }) {
        if (!this.isReady()) {
            logger.info('Summary self-heal skipped (disabled or missing GITHUB_TOKEN / Mongo)');
            return;
        }
        if (this._inflight) {
            logger.info('Summary self-heal already running — skip');
            return;
        }

        void this._runHealCycle({ groupName, dateStr, errorMessage, messageCount });
    }

    async _runHealCycle(ctx) {
        this._inflight = true;
        try {
            if (await this._hasPendingOrRecent()) {
                logger.info('Summary self-heal: pending/recent proposal exists — skip');
                await this._notify(
                    `🔧 *Summary self-heal*\nSkipped new proposal (pending or recent heal exists).\n` +
                        `Issue: ${ctx.errorMessage}\nGroup: ${ctx.groupName || 'n/a'}`
                );
                return;
            }

            await this._notify(
                `🔧 *Summary issue detected*\n` +
                    `Group: *${ctx.groupName || 'unknown'}*\n` +
                    `Date: ${ctx.dateStr || 'n/a'}\n` +
                    `Msgs: ${ctx.messageCount ?? '?'}\n` +
                    `Error: ${String(ctx.errorMessage || '').slice(0, 300)}\n\n` +
                    `_Asking Nemotron for a summary-only fix…_`
            );

            const proposal = await this._generateProposal({
                mode: 'summary',
                allowedPaths: SUMMARY_ALLOWED_FILES,
                systemPrompt: SUMMARY_HEAL_SYSTEM_PROMPT,
                userPromptParts: [
                    'Summary/recap failure report:',
                    `Group: ${ctx.groupName}`,
                    `Date: ${ctx.dateStr}`,
                    `Message count: ${ctx.messageCount}`,
                    `Error: ${ctx.errorMessage}`,
                ],
            });
            if (!proposal?.files?.length) {
                await this._notify(
                    `🔧 *Summary self-heal*\nNemotron found no safe code change.\nIssue: ${ctx.errorMessage}`
                );
                return;
            }

            const healId = await this._storeProposal({
                source: 'auto_summary',
                instruction: `Auto-fix summary failure: ${ctx.errorMessage}`,
                group_name: ctx.groupName || '',
                recap_date: ctx.dateStr || '',
                error: String(ctx.errorMessage || '').slice(0, 1000),
                message_count: ctx.messageCount || 0,
                proposal,
            });

            await this._notifyOwnersOnly(this._formatProposalMessage(healId, proposal, {
                title: 'SUMMARY SELF-HEAL',
                context: `⚠️ Summary failed — AI proposed a fix.\n📌 *Issue:* ${String(ctx.errorMessage || '').slice(0, 200)}\n📢 *Group:* ${ctx.groupName || 'n/a'}`,
            }));
            logger.info(`Summary self-heal proposal ${healId} awaiting owner approval`);
        } catch (err) {
            logger.error(`Summary self-heal cycle failed: ${err.message}`);
            await this._notify(`🔧 *Summary self-heal error*\n${err.message}`).catch(() => {});
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
            if (!force && now - lastAt < 450) return;
            lastAt = now;
            const body = [
                `🔧 *${title}*`,
                '',
                ...lines.slice(-12),
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
                message: '❌ Self-heal not ready. Set `GITHUB_TOKEN` + Mongo + `NVIDIA_API_KEY` on Render.',
            };
        }
        if (this._inflight) {
            return { ok: false, message: '⏳ Another heal is running — try again in a minute.' };
        }

        const status = this._makeStatusTracker('AI FIX IN PROGRESS', onProgress);
        this._inflight = true;
        try {
            await status.step(`🗣️ *Instruction:* ${text.slice(0, 120)}`);
            await status.step('🧠 Planning complete fix (config-first, related files)…');
            await status.step('📂 Scanning `src/` for matching files…');

            const candidates = await this._pickCandidateFiles(text);
            if (!candidates.length) {
                return { ok: false, message: '❌ No matching source files found under `src/`.' };
            }

            await status.step(`📁 Candidates (${candidates.length}):`);
            for (const f of candidates) {
                await status.note(`  • \`${f}\``);
            }

            let proposal = await this._generateProposal({
                mode: 'instruction',
                allowedPaths: candidates,
                systemPrompt: INSTRUCTION_HEAL_SYSTEM_PROMPT,
                userPromptParts: [
                    `Owner instruction: ${text}`,
                    `Requested by: ${byPhone || 'owner'}`,
                    'Implement COMPLETELY and PROPERLY (config flags over gutting code).',
                    'Touch all related entry points. Keep feature reversible via config/env.',
                ],
                onProgress: (line) => status.step(line),
                instruction: text,
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
                message: `❌ Fix failed: ${err.message}${hint}\n_Tried models:_ ${this.healModels.join(' → ')}`,
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

    _formatProposalMessage(healId, proposal, { title, context }) {
        const fileList = proposal.files.map((f) => `• \`${f.path}\``).join('\n');
        const changes = (proposal.changelog || [])
            .slice(0, 8)
            .map((c) => `• ${c}`)
            .join('\n');
        const preview = proposal.changePreview
            ? `\n🔎 *Diff preview*\n${proposal.changePreview}\n`
            : '';

        return (
            `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
            `┃  🔧 *${title}* 🔧  ┃\n` +
            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
            `${context}\n\n` +
            `🧠 *Model:* ${proposal.usedModel || this.healModel}\n` +
            `📝 *Summary:* ${proposal.summary}\n\n` +
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
                    if (allSet.has(f)) forced.add(f);
                }
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
            const { content: raw, model } = await this.nvidia.completeWithModelFallback(
                this.healModels,
                COMPLETENESS_SYSTEM_PROMPT,
                userPrompt,
                { maxTokens: 2500, onProgress: progress }
            );
            const parsed = extractJsonObject(raw);
            if (parsed?.files?.length) {
                // Apply completeness patches on top of CURRENT patched content
                const applyBase = new Map(patchedView);
                const extra = this._applyParsedProposal(
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

        const { content: raw, model } = await this.nvidia.completeWithModelFallback(
            this.healModels,
            REPAIR_SYSTEM_PROMPT,
            userPrompt,
            { maxTokens: 2500, onProgress: progress }
        );

        const parsed = extractJsonObject(raw);
        if (!parsed) return null;

        // Apply repairs against ORIGINAL sources (safer)
        const result = this._applyParsedProposal(
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
                        `models: ${this.healModels.join(' → ')}`
                );

                const { content: raw, model: usedModel } = await this.nvidia.completeWithModelFallback(
                    this.healModels,
                    systemPrompt,
                    userPrompt,
                    { maxTokens: 2500, onProgress: progress }
                );

                await progress('🧩 Applying patches to files…');
                const parsed = extractJsonObject(raw);
                if (!parsed || !Array.isArray(parsed.files)) {
                    throw new Error('Heal model returned invalid JSON');
                }

                let result = this._applyParsedProposal(parsed, originals, new Set(pathList), progress);
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

    _applyParsedProposal(parsed, originals, allowed, onProgress) {
        const progress = typeof onProgress === 'function' ? onProgress : async () => {};
        const files = [];
        const appliedNotes = [];

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

            void progress(`✏️ Updating \`${rel}\`…`);

            if (typeof f.content === 'string' && f.content.length > 50) {
                // Full rewrite only if file is small enough to be trustworthy
                if (f.content.length < 25_000) {
                    next = f.content;
                    appliedNotes.push(`${rel}: full file rewrite`);
                    void progress(`  ✓ full rewrite \`${rel}\``);
                }
            } else if (Array.isArray(f.replacements)) {
                let applied = 0;
                for (const rep of f.replacements.slice(0, 4)) {
                    const oldStr = String(rep.old_string ?? rep.old ?? '');
                    const newStr = String(rep.new_string ?? rep.new ?? '');
                    if (!oldStr || oldStr === newStr) continue;
                    if (!next.includes(oldStr)) {
                        const loose = oldStr.trim();
                        if (loose && next.includes(loose)) {
                            next = next.replace(loose, newStr.trim());
                            appliedReplacements.push({ old_string: loose, new_string: newStr.trim() });
                            applied += 1;
                        } else {
                            logger.warn(`Self-heal old_string not found in ${rel}`);
                            void progress(`  ⚠️ patch miss in \`${rel}\``);
                            continue;
                        }
                    } else {
                        next = next.replace(oldStr, newStr);
                        appliedReplacements.push({ old_string: oldStr, new_string: newStr });
                        applied += 1;
                    }
                    const label = oldStr.trim().slice(0, 40).replace(/\n/g, ' ');
                    appliedNotes.push(`${rel}: replaced “${label}…”`);
                }
                if (!applied) continue;
                void progress(`  ✓ ${applied} patch(es) in \`${rel}\``);
            } else {
                continue;
            }

            if (next === baseContent) continue;
            // Never allow wiping a file (GitHub "delete file" equivalent)
            if (!String(next).trim() || String(next).trim().length < 20) {
                logger.warn(`Self-heal rejected wipe of ${rel}`);
                void progress(`  🚫 blocked wipe of \`${rel}\``);
                continue;
            }
            if (rel.includes('NvidiaDeepSeek') && !next.includes('completeTrade')) {
                logger.warn(`Self-heal rejected NvidiaDeepSeekService change that removes trade API`);
                void progress(`  ⛔ blocked unsafe change in \`${rel}\``);
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
            const msg =
                `✅ *Self-heal pushed*\n` +
                `🆔 ${id}\n` +
                (row.instruction ? `🗣️ *Asked:* ${row.instruction}\n` : '') +
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
