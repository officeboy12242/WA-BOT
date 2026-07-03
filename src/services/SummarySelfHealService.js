/**
 * Summary-only self-heal: Nemotron proposes a fix, owner approves, then GitHub push.
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
const ALLOWED_FILES = new Set([
    'src/controllers/GroupSummaryController.js',
    'src/services/GroupChatLogService.js',
    'src/services/NvidiaDeepSeekService.js',
]);

const HEAL_SYSTEM_PROMPT = `You are a senior Node.js engineer fixing WhatsApp group SUMMARY/RECAP bugs only.

You receive an error report and snippets of allowlisted source files.
Return ONLY valid JSON (no markdown fences) in this shape:
{
  "summary": "one-line description of the fix",
  "files": [
    {
      "path": "src/services/GroupChatLogService.js",
      "replacements": [
        { "old_string": "exact existing code block", "new_string": "replacement code block" }
      ]
    }
  ]
}

RULES:
• Only touch summary/recap reliability (timeouts, empty topics, JSON parse, chunking, prompts).
• Do NOT change trade alerts, movies, stickers, or unrelated features.
• path must be one of:
  - src/controllers/GroupSummaryController.js
  - src/services/GroupChatLogService.js
  - src/services/NvidiaDeepSeekService.js
• old_string must match the file EXACTLY (unique snippet, include enough context).
• Prefer small, safe fixes: shorter prompts, better retries, heuristic topics, resilient chunk merge.
• Keep existing exports and public method names.
• Max 4 replacements total across all files.
• If no code change is needed, return {"summary":"no change","files":[]}`;

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

    isReady() {
        return (
            this.enabled &&
            this.nvidia.isConfigured() &&
            Boolean(this.githubToken) &&
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

            const proposal = await this._generateProposal(ctx);
            if (!proposal?.files?.length) {
                await this._notify(
                    `🔧 *Summary self-heal*\nNemotron found no safe code change.\nIssue: ${ctx.errorMessage}`
                );
                return;
            }

            const healId = shortId();
            await this._collection.insertOne({
                heal_id: healId,
                status: 'pending',
                group_name: ctx.groupName || '',
                recap_date: ctx.dateStr || '',
                error: String(ctx.errorMessage || '').slice(0, 1000),
                message_count: ctx.messageCount || 0,
                summary: proposal.summary,
                files: proposal.files,
                model: this.healModel,
                created_at: new Date(),
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });

            const fileList = proposal.files.map((f) => `• \`${f.path}\``).join('\n');
            await this._notifyOwnersOnly(
                `┏━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\n` +
                    `┃  🔧 *SUMMARY SELF-HEAL* 🔧  ┃\n` +
                    `┗━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n\n` +
                    `⚠️ Summary failed — AI proposed a fix.\n\n` +
                    `📌 *Issue:* ${String(ctx.errorMessage || '').slice(0, 200)}\n` +
                    `📢 *Group:* ${ctx.groupName || 'n/a'}\n` +
                    `🧠 *Model:* ${this.healModel}\n` +
                    `📝 *Fix:* ${proposal.summary}\n\n` +
                    `📁 *Files:*\n${fileList}\n\n` +
                    `🆔 Heal ID: *${healId}*\n\n` +
                    `Reply as *owner*:\n` +
                    `✅ \`/heal approve ${healId}\` — push to GitHub\n` +
                    `❌ \`/heal reject ${healId}\` — discard\n\n` +
                    `_Nothing is pushed until you approve._`
            );
            logger.info(`Summary self-heal proposal ${healId} awaiting owner approval`);
        } catch (err) {
            logger.error(`Summary self-heal cycle failed: ${err.message}`);
            await this._notify(`🔧 *Summary self-heal error*\n${err.message}`).catch(() => {});
        } finally {
            this._inflight = false;
        }
    }

    async _generateProposal(ctx) {
        const originals = new Map();
        const filePayload = [];
        for (const rel of ALLOWED_FILES) {
            try {
                const content = await this._readLocalFile(rel);
                originals.set(rel, content);
                // Send focused tails/heads for large files to keep prompt small
                const snippet =
                    content.length > 18_000
                        ? `${content.slice(0, 9000)}\n\n/* ... middle omitted ... */\n\n${content.slice(-9000)}`
                        : content;
                filePayload.push({ path: rel, content: snippet });
            } catch (err) {
                logger.warn(`Self-heal could not read ${rel}: ${err.message}`);
            }
        }

        const userPrompt = [
            'Summary/recap failure report:',
            `Group: ${ctx.groupName}`,
            `Date: ${ctx.dateStr}`,
            `Message count: ${ctx.messageCount}`,
            `Error: ${ctx.errorMessage}`,
            '',
            'Allowlisted source (may be truncated — old_string must still match exactly):',
            ...filePayload.map((f) => `\n===== FILE: ${f.path} =====\n${f.content}`),
            '',
            'Return JSON with precise replacements only.',
        ].join('\n');

        const previousModel = this.nvidia.model;
        this.nvidia.model = this.healModel;
        let raw;
        try {
            raw = await this.nvidia.complete(HEAL_SYSTEM_PROMPT, userPrompt, {
                maxTokens: 4000,
                timeoutMs: 120_000,
            });
        } finally {
            this.nvidia.model = previousModel;
        }

        const parsed = extractJsonObject(raw);
        if (!parsed || !Array.isArray(parsed.files)) {
            throw new Error('Heal model returned invalid JSON');
        }

        const files = [];
        for (const f of parsed.files) {
            const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
            if (!ALLOWED_FILES.has(rel)) {
                logger.warn(`Self-heal rejected non-allowlisted path: ${rel}`);
                continue;
            }

            let next = originals.get(rel);
            if (!next) continue;

            // Full-file override (rare)
            if (typeof f.content === 'string' && f.content.length > 50 && f.content.includes('export')) {
                next = f.content;
            } else if (Array.isArray(f.replacements)) {
                let applied = 0;
                for (const rep of f.replacements.slice(0, 4)) {
                    const oldStr = String(rep.old_string || rep.old || '');
                    const newStr = String(rep.new_string || rep.new || '');
                    if (!oldStr || oldStr === newStr) continue;
                    if (!next.includes(oldStr)) {
                        logger.warn(`Self-heal old_string not found in ${rel}`);
                        continue;
                    }
                    next = next.replace(oldStr, newStr);
                    applied += 1;
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

        return {
            summary: String(parsed.summary || 'Summary reliability fix').slice(0, 200),
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
        if (!row) return { ok: false, message: `No heal proposal \`${id}\`` };
        if (row.status !== 'pending') {
            return { ok: false, message: `Heal \`${id}\` is already *${row.status}*` };
        }
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
            await this._collection.updateOne({ heal_id: id }, { $set: { status: 'expired' } });
            return { ok: false, message: `Heal \`${id}\` expired. Run summary again to regenerate.` };
        }
        if (!this.githubToken) {
            return { ok: false, message: '❌ `GITHUB_TOKEN` is not set on the server.' };
        }

        await this._notify(`🔧 Owner approved heal *${id}* — pushing to GitHub…`);

        try {
            const pushed = [];
            for (const file of row.files || []) {
                await this._pushFileToGitHub(file.path, file.content, `fix(summary): ${row.summary} [${id}]`);
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

            const msg =
                `✅ *Summary self-heal pushed*\n` +
                `🆔 ${id}\n` +
                `📝 ${row.summary}\n` +
                `📁 ${pushed.join(', ')}\n` +
                `🌿 ${this.githubRepo}@${this.githubBranch}\n` +
                `_Render will redeploy from main._`;
            await this._notify(msg);
            return { ok: true, message: msg };
        } catch (err) {
            await this._collection.updateOne(
                { heal_id: id },
                { $set: { status: 'failed', error_push: err.message, failed_at: new Date() } }
            );
            const msg = `❌ Heal push failed for *${id}*: ${err.message}`;
            await this._notify(msg);
            return { ok: false, message: msg };
        }
    }

    async _githubHeaders() {
        return {
            Authorization: `Bearer ${this.githubToken}`,
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
            if (err.response?.status !== 404) throw err;
        }

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
        logger.info(`Self-heal pushed ${relPath} to ${this.githubRepo}@${this.githubBranch}`);
    }

    async listPending() {
        if (!this._collection) return [];
        return this._collection.find({ status: 'pending' }).sort({ created_at: -1 }).limit(5).toArray();
    }
}

export default SummarySelfHealService;
