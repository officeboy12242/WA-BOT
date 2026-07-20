/**
 * AI generation + WhatsApp poll/answer posting for Interview Q of the Day.
 */

import AssistLlmRouter from '../services/AssistLlmRouter.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/config.js';

export const INTERVIEW_CATEGORIES = [
    'DSA',
    'System Design',
    'Low-Level Design / OOP',
    'SQL',
    'Computer Fundamentals',
    'Debugging',
    'Code Output',
    'Language-Specific',
    'Behavioral',
    'Aptitude',
];

const SYSTEM_PROMPT = [
    'You generate one interview multiple-choice question for software engineers / students.',
    'Return JSON ONLY — no markdown fences, no prose outside JSON.',
    'Hard rules:',
    '- Exactly 4 options A–D.',
    '- Exactly one correctOption in A|B|C|D.',
    '- Do not put the answer in the question text.',
    '- Keep question + each option short enough for a WhatsApp poll (options under ~90 chars).',
    '- Include explanation, approach, and complexity when relevant (DSA/algorithms).',
    '- For Behavioral/Aptitude, timeComplexity/spaceComplexity may be empty strings.',
].join('\n');

function pickCategory(slotIndex = 0) {
    const day = Math.floor(Date.now() / 86_400_000);
    const idx = (day * 2 + Number(slotIndex || 0)) % INTERVIEW_CATEGORIES.length;
    return INTERVIEW_CATEGORIES[idx];
}

function extractJsonObject(raw) {
    const text = String(raw || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fenced?.[1] || text).trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) {
        throw new Error('No JSON object in AI response');
    }
    return JSON.parse(body.slice(start, end + 1));
}

/**
 * @param {object} parsed
 */
export function normalizeQuestion(parsed) {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Invalid question object');
    }

    const options = parsed.options || {};
    const A = String(options.A || '').trim();
    const B = String(options.B || '').trim();
    const C = String(options.C || '').trim();
    const D = String(options.D || '').trim();
    if (!A || !B || !C || !D) {
        throw new Error('Missing MCQ options A–D');
    }

    const correctOption = String(parsed.correctOption || '')
        .trim()
        .toUpperCase()
        .slice(0, 1);
    if (!['A', 'B', 'C', 'D'].includes(correctOption)) {
        throw new Error('Invalid correctOption');
    }

    const question = String(parsed.question || '').trim();
    if (question.length < 10) {
        throw new Error('Question too short');
    }

    const clip = (s, n) => String(s || '').trim().slice(0, n);

    return {
        type: clip(parsed.type || 'DSA', 40),
        difficulty: clip(parsed.difficulty || 'Medium', 16),
        topic: clip(parsed.topic || 'General', 60),
        question: clip(question, 400),
        options: {
            A: clip(A, 100),
            B: clip(B, 100),
            C: clip(C, 100),
            D: clip(D, 100),
        },
        correctOption,
        properAnswer: clip(parsed.properAnswer || parsed.options?.[correctOption] || '', 800),
        explanation: clip(parsed.explanation || '', 1200),
        hint: clip(parsed.hint || '', 300),
        approach: clip(parsed.approach || '', 800),
        timeComplexity: clip(parsed.timeComplexity || '', 40),
        spaceComplexity: clip(parsed.spaceComplexity || '', 40),
        commonMistake: clip(parsed.commonMistake || '', 400),
    };
}

export function formatAnswerMessage(q) {
    let text = '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    text += '✅ *ANSWER · Interview Q of the Day*\n';
    text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    text += `📌 *${q.type}* · ${q.difficulty} · ${q.topic}\n\n`;
    text += `*Correct:* ${q.correctOption}. ${q.options[q.correctOption]}\n\n`;
    text += `*Proper answer*\n${q.properAnswer}\n\n`;
    text += `*Explanation*\n${q.explanation}\n`;
    if (q.approach) {
        text += `\n*Approach*\n${q.approach}\n`;
    }
    if (q.timeComplexity) {
        text += `\n⏱ *Time:* ${q.timeComplexity}`;
    }
    if (q.spaceComplexity) {
        text += `\n💾 *Space:* ${q.spaceComplexity}`;
    }
    if (q.timeComplexity || q.spaceComplexity) {
        text += '\n';
    }
    if (q.commonMistake) {
        text += `\n⚠️ *Common mistake*\n${q.commonMistake}\n`;
    }
    text += '\n🤖 _Sassy Bot_';
    return text;
}

export function formatPollName(q) {
    return (
        `🧠 Interview Q · ${q.type} (${q.difficulty})\n` +
        `Topic: ${q.topic}\n\n` +
        `${q.question}`
    ).slice(0, 255);
}

export function pollValues(q) {
    return [
        `A. ${q.options.A}`,
        `B. ${q.options.B}`,
        `C. ${q.options.C}`,
        `D. ${q.options.D}`,
    ].map((v) => v.slice(0, 100));
}

class InterviewQuestionService {
    /**
     * @param {object} opts
     * @param {import('./interviewQuestion.storage.js').default} opts.store
     * @param {import('../models/GroupManager.js').default} opts.groupManager
     * @param {object} [opts.cfg]
     */
    constructor({ store, groupManager, cfg = config }) {
        this.store = store;
        this.groupManager = groupManager;
        this.cfg = cfg;
        this.llm = new AssistLlmRouter(cfg);
        /** @type {Map<string, NodeJS.Timeout>} */
        this._answerTimers = new Map();
        this._getSock = null;
    }

    setGetSock(fn) {
        this._getSock = fn;
    }

    isConfigured() {
        return this.llm.isConfigured();
    }

    async generateQuestion({ category, slotIndex = 0 } = {}) {
        if (!this.isConfigured()) {
            throw new Error('No LLM configured (set GEMINI / GROQ / NVIDIA / OPENROUTER key)');
        }

        const type = category || pickCategory(slotIndex);
        const userBlock = [
            `Generate ONE interview MCQ.`,
            `Category/type must be: ${type}`,
            `Vary difficulty across Easy/Medium/Hard.`,
            `Return JSON with keys: type, difficulty, topic, question, options{A,B,C,D}, correctOption, properAnswer, explanation, hint, approach, timeComplexity, spaceComplexity, commonMistake.`,
        ].join('\n');

        const { text, provider, model } = await this.llm.completeChat({
            systemPrompt: SYSTEM_PROMPT,
            history: [],
            userBlock,
            maxTokens: 1200,
            temperature: 0.7,
            maxChars: 4000,
        });

        const normalized = normalizeQuestion(extractJsonObject(text));
        // Force requested category family when model drifts
        if (!normalized.type) normalized.type = type;
        logger.info(`Interview Q generated via ${provider}/${model}: ${normalized.type} · ${normalized.topic}`);
        return normalized;
    }

    /**
     * Save + post poll for one jid. Skips if slot already used.
     */
    async postQuestionToJid(sock, jid, { slotKey, slotIndex = 0, category } = {}) {
        if (!sock || !jid) {
            throw new Error('Missing sock/jid');
        }

        const key = slotKey || `manual-${Date.now()}`;
        const existing = await this.store.findBySlot(jid, key);
        if (existing && existing.status !== 'failed') {
            logger.info(`Interview Q skip duplicate ${jid} slot ${key}`);
            return { skipped: true, doc: existing };
        }
        if (existing?.status === 'failed') {
            await this.store.deleteById(existing._id);
        }

        const q = await this.generateQuestion({ category, slotIndex });
        const answerDelayMs = this.cfg.INTERVIEW_Q_ANSWER_DELAY_MS || 30 * 60 * 1000;

        const doc = await this.store.insertQuestion({
            jid,
            slot_key: key,
            type: q.type,
            difficulty: q.difficulty,
            topic: q.topic,
            question: q.question,
            options: q.options,
            correct_option: q.correctOption,
            proper_answer: q.properAnswer,
            explanation: q.explanation,
            hint: q.hint,
            approach: q.approach,
            time_complexity: q.timeComplexity,
            space_complexity: q.spaceComplexity,
            common_mistake: q.commonMistake,
            status: 'scheduled',
            poll_message_id: '',
            poll_message_key: null,
            question_posted_at: null,
            answer_due_at: null,
            answer_posted_at: null,
        });

        try {
            const sent = await sock.sendMessage(jid, {
                poll: {
                    name: formatPollName(q),
                    values: pollValues(q),
                    selectableCount: 1,
                },
            });

            const postedAt = new Date();
            const dueAt = new Date(postedAt.getTime() + answerDelayMs);
            await this.store.markQuestionPosted(doc._id, {
                pollMessageId: sent?.key?.id || '',
                pollMessageKey: sent?.key || null,
                questionPostedAt: postedAt,
                answerDueAt: dueAt,
            });

            this.scheduleAnswer(String(doc._id), dueAt.getTime());
            return { skipped: false, docId: String(doc._id), question: q };
        } catch (err) {
            await this.store.markFailed(doc._id, err.message);
            throw err;
        }
    }

    docToQuestion(doc) {
        return {
            type: doc.type,
            difficulty: doc.difficulty,
            topic: doc.topic,
            question: doc.question,
            options: doc.options,
            correctOption: doc.correct_option,
            properAnswer: doc.proper_answer,
            explanation: doc.explanation,
            hint: doc.hint,
            approach: doc.approach,
            timeComplexity: doc.time_complexity,
            spaceComplexity: doc.space_complexity,
            commonMistake: doc.common_mistake,
        };
    }

    scheduleAnswer(docId, dueAtMs) {
        const existing = this._answerTimers.get(docId);
        if (existing) clearTimeout(existing);

        const delay = Math.max(0, dueAtMs - Date.now());
        const timer = setTimeout(() => {
            this._answerTimers.delete(docId);
            void this.postAnswerById(docId);
        }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        this._answerTimers.set(docId, timer);
        logger.info(`Interview Q answer scheduled in ${Math.round(delay / 1000)}s for ${docId}`);
    }

    async postAnswerById(docId) {
        const doc = await this.store.findById(docId);
        if (!doc) return { ok: false, reason: 'not_found' };
        if (doc.status === 'answer_posted') return { ok: true, reason: 'already' };
        if (doc.status !== 'question_posted') {
            return { ok: false, reason: `status_${doc.status}` };
        }

        const sock = this._getSock?.();
        if (!sock) {
            // retry in 60s when sock not ready
            this.scheduleAnswer(docId, Date.now() + 60_000);
            return { ok: false, reason: 'no_sock' };
        }

        try {
            const q = this.docToQuestion(doc);
            await sock.sendMessage(doc.jid, { text: formatAnswerMessage(q) });
            await this.store.markAnswerPosted(doc._id);
            logger.info(`Interview Q answer posted for ${doc.jid} (${docId})`);
            return { ok: true };
        } catch (err) {
            logger.error(`Interview Q answer failed ${docId}: ${err.message}`);
            return { ok: false, reason: err.message };
        }
    }

    async recoverPendingAnswers() {
        const pending = await this.store.findPendingAnswersDue(Date.now() + 24 * 60 * 60 * 1000);
        for (const doc of pending) {
            const due = new Date(doc.answer_due_at).getTime();
            this.scheduleAnswer(String(doc._id), due);
        }
        if (pending.length) {
            logger.info(`Interview Q recovered ${pending.length} pending answer job(s)`);
        }
        return pending.length;
    }

    /** Post one question to all interview-q enabled groups for a schedule slot */
    async postSlotToGroups(sock, { slotKey, slotIndex = 0 }) {
        const groups = await this.groupManager.getInterviewQGroups();
        if (!groups.length) {
            logger.warn('Interview Q: no enabled groups — use /interviewqon');
            return { posted: 0, groups: 0 };
        }

        let posted = 0;
        for (const group of groups) {
            try {
                const result = await this.postQuestionToJid(sock, group.group_id, {
                    slotKey,
                    slotIndex,
                });
                if (!result.skipped) posted++;
                await new Promise((r) => setTimeout(r, 800));
            } catch (err) {
                logger.error(`Interview Q post failed for ${group.group_id}: ${err.message}`);
            }
        }
        return { posted, groups: groups.length };
    }
}

export default InterviewQuestionService;
