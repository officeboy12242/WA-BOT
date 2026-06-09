/**
 * Group Manager Model
 * Handles active groups and admin management
 */

import { logger } from '../utils/logger.js';
import { extractPhoneNumber } from '../utils/permissions.js';

class GroupManager {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.groups = null;
        this.admins = null;
        this.ownerNumbers = [];
        this.moderatorNumbers = [];
    }

    async init() {
        this.groups = this.mongoDb.collection('active_groups');
        this.admins = this.mongoDb.collection('admins');
        await Promise.all([
            this.groups.createIndex(
                { group_id: 1 },
                { unique: true, name: 'active_group_id' }
            ),
            this.admins.createIndex(
                { phone_number: 1 },
                { unique: true, name: 'admin_phone_number' }
            ),
        ]);
        logger.info('Mongo group manager store ready');
    }

    // ─── Admin Management ─────────────────────────────────────────────────────

    setOwnerNumbers(ownerNumbers) {
        this.ownerNumbers = ownerNumbers || [];
    }

    setModeratorNumbers(moderatorNumbers) {
        this.moderatorNumbers = moderatorNumbers || [];
    }

    isOwner(phoneNumber) {
        return this.ownerNumbers.includes(phoneNumber);
    }

    isModerator(phoneNumber) {
        return this.moderatorNumbers.includes(phoneNumber);
    }

    async isBotAdmin(phoneNumber) {
        const row = await this.admins.findOne(
            { phone_number: phoneNumber },
            { projection: { _id: 1 } }
        );
        return Boolean(row);
    }

    async isGroupAdmin(sock, groupId, phoneNumber) {
        try {
            const groupMetadata = await sock.groupMetadata(groupId);
            const participant = groupMetadata.participants.find(p => p.id.includes(phoneNumber));
            return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
        } catch (error) {
            return false;
        }
    }

    /**
     * Full admin commands: owners, DB admins, and WhatsApp group admins
     * in the group where the command was run (auto-detected live).
     */
    async isPrivileged(sock, chatId, phoneNumber) {
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        if (await this.isBotAdmin(phoneNumber)) {
            return true;
        }
        if (chatId && typeof chatId === 'string' && chatId.endsWith('@g.us')) {
            return this.isGroupAdmin(sock, chatId, phoneNumber);
        }
        return false;
    }

    /** Group staff: owners, moderators, DB admins, or WhatsApp group admin in that group */
    async isStaff(sock, chatId, phoneNumber) {
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        if (this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isBotAdmin(phoneNumber)) {
            return true;
        }
        if (!chatId || typeof chatId !== 'string') {
            return false;
        }
        if (chatId.endsWith('@g.us')) {
            return this.isGroupAdmin(sock, chatId, phoneNumber);
        }
        return false;
    }

    /** @deprecated Use isPrivileged or isStaff */
    async isAdmin(sock, chatId, phoneNumber) {
        return this.isPrivileged(sock, chatId, phoneNumber);
    }

    async isPrivilegedAsync(sock, chatId, senderJid) {
        const phoneNumber = extractPhoneNumber(senderJid);
        if (!phoneNumber) {
            return false;
        }
        return this.isPrivileged(sock, chatId, phoneNumber);
    }

    async isStaffAsync(sock, chatId, senderJid) {
        const phoneNumber = extractPhoneNumber(senderJid);
        if (!phoneNumber) {
            return false;
        }
        return this.isStaff(sock, chatId, phoneNumber);
    }

    async isAdminAsync(sock, chatId, senderJid) {
        return this.isPrivilegedAsync(sock, chatId, senderJid);
    }

    getAllOwners() {
        return this.ownerNumbers.map(phone => ({ phone_number: phone }));
    }

    async addAdmin(phoneNumber) {
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return false;
        }
        await this.admins.updateOne(
            { phone_number: phoneNumber },
            {
                $setOnInsert: {
                    phone_number: phoneNumber,
                    added_at: new Date(),
                },
            },
            { upsert: true }
        );
        return true;
    }

    async removeAdmin(phoneNumber) {
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return false;
        }
        const result = await this.admins.deleteOne({ phone_number: phoneNumber });
        return result.deletedCount > 0;
    }

    getAllModerators() {
        return this.moderatorNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Moderator',
        }));
    }

    async getAllAdmins() {
        const admins = await this.admins
            .find({}, { projection: { _id: 0 } })
            .sort({ added_at: 1 })
            .toArray();
        const ownerRows = this.ownerNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Owner',
            added_at: 'Owner',
        }));
        const moderatorRows = this.moderatorNumbers.map((phone) => ({
            phone_number: phone,
            role: 'Moderator',
            added_at: 'Moderator (.env)',
        }));
        const seen = new Set([
            ...ownerRows.map((row) => row.phone_number),
            ...moderatorRows.map((row) => row.phone_number),
        ]);
        const botAdminRows = admins
            .filter((admin) => !seen.has(admin.phone_number))
            .map((admin) => ({ ...admin, role: 'Bot admin' }));
        return ownerRows.concat(moderatorRows, botAdminRows);
    }

    // ─── Group Management ─────────────────────────────────────────────────────

    async activateGroup(groupId, groupName, activatedBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    activated_by: activatedBy,
                    activated_at: new Date(),
                    is_active: true,
                },
                $setOnInsert: {
                    group_id: groupId,
                    insta_auto: false,
                },
            },
            { upsert: true }
        );
        logger.info(`✅ Group activated: ${groupName} (${groupId}) by ${activatedBy}`);
    }

    async setInstaAuto(groupId, groupName, enabled, activatedBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    insta_auto: enabled,
                    insta_auto_by: activatedBy,
                    insta_auto_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '📸 Insta auto ON' : '📸 Insta auto OFF'}: ${groupName} (${groupId}) by ${activatedBy}`
        );
    }

    async isInstaAutoEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { insta_auto: 1 } }
        );
        return row?.insta_auto === true;
    }

    async getInstaAutoGroups() {
        return this.groups
            .find({ insta_auto: true }, { projection: { _id: 0 } })
            .sort({ insta_auto_at: -1 })
            .toArray();
    }

    async deactivateGroup(groupId) {
        const result = await this.groups.updateOne(
            { group_id: groupId },
            { $set: { is_active: false } }
        );
        logger.info(`🛑 Group deactivated: ${groupId}`);
        return result.matchedCount > 0;
    }

    async isGroupActive(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { is_active: 1 } }
        );
        return row ? row.is_active === true : false;
    }

    async getActiveGroups() {
        return this.groups
            .find({ is_active: true }, { projection: { _id: 0 } })
            .sort({ activated_at: -1 })
            .toArray();
    }

    async getAllGroups() {
        return this.groups
            .find({}, { projection: { _id: 0 } })
            .sort({ activated_at: -1 })
            .toArray();
    }

    async getGroupInfo(groupId) {
        return this.groups.findOne(
            { group_id: groupId },
            { projection: { _id: 0 } }
        );
    }

    async getGroupCount() {
        const [active, total] = await Promise.all([
            this.groups.countDocuments({ is_active: true }),
            this.groups.countDocuments({}),
        ]);
        return { active, total };
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    close() {
        this.groups = null;
        this.admins = null;
    }
}

export default GroupManager;
