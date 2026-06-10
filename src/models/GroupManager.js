/**
 * Group Manager Model
 * Handles active groups and admin management
 */

import { logger } from '../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../utils/permissions.js';

function participantToPhone(participant) {
    if (!participant) {
        return '';
    }
    const fromPn = extractPhoneNumber(participant.phoneNumber || participant.pn || '');
    if (/^\d{10,15}$/.test(fromPn)) {
        return fromPn;
    }
    const fromId = extractPhoneNumber(participant.id || '');
    if (/^\d{10,15}$/.test(fromId)) {
        return fromId;
    }
    return fromId || fromPn;
}

class GroupManager {
    constructor(mongoDb) {
        this.mongoDb = mongoDb;
        this.groups = null;
        this.admins = null;
        this.ownerNumbers = [];
        this.moderatorNumbers = [];
        /** @type {Map<string, { data: object, at: number }>} */
        this.groupMetaCache = new Map();
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
        const normalized = normalizePhoneNumber(phoneNumber);
        return this.ownerNumbers.some(
            (owner) => normalizePhoneNumber(owner) === normalized
        );
    }

    isModerator(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        return this.moderatorNumbers.some(
            (mod) => normalizePhoneNumber(mod) === normalized
        );
    }

    async findBotAdminRecord(phoneNumber) {
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized || !this.admins) {
            return null;
        }

        const exact = await this.admins.findOne({ phone_number: normalized });
        if (exact) {
            return exact;
        }

        const suffix = new RegExp(`${normalized}$`);
        return this.admins.findOne({ phone_number: { $regex: suffix } });
    }

    async isBotAdmin(phoneNumber) {
        return Boolean(await this.findBotAdminRecord(phoneNumber));
    }

    /** Owners, moderators, or DB bot admins — can add/remove other bot admins */
    async canManageBotAdmins(senderJid) {
        const phoneNumber = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        return this.isBotAdmin(phoneNumber);
    }

    async canManageBotAdminsAsync(senderJid) {
        return this.canManageBotAdmins(senderJid);
    }

    async getGroupMetadataCached(sock, groupId) {
        const cached = this.groupMetaCache.get(groupId);
        if (cached && Date.now() - cached.at < 60_000) {
            return cached.data;
        }
        const data = await sock.groupMetadata(groupId);
        this.groupMetaCache.set(groupId, { data, at: Date.now() });
        return data;
    }

    /**
     * Member counts for all groups the bot participates in (one WA fetch).
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     * @returns {Promise<Map<string, number>>}
     */
    async getParticipatingGroupMemberCounts(sock) {
        /** @type {Map<string, number>} */
        const counts = new Map();
        if (!sock?.groupFetchAllParticipating) {
            return counts;
        }
        try {
            const participating = await sock.groupFetchAllParticipating();
            for (const [groupId, meta] of Object.entries(participating)) {
                const size = meta.participants?.length ?? meta.size;
                if (typeof size === 'number' && size >= 0) {
                    counts.set(groupId, size);
                }
            }
        } catch (error) {
            logger.error(`Failed to fetch group member counts: ${error.message}`);
        }
        return counts;
    }

    formatMemberCount(memberCounts, groupId) {
        const count = memberCounts.get(groupId);
        return typeof count === 'number' ? String(count) : '—';
    }

    async isGroupAdmin(sock, groupId, phoneNumber) {
        try {
            const groupMetadata = await this.getGroupMetadataCached(sock, groupId);
            const normalized = normalizePhoneNumber(phoneNumber);
            const participant = groupMetadata.participants.find((p) => {
                const participantPhone = normalizePhoneNumber(participantToPhone(p));
                return (
                    participantPhone === normalized ||
                    p.id.includes(normalized) ||
                    p.id.includes(phoneNumber)
                );
            });
            return Boolean(
                participant &&
                    (participant.admin === 'admin' || participant.admin === 'superadmin')
            );
        } catch {
            return false;
        }
    }

    /** Owners, moderators, or DB bot admins — can manually post /news to groups */
    async canManualPostNews(senderJid) {
        const phoneNumber = extractPhoneNumber(senderJid);
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        return this.isBotAdmin(phoneNumber);
    }

    /**
     * Live WhatsApp group admins across all participating groups.
     * @param {import('@whiskeysockets/baileys').WASocket} sock
     */
    async fetchAllWhatsAppGroupAdmins(sock) {
        const byPhone = new Map();
        if (!sock?.groupFetchAllParticipating) {
            return [];
        }
        try {
            const participating = await sock.groupFetchAllParticipating();
            for (const meta of Object.values(participating)) {
                for (const participant of meta.participants || []) {
                    if (participant.admin !== 'admin' && participant.admin !== 'superadmin') {
                        continue;
                    }
                    const phone = participantToPhone(participant);
                    if (!phone) {
                        continue;
                    }
                    const key = phone.replace(/\D/g, '');
                    if (!byPhone.has(key)) {
                        byPhone.set(key, {
                            phone_number: key,
                            role: participant.admin === 'superadmin' ? 'Super admin' : 'Group admin',
                            groups: [],
                        });
                    }
                    byPhone.get(key).groups.push(meta.subject || meta.id);
                }
            }
        } catch (error) {
            logger.error(`Failed to fetch WhatsApp group admins: ${error.message}`);
        }
        return [...byPhone.values()];
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
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        if (this.isModerator(phone)) {
            return { ok: false, reason: 'moderator' };
        }

        const existing = await this.findBotAdminRecord(phone);
        if (existing) {
            return {
                ok: true,
                reason: 'already',
                phone_number: normalizePhoneNumber(existing.phone_number) || phone,
            };
        }

        await this.admins.insertOne({
            phone_number: phone,
            added_at: new Date(),
        });
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removeAdmin(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        if (this.isModerator(phone)) {
            return { ok: false, reason: 'moderator' };
        }

        const existing = await this.findBotAdminRecord(phone);
        if (!existing) {
            return { ok: false, reason: 'not_found' };
        }

        const storedPhone = existing.phone_number;
        const result = await this.admins.deleteOne({ phone_number: storedPhone });
        if (result.deletedCount > 0) {
            return {
                ok: true,
                reason: 'removed',
                phone_number: normalizePhoneNumber(storedPhone) || phone,
            };
        }
        return { ok: false, reason: 'not_found' };
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

    // ─── Welcome messages ─────────────────────────────────────────────────────

    async setWelcomeMessage(groupId, groupName, customMessage, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    welcome_enabled: true,
                    welcome_message: (customMessage || '').trim(),
                    welcome_set_by: setBy,
                    welcome_set_at: new Date(),
                },
                $setOnInsert: {
                    group_id: groupId,
                    is_active: false,
                    insta_auto: false,
                },
            },
            { upsert: true }
        );
        logger.info(`👋 Welcome message set for ${groupName} (${groupId}) by ${setBy}`);
    }

    async clearWelcomeMessage(groupId) {
        const result = await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: { welcome_enabled: false },
                $unset: {
                    welcome_message: '',
                    welcome_set_by: '',
                    welcome_set_at: '',
                },
            }
        );
        logger.info(`👋 Welcome message cleared for ${groupId}`);
        return result.matchedCount > 0;
    }

    async getWelcomeConfig(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            {
                projection: {
                    _id: 0,
                    welcome_enabled: 1,
                    welcome_message: 1,
                    welcome_set_by: 1,
                    welcome_set_at: 1,
                    group_name: 1,
                },
            }
        );
        if (!row?.welcome_enabled) {
            return null;
        }
        return row;
    }

    async isWelcomeEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { welcome_enabled: 1 } }
        );
        return row?.welcome_enabled === true;
    }

    async getWelcomeEnabledGroups() {
        return this.groups
            .find({ welcome_enabled: true }, { projection: { _id: 0 } })
            .sort({ welcome_set_at: -1 })
            .toArray();
    }

    // ─── Sticker source channels ─────────────────────────────────────────────

    async initChannels() {
        this.channels = this.mongoDb.collection('sticker_channels');
        await this.channels.createIndex(
            { channel_jid: 1 },
            { unique: true, name: 'channel_jid' }
        );
    }

    async addStickerChannel(channelJid, channelName, addedBy) {
        if (!channelJid?.includes('@newsletter')) {
            return { ok: false, reason: 'Invalid channel JID' };
        }
        try {
            await this.channels.updateOne(
                { channel_jid: channelJid },
                {
                    $set: {
                        channel_name: channelName || channelJid,
                        added_by: addedBy,
                        added_at: new Date(),
                    },
                    $setOnInsert: { channel_jid: channelJid },
                },
                { upsert: true }
            );
            logger.info(`📡 Channel added: ${channelName || channelJid} by ${addedBy}`);
            return { ok: true, jid: channelJid, name: channelName };
        } catch (error) {
            return { ok: false, reason: error.message };
        }
    }

    async removeStickerChannel(channelJid) {
        const result = await this.channels.deleteOne({ channel_jid: channelJid });
        if (result.deletedCount > 0) {
            logger.info(`📡 Channel removed: ${channelJid}`);
            return { ok: true };
        }
        return { ok: false, reason: 'Channel not found' };
    }

    async getStickerChannels() {
        if (!this.channels) return [];
        return this.channels.find({}).toArray();
    }

    async getStickerChannelJids() {
        const channels = await this.getStickerChannels();
        return channels.map(c => c.channel_jid);
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    close() {
        this.groups = null;
        this.admins = null;
        this.channels = null;
    }
}

export default GroupManager;
