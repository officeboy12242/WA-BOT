/**
 * Stores scraped WhatsApp group member records for owner broadcasts.
 */

import { logger } from '../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../utils/permissions.js';

function memberKeyFromFields({ phone, jid }) {
    const normalized = normalizePhoneNumber(phone);
    if (normalized) {
        return normalized;
    }
    return jid || '';
}

class GroupMemberDatabase {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.members = null;
        this.scrapes = null;
    }

    async init() {
        this.members = this.mongoDb.collection('group_members');
        this.scrapes = this.mongoDb.collection('group_member_scrapes');
        await Promise.all([
            this.members.createIndex(
                { group_id: 1, member_key: 1 },
                { unique: true, name: 'group_member_unique' }
            ),
            this.members.createIndex({ group_id: 1 }, { name: 'group_member_group_id' }),
            this.members.createIndex({ phone: 1 }, { name: 'group_member_phone' }),
            this.scrapes.createIndex({ group_id: 1 }, { unique: true, name: 'group_scrape_meta' }),
            this.scrapes.createIndex({ scraped_at: -1 }, { name: 'group_scrape_scraped_at' }),
        ]);
        logger.info('Mongo group member scrape store ready');
    }

    async upsertMembers(groupId, groupName, participants = []) {
        const now = new Date();
        let inserted = 0;
        let updated = 0;

        for (const participant of participants) {
            const jid = participant.id || '';
            const phone = extractPhoneNumber(participant.phoneNumber || participant.pn || participant.id);
            const memberKey = memberKeyFromFields({ phone, jid });
            if (!memberKey) {
                continue;
            }

            const result = await this.members.updateOne(
                { group_id: groupId, member_key: memberKey },
                {
                    $set: {
                        group_id: groupId,
                        group_name: groupName,
                        member_key: memberKey,
                        jid,
                        phone: normalizePhoneNumber(phone) || phone,
                        lid: participant.lid || null,
                        admin: participant.admin || null,
                        updated_at: now,
                    },
                    $setOnInsert: {
                        scraped_at: now,
                    },
                },
                { upsert: true }
            );

            if (result.upsertedCount) {
                inserted++;
            } else if (result.modifiedCount) {
                updated++;
            }
        }

        await this.scrapes.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_id: groupId,
                    group_name: groupName,
                    member_count: participants.length,
                    scraped_at: now,
                },
            },
            { upsert: true }
        );

        return { inserted, updated, total: participants.length };
    }

    async getScrapedGroups() {
        return this.scrapes.find({}, { projection: { _id: 0 } }).sort({ group_name: 1 }).toArray();
    }

    async getMemberCount(groupId) {
        return this.members.countDocuments({ group_id: groupId });
    }

    async getMembersForGroup(groupId) {
        return this.members
            .find({ group_id: groupId }, { projection: { _id: 0, jid: 1, phone: 1, lid: 1 } })
            .toArray();
    }

    close() {
        this.members = null;
        this.scrapes = null;
    }
}

export default GroupMemberDatabase;
