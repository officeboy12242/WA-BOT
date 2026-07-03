/**
 * Self-heal: Nemotron proposes code fixes (auto summary issues or owner /fix).
 * Owner must approve before GitHub push.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import NvidiaDeepSeekService from './NvidiaDeepSeekService.js';
import { resolveNotificationJid, normalizePhoneNumber } from '../utils/permissions.js';

const DEFAULT_HEAL_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const SUMMARY_ALLOWED_FILES = [
    'src/controllers/GroupSummaryController.js',
    'src/services/GroupChatLogService.js',
    'src/services/NvidiaDeepSeekService.js',
];

const BLOCKED_PATH_PARTS = ['.env', 'node_modules', 'auth_info', 'credentials', '.git'];

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

const INSTRUCTION_HEAL_SYSTEM_PROMPT = `You are a senior Node.js engineer for a WhatsApp bot (Baileys, ESM).

The owner gives a natural-language fix instruction. Apply ONLY that request.

Return ONLY valid JSON (no markdown fences) in this shape:
${JSON_SHAPE}

RULES:
• Only edit files under src/ that are provided below.
• old_string must match the file EXACTLY (include enough context to be unique).
• new_string is the replacement (use "" to delete a block).
• Prefer minimal diffs — do not refactor unrelated code.
• changelog: short bullets of what you changed (for the owner to review).
• Max 6 replacements total across all files.
• Do not touch secrets, .env, or auth sessions.
• If the instruction cannot be done safely with the given files, return files:[].`;

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
        // Fallback chain if Nemotron times out / is unavailable
        this.healModels = [
            ...new Set(
                [
                    cfg.NVIDIA_HEAL_MODEL || DEFAULT_HEAL_MODEL,
                    cfg.NVIDIA_TRADE_MODEL || 'z-ai/glm-5.2',
                    cfg.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-flash',
                ].filter(Boolean)
            ),
        ];
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
     * Owner-driven fix: `/fix remove testing thing`
     * @param {string} instruction
     * @param {{ byPhone?: string }} [opts]
     * @returns {Promise<{ ok: boolean, message: string, healId?: string }>}
     */
    async proposeFromInstruction(instruction, { byPhone = '' } = {}) {
        const text = String(instruction || '').trim();
        if (!text) {
            return { ok: false, message: '❌ Usage: `/fix <what to change>`\nExample: `/fix remove testing thing`' };
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

        this._inflight = true;
        try {
            const candidates = await this._pickCandidateFiles(text);
            if (!candidates.length) {
                return { ok: false, message: '❌ No matching source files found under `src/`.' };
            }

            const proposal = await this._generateProposal({
                mode: 'instruction',
                allowedPaths: candidates,
                systemPrompt: INSTRUCTION_HEAL_SYSTEM_PROMPT,
                userPromptParts: [
                    `Owner instruction: ${text}`,
                    `Requested by: ${byPhone || 'owner'}`,
                    'Apply ONLY this instruction. List every change in changelog.',
                ],
            });

            if (!proposal?.files?.length) {
                return {
                    ok: false,
                    message:
                        `❌ Nemotron could not apply that safely with the available files.\n` +
                        `_Tried:_ ${candidates.slice(0, 6).join(', ')}`,
                };
            }

            const healId = await this._storeProposal({
                source: 'owner_fix',
                instruction: text,
                requested_by: byPhone,
                proposal,
            });

            const preview = this._formatProposalMessage(healId, proposal, {
                title: 'OWNER /FIX PROPOSAL',
                context: `🗣️ *You asked:* ${text}`,
            });

            await this._notify(preview);
            return { ok: true, message: preview, healId };
        } catch (err) {
            logger.error(`Owner /fix failed: ${err.message}`);
            const hint = /timeout|ETIMEDOUT/i.test(err.message)
                ? '\n_NVIDIA timed out — try a shorter instruction (e.g. one file/area)._'
                : /429|overloaded/i.test(err.message)
                  ? '\n_NVIDIA is busy — wait 1–2 min and retry._'
                  : '';
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
            files: row.proposal.files,
            model: this.healModel,
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
            `🧠 *Model:* ${this.healModel}\n` +
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
        const words = String(instruction)
            .toLowerCase()
            .split(/[^a-z0-9_/.-]+/)
            .filter((w) => w.length > 2);

        const scored = [];
        for (const rel of all) {
            let score = 0;
            const low = rel.toLowerCase();
            for (const w of words) {
                if (low.includes(w)) score += 5;
            }
            // Prefer likely areas from instruction keywords
            if (/test|debug|temp|todo|mock/i.test(instruction) && /test|debug|temp|mock/i.test(low)) {
                score += 8;
            }
            if (/summary|recap/i.test(instruction) && /summary|groupchat|nvidia/i.test(low)) score += 8;
            if (/trade|stock|alert/i.test(instruction) && /trade|market|stock/i.test(low)) score += 8;
            if (/movie|zip/i.test(instruction) && /movie|hdhub/i.test(low)) score += 8;

            if (score > 0) scored.push({ rel, score });
        }

        scored.sort((a, b) => b.score - a.score);

        // Content-scan only top path matches (avoid reading entire repo)
        for (const row of scored.slice(0, 10)) {
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
        // Keep payload small so NVIDIA does not time out
        let picks = scored.slice(0, 4).map((s) => s.rel);

        // Fallback: common entrypoints if no keyword match
        if (!picks.length) {
            picks = [
                'src/controllers/GroupSummaryController.js',
                'src/services/GroupChatLogService.js',
                'src/commands/registry.js',
                'src/controllers/CommandController.js',
            ].filter((p) => all.includes(p));
        }

        return picks.slice(0, 4);
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

    async _generateProposal({ allowedPaths, systemPrompt, userPromptParts }) {
        const pathList = allowedPaths.slice(0, 4);
        const originals = new Map();
        const filePayload = [];
        for (const rel of pathList) {
            if (!this._isSafePath(rel) && !SUMMARY_ALLOWED_FILES.includes(rel)) continue;
            try {
                const content = await this._readLocalFile(rel);
                originals.set(rel, content);
                // Small snippets — large prompts are the main NVIDIA timeout cause
                const snippet =
                    content.length > 8_000
                        ? `${content.slice(0, 4000)}\n\n/* ... middle omitted ... */\n\n${content.slice(-4000)}`
                        : content;
                filePayload.push({ path: rel, content: snippet });
            } catch (err) {
                logger.warn(`Self-heal could not read ${rel}: ${err.message}`);
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

        // Attempt 1: all candidates. Attempt 2: top 2 files only if model fails / bad JSON
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
                logger.info(
                    `Self-heal LLM call (${payload.length} file(s), ${userPrompt.length} chars), ` +
                        `models: ${this.healModels.join(' → ')}`
                );

                const raw = await this.nvidia.completeWithModelFallback(
                    this.healModels,
                    systemPrompt,
                    userPrompt,
                    { maxTokens: 2500 }
                );

                const parsed = extractJsonObject(raw);
                if (!parsed || !Array.isArray(parsed.files)) {
                    throw new Error('Heal model returned invalid JSON');
                }

                const result = this._applyParsedProposal(parsed, originals, new Set(pathList));
                if (!result.files.length) {
                    throw new Error('Heal model returned no applicable replacements');
                }
                return result;
            } catch (err) {
                lastErr = err;
                logger.warn(`Self-heal proposal attempt ${p + 1} failed: ${err.message}`);
            }
        }

        throw lastErr || new Error('Heal proposal failed');
    }

    _applyParsedProposal(parsed, originals, allowed) {
        const files = [];
        const appliedNotes = [];

        for (const f of parsed.files || []) {
            const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
            if (!allowed.has(rel) || (!this._isSafePath(rel) && !SUMMARY_ALLOWED_FILES.includes(rel))) {
                logger.warn(`Self-heal rejected path: ${rel}`);
                continue;
            }

            let next = originals.get(rel);
            if (!next) continue;

            if (typeof f.content === 'string' && f.content.length > 50) {
                // Full rewrite only if file is small enough to be trustworthy
                if (f.content.length < 25_000) {
                    next = f.content;
                    appliedNotes.push(`${rel}: full file rewrite`);
                }
            } else if (Array.isArray(f.replacements)) {
                let applied = 0;
                for (const rep of f.replacements.slice(0, 4)) {
                    const oldStr = String(rep.old_string ?? rep.old ?? '');
                    const newStr = String(rep.new_string ?? rep.new ?? '');
                    if (!oldStr || oldStr === newStr) continue;
                    if (!next.includes(oldStr)) {
                        // Try a looser match: trim and collapse whitespace once
                        const loose = oldStr.trim();
                        if (loose && next.includes(loose)) {
                            next = next.replace(loose, newStr.trim());
                            applied += 1;
                        } else {
                            logger.warn(`Self-heal old_string not found in ${rel}`);
                            continue;
                        }
                    } else {
                        next = next.replace(oldStr, newStr);
                        applied += 1;
                    }
                    const label = oldStr.trim().slice(0, 40).replace(/\n/g, ' ');
                    appliedNotes.push(`${rel}: replaced “${label}…”`);
                }
                if (!applied) continue;
            } else {
                continue;
            }

            if (next === originals.get(rel)) continue;
            if (rel.includes('NvidiaDeepSeek') && !next.includes('completeTrade')) {
                logger.warn(`Self-heal rejected NvidiaDeepSeekService change that removes trade API`);
                continue;
            }
            files.push({ path: rel, content: next });
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

    async approveAndPush(healId, byPhone = '') {
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
        if (!token) {
            return {
                ok: false,
                message:
                    '❌ `GITHUB_TOKEN` is not set on the server.\n' +
                    '_Add it on Render → Environment, then restart the service._',
            };
        }
        // Keep in-memory copy in sync for push helper
        this.githubToken = token;

        await this._notify(`🔧 Owner approved heal *${id}* — pushing to GitHub…`);

        try {
            const pushed = [];
            for (const file of row.files || []) {
                const commitMsg = row.instruction
                    ? `fix: ${String(row.instruction).slice(0, 72)} [${id}]`
                    : `fix(summary): ${row.summary} [${id}]`;
                await this._pushFileToGitHub(file.path, file.content, commitMsg);
                pushed.push(file.path);
            }

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
                `🌿 ${this.githubRepo}@${this.githubBranch}\n` +
                `_Render will redeploy from main._`;
            await this._notify(msg);
            return { ok: true, message: msg };
        } catch (err) {
            const detail = this._formatGithubError(err);
            await this._collection.updateOne(
                { heal_id: id },
                { $set: { status: 'failed', error_push: detail, failed_at: new Date() } }
            );
            const msg = `❌ Heal push failed for *${id}*:\n${detail}`;
            await this._notify(msg);
            return { ok: false, message: msg };
        }
    }

    _formatGithubError(err) {
        const status = err.response?.status;
        const body = err.response?.data;
        const ghMsg = body?.message || body?.error || err.message;
        if (status === 401) {
            return `GitHub 401 — invalid/expired token. Update GITHUB_TOKEN on Render. (${ghMsg})`;
        }
        if (status === 403) {
            return `GitHub 403 — token needs Contents: Read and Write on ${this.githubRepo}. (${ghMsg})`;
        }
        if (status === 404) {
            return `GitHub 404 — repo/path not found or token lacks access to ${this.githubRepo}. (${ghMsg})`;
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

    async _pushFileToGitHub(relPath, content, message) {
        const url = `https://api.github.com/repos/${this.githubRepo}/contents/${relPath}`;
        const headers = await this._githubHeaders();

        let sha;
        try {
            const { data } = await axios.get(url, {
                headers,
                params: { ref: this.githubBranch },
                timeout: 30_000,
            });
            sha = data.sha;
        } catch (err) {
            if (err.response?.status !== 404) {
                throw err;
            }
        }

        try {
            await axios.put(
                url,
                {
                    message,
                    content: Buffer.from(content, 'utf8').toString('base64'),
                    branch: this.githubBranch,
                    ...(sha ? { sha } : {}),
                },
                { headers, timeout: 60_000 }
            );
        } catch (err) {
            // Retry once if SHA conflict
            if (err.response?.status === 409 || err.response?.status === 422) {
                const { data } = await axios.get(url, {
                    headers,
                    params: { ref: this.githubBranch },
                    timeout: 30_000,
                });
                await axios.put(
                    url,
                    {
                        message,
                        content: Buffer.from(content, 'utf8').toString('base64'),
                        branch: this.githubBranch,
                        sha: data.sha,
                    },
                    { headers, timeout: 60_000 }
                );
            } else {
                throw err;
            }
        }
        logger.info(`Self-heal pushed ${relPath} to ${this.githubRepo}@${this.githubBranch}`);
    }

    async listPending() {
        if (!this._collection) return [];
        return this._collection.find({ status: 'pending' }).sort({ created_at: -1 }).limit(5).toArray();
    }
}

export default SummarySelfHealService;
