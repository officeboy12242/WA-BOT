/**
 * /birthday — group birthday wishes with a personal LLM touch.
 *
 * Members (or admins) add birthdays with `/birthday add DD-MM` (year optional).
 * Every day at BIRTHDAY_TIME (IST, default 09:07) the scheduler checks today's
 * birthdays in enabled groups and posts an LLM-written wish tagging the person,
 * falling back to a template wish if every provider is rate-limited. Once per
 * birthday per group per year — stored in Mongo, so redeploys never double-post.
 */

import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';
import { isGroupMessage, extractPhoneNumber } from '../utils/permissions.js';
import { indexParticipantsByDigits, resolveMentionIdentity } from '../utils/welcomeMessage.js';
import AssistLlmRouter from './AssistLlmRouter.js';

const TZ = 'Asia/Kolkata';

/** 'DD-MM' (or 'DD-MM-YYYY') → { dd, mm } or null. */
export function parseBirthdayDate(raw) {
    const m = /^\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})(?:\s*[-\/.]\s*\d{2,4})?\s*$/.exec(String(raw || ''));
    if (!m) return null;
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
    return { dd, mm };
}

/** Today's 'DD-MM' in IST. */
export function todayDdMmIST(fromMs = Date.now()) {
    const p = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ,
        day: '2-digit',
        month: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(fromMs));
    const get = (t) => p.find((x) => x.type === t)?.value;
    return `${get('day')}-${get('month')}`;
}

/** IST day key for once-per-day scheduling. */
export function istDayKey(fromMs = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(
        new Date(fromMs)
    );
}

/** Minutes until the next HH:MM IST. */
export function msUntilIST(hour, minute, fromMs = Date.now()) {
    for (let addMin = 0; addMin <= 48 * 60; addMin++) {
        const p = new Intl.DateTimeFormat('en-GB', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(fromMs + addMin * 60_000));
        const [h, m] = p.split(':').map(Number);
        if (h === hour && m === minute) return Math.max(addMin, 1) * 60_000;
    }
    return 24 * 60 * 60 * 1000;
}

const SYSTEM_PROMPT = [
    'You write short, warm, funny WhatsApp birthday wishes for members of a students\' tech group.',
    'Rules: max 40 words, no emojis walls (max 3 emojis), no hashtag spam, no quotes or poems.',
    'Make it feel personal to a coding student — light tech/coding wordplay is welcome.',
    'Reply with ONLY the wish text, nothing else.',
].join('\n');

/** Target {hour, minute} from config, with safe defaults. */
export function wishWindowTarget(cfg = config) {
    const [h, m] = String(cfg?.BIRTHDAY_TIME || '09:07').split(':').map(Number);
    return {
        hour: Number.isFinite(h) ? h : 9,
        minute: Number.isFinite(m) ? m : 7,
    };
}

/** Current {hour, minute} in IST. */
export function istHourMinute(fromMs = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(new Date(fromMs));
    const [hour, minute] = parts.split(':').map(Number);
    return { hour, minute };
}

/** True when now is at/after the target time on the IST clock. */
export function inWishWindow(target, now = istHourMinute()) {
    const targetMin = target.hour * 60 + target.minute;
    const nowMin = now.hour * 60 + now.minute;
    return nowMin >= targetMin;
}

const FALLBACK_WISH = (name) =>
    `🎂 Happy Birthday, *${name}*! 🎉\n` +
    `May your code compile on the first try today and your bugs be easy finds.\n` +
    `_— your friends here_`;

export default class BirthdayService {
    constructor({ mongoDb, groupManager, cfg = config } = {}) {
        this.cfg = cfg;
        this.groupManager = groupManager;
        this.mongoDb = mongoDb || null;
        this.col = null;
        this.wishesCol = null;
        this.llm = new AssistLlmRouter(cfg);
        this._timer = null;
        this._stopped = false;
    }

    async init() {
        if (!this.mongoDb) return;
        this.col = this.mongoDb.collection('group_birthdays');
        this.wishesCol = this.mongoDb.collection('birthday_wishes_sent');
        await Promise.all([
            this.col.createIndex({ group_id: 1, phone: 1 }, { unique: true, name: 'bday_group_phone' }),
            this.col.createIndex({ group_id: 1, dd: 1, mm: 1 }, { name: 'bday_group_date' }),
            this.wishesCol.createIndex({ group_id: 1, phone: 1, year: 1 }, { unique: true, name: 'bday_wish_once' }),
        ]);
        logger.info('Birthday service ready');
    }

    isConfigured() {
        return this.cfg.BIRTHDAY_ENABLED !== false;
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    /** @returns {Promise<{ ok: boolean, message: string }>} */
    async addBirthday({ groupId, senderJid, rawDate, phoneOverride = null }) {
        const parsed = parseBirthdayDate(rawDate);
        if (!parsed) {
            return {
                ok: false,
                message: '📅 Send it like *`/birthday add 14-11`* (day-month). Year optional: `/birthday add 14-11-2004`.',
            };
        }
        const phone = phoneOverride || extractPhoneNumber(senderJid);
        if (!phone) return { ok: false, message: 'Could not read your number from this chat.' };
        try {
            await this.col.updateOne(
                { group_id: groupId, phone: String(phone) },
                {
                    $set: {
                        dd: parsed.dd,
                        mm: parsed.mm,
                        added_by: String(senderJid || ''),
                        updated_at: new Date(),
                    },
                    $setOnInsert: { created_at: new Date() },
                },
                { upsert: true }
            );
            return {
                ok: true,
                message:
                    `🎂 Saved! Your birthday is set to *${String(parsed.dd).padStart(2, '0')}-${String(parsed.mm).padStart(2, '0')}* in this group.\n` +
                    `You'll get a tagged wish on the day 🎉`,
            };
        } catch (err) {
            logger.error(`Birthday add failed: ${err.message}`);
            return { ok: false, message: 'Could not save that right now — try again in a bit.' };
        }
    }

    async removeBirthday(groupId, phone) {
        const res = await this.col.deleteOne({ group_id: groupId, phone: String(phone) });
        return res.deletedCount > 0
            ? { ok: true, message: '✅ Birthday removed. No more wishes from me. 🥲' }
            : { ok: false, message: 'You had no birthday saved here. `/birthday add DD-MM` to add one.' };
    }

    async listBirthdays(groupId) {
        return this.col
            .find({ group_id: groupId }, { projection: { _id: 0, phone: 1, dd: 1, mm: 1 } })
            .sort({ mm: 1, dd: 1 })
            .toArray();
    }

    // ── Daily scheduler ─────────────────────────────────────────────────────

    /** @param {{ getSock?: () => object }} [opts] socket is resolved lazily (boot order). */
    start(opts = {}) {
        if (!this.isConfigured()) {
            logger.info('🎂 Birthday wishes disabled');
            return;
        }
        this._getSock = typeof opts.getSock === 'function' ? opts.getSock : null;
        const scheduleNext = () => {
            if (this._stopped) return;
            const [h, m] = String(this.cfg.BIRTHDAY_TIME || '09:07').split(':').map(Number);
            const hour = Number.isFinite(h) ? h : 9;
            const minute = Number.isFinite(m) ? m : 7;
            const delay = msUntilIST(hour, minute);
            const nextAt = new Date(Date.now() + delay).toLocaleString('en-IN', {
                timeZone: TZ,
                dateStyle: 'medium',
                timeStyle: 'short',
            });
            logger.info(`🎂 Next birthday check at ${nextAt} (${TZ})`);
            this._timer = setTimeout(async () => {
                try {
                    await this.runDailyWishes();
                } catch (err) {
                    logger.error(`Birthday run failed: ${err.message}`);
                } finally {
                    scheduleNext();
                }
            }, delay);
        };
        scheduleNext();
        // Catch-up ticks: if the exact-time timer was missed (restart etc.), still
        // run today's wishes any time later the same day. Mongo dedupe keeps the
        // on-time timer and these ticks from double-posting.
        const tickMs = Math.max(1_000, Number(this.cfg.BIRTHDAY_CATCHUP_TICK_MS) || 10 * 60_000);
        this._catchup = setInterval(() => {
            if (this._stopped) return;
            void this._catchupTick();
        }, tickMs);
        void this._catchupTick();
    }

    stop() {
        this._stopped = true;
        if (this._timer) clearTimeout(this._timer);
        if (this._catchup) clearInterval(this._catchup);
    }

    async _catchupTick() {
        const target = wishWindowTarget(this.cfg);
        const now = istHourMinute();
        // Any time at/after the target time counts — late wishes beat missed days.
        if (!inWishWindow(target, now)) return;
        const lastKey = istDayKey();
        if (this._lastCatchupRun === lastKey) return;
        this._lastCatchupRun = lastKey;
        await this.runDailyWishes().catch((err) => {
            logger.error(`Birthday catch-up run failed: ${err.message}`);
        });
    }

    /**
     * Post wishes for today's birthdays in every enabled group. Once per
     * (group, phone, year) — Mongo-unique, so retries/restarts cannot double-post.
     */
    async runDailyWishes({ sock } = {}) {
        const s = sock || (typeof this._getSock === 'function' ? this._getSock() : null);
        if (!s) {
            logger.info('🎂 Birthday check: no WhatsApp socket yet');
            return { posted: 0, skipped: 0 };
        }
        const today = todayDdMmIST();
        const [dd, mm] = today.split('-').map(Number);
        const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));

        const rows = await this.col.find({ dd, mm }).toArray();
        if (!rows.length) {
            logger.info(`🎂 Birthday check ${today}: nobody today`);
            return { posted: 0, skipped: 0 };
        }

        // Group IDs from birthday docs; keep the bot's enabled-group check loose
        // (a saved birthday implies the group wants wishes).
        let posted = 0;
        let skipped = 0;
        const byGroup = new Map();
        for (const r of rows) byGroup.set(r.group_id, (byGroup.get(r.group_id) || []).concat(r));

        for (const [groupId, members] of byGroup) {
            const wishText = await this._generateWish(members);

            // Bare stored digits don't record whether they came from @s.whatsapp.net
            // or @lid — resolve against the group's live roster so the tag actually
            // lands on the member instead of printing unresolvable raw digits.
            let digitIndex = new Map();
            try {
                const meta = await this.groupManager?.getGroupMetadataCached?.(s, groupId);
                digitIndex = indexParticipantsByDigits(meta?.participants);
            } catch (err) {
                logger.debug(`Birthday wish: group metadata fetch failed for ${groupId}: ${err.message}`);
            }

            for (const member of members) {
                try {
                    const inserted = await this.wishesCol.insertOne({
                        group_id: groupId,
                        phone: String(member.phone),
                        year,
                        sent_at: new Date(),
                    }).then(() => true).catch((err) => {
                        if (err?.code === 11000) return false; // already wished this year
                        throw err;
                    });
                    if (!inserted) {
                        skipped++;
                        continue;
                    }
                    const participant = digitIndex.get(String(member.phone));
                    const tags = participant
                        ? resolveMentionIdentity(participant).mentions
                        : [`${member.phone}@s.whatsapp.net`];
                    await s.sendMessage(groupId, {
                        text: `${wishText}\n\n@${member.phone}`,
                        mentions: tags,
                    });
                    posted++;
                    // Explicit 0 must disable the gap (no `|| 700` — 0 is falsy).
                    const rawGap = this.cfg.BIRTHDAY_SEND_GAP_MS;
                    const gapMs =
                        rawGap === undefined || rawGap === null || rawGap === ''
                            ? 700
                            : Math.max(0, Number(rawGap) || 0);
                    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
                } catch (err) {
                    logger.warn(`Birthday wish failed for ${groupId}/${member.phone}: ${err.message}`);
                    // Roll back the marker so a later retry can still send it.
                    await this.wishesCol
                        .deleteOne({ group_id: groupId, phone: String(member.phone), year })
                        .catch(() => {});
                }
            }
        }
        logger.info(`🎂 Birthday wishes ${today}: ${posted} posted, ${skipped} already done`);
        return { posted, skipped };
    }

    /** One LLM wish per group day (all celebrants in one text), with template fallback. */
    async _generateWish(members) {
        const names = members.map((m) => `+${m.phone}`).join(', ');
        try {
            const { text } = await this.llm.completeChat({
                systemPrompt: SYSTEM_PROMPT,
                history: [],
                userBlock: `Write today's birthday wish for: ${names}. Use their phone-number style names lightly (or "birthday star"). One wish covering all of them.`,
                maxTokens: 120,
                temperature: 0.9,
                maxChars: 400,
            });
            return text.trim().slice(0, 380);
        } catch (err) {
            logger.warn(`Birthday LLM wish failed (template fallback): ${err.message}`);
            return FALLBACK_WISH(members.length === 1 ? '' : 'birthday star');
        }
    }
}
