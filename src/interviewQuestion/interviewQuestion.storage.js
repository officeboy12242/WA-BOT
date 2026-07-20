/**
 * Mongo storage for Interview Q of the Day (poll + delayed answer).
 */

import { ObjectId } from 'mongodb';
import { logger } from '../utils/logger.js';

const STATUSES = ['scheduled', 'question_posted', 'answer_posted', 'failed'];

class InterviewQuestionStore {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.col = null;
    }

    async init() {
        this.col = this.mongoDb.collection('interview_questions');
        await Promise.all([
            this.col.createIndex({ jid: 1, slot_key: 1 }, { unique: true, name: 'iq_jid_slot' }),
            this.col.createIndex({ status: 1, answer_due_at: 1 }, { name: 'iq_pending_answers' }),
            this.col.createIndex({ created_at: 1 }, { name: 'iq_created_at' }),
        ]);
        logger.info('Mongo interview question store ready');
    }

    /**
     * @param {object} doc
     */
    async insertQuestion(doc) {
        const now = new Date();
        const row = {
            ...doc,
            _id: doc._id || new ObjectId(),
            status: doc.status || 'scheduled',
            created_at: now,
            updated_at: now,
        };
        await this.col.insertOne(row);
        return row;
    }

    async findById(id) {
        if (!id) return null;
        try {
            const _id = typeof id === 'string' ? new ObjectId(id) : id;
            return this.col.findOne({ _id });
        } catch {
            return null;
        }
    }

    async deleteById(id) {
        if (!id) return;
        try {
            const _id = typeof id === 'string' ? new ObjectId(id) : id;
            await this.col.deleteOne({ _id });
        } catch {
            /* ignore */
        }
    }

    async findBySlot(jid, slotKey) {
        return this.col.findOne({ jid, slot_key: slotKey });
    }

    async findLatestPendingAnswer(jid) {
        return this.col.findOne(
            { jid, status: 'question_posted' },
            { sort: { question_posted_at: -1 } }
        );
    }

    async findPendingAnswersDue(beforeMs = Date.now() + 24 * 60 * 60 * 1000) {
        return this.col
            .find({
                status: 'question_posted',
                answer_due_at: { $lte: new Date(beforeMs) },
            })
            .sort({ answer_due_at: 1 })
            .toArray();
    }

    async markQuestionPosted(id, { pollMessageId, pollMessageKey, questionPostedAt, answerDueAt }) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'question_posted',
                    poll_message_id: pollMessageId || '',
                    poll_message_key: pollMessageKey || null,
                    question_posted_at: questionPostedAt || new Date(),
                    answer_due_at: answerDueAt,
                    updated_at: new Date(),
                },
            }
        );
    }

    async markAnswerPosted(id) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'answer_posted',
                    answer_posted_at: new Date(),
                    updated_at: new Date(),
                },
            }
        );
    }

    async markFailed(id, errorMessage) {
        await this.col.updateOne(
            { _id: id },
            {
                $set: {
                    status: 'failed',
                    error: String(errorMessage || '').slice(0, 500),
                    updated_at: new Date(),
                },
            }
        );
    }

    async cleanupOld(days = 30) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const result = await this.col.deleteMany({
            created_at: { $lt: cutoff },
            status: { $in: ['answer_posted', 'failed'] },
        });
        return result.deletedCount || 0;
    }
}

export { STATUSES };
export default InterviewQuestionStore;
