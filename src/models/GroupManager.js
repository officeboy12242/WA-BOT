/**
 * Group Manager Model
 * Handles active groups and admin management
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber, getBotAccountPhone } from '../utils/permissions.js';

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

    async isModeratorAsync(phoneNumber) {
        if (this.isModerator(phoneNumber)) return true;
        return this.isDynamicModerator(phoneNumber);
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

    /** Owners, moderators (env + dynamic), or DB bot admins — can add/remove other bot admins */
    async canManageBotAdmins(senderJid) {
        const phoneNumber = normalizePhoneNumber(extractPhoneNumber(senderJid));
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
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
        if (this.groupMetaCache.size > 200) {
            const oldest = this.groupMetaCache.keys().next().value;
            this.groupMetaCache.delete(oldest);
        }
        this.groupMetaCache.set(groupId, { data, at: Date.now() });
        return data;
    }

    /**
     * Member counts for all groups the bot participates in (one WA fetch).
     * @param {import('baileys').WASocket} sock
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

    /** WhatsApp group admin/superadmin in a specific group (supports LID senders). */
    async isSenderGroupAdmin(sock, groupId, senderJid) {
        if (!groupId?.endsWith('@g.us') || !senderJid) {
            return false;
        }
        try {
            const groupMetadata = await this.getGroupMetadataCached(sock, groupId);
            const senderPhone = normalizePhoneNumber(extractPhoneNumber(senderJid));
            for (const p of groupMetadata.participants || []) {
                const matchesJid =
                    p.id === senderJid ||
                    p.lid === senderJid ||
                    p.pn === senderJid ||
                    p.phoneNumber === senderJid;
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const matchesPhone = senderPhone && pPhone && pPhone === senderPhone;
                if (matchesJid || matchesPhone) {
                    return p.admin === 'admin' || p.admin === 'superadmin';
                }
            }
        } catch {
            return false;
        }
        return false;
    }

    /**
     * Find a group participant by JID and/or phone (Baileys 7 phone + LID).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @param {string} [jid]
     * @param {string} [phone]
     */
    async findParticipant(sock, groupId, jid = '', phone = '') {
        if (!groupId?.endsWith('@g.us')) {
            return null;
        }
        try {
            const groupMetadata = await sock.groupMetadata(groupId);
            const normalizedPhone = normalizePhoneNumber(phone || extractPhoneNumber(jid));
            const normalizedJid = jid ? jidNormalizedUser(jid.replace(/:\d+(?=@)/, '')) || jid : '';

            for (const p of groupMetadata.participants || []) {
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const pId = jidNormalizedUser(String(p.id || '').replace(/:\d+(?=@)/, ''));
                const pLid = p.lid ? jidNormalizedUser(String(p.lid).replace(/:\d+(?=@)/, '')) : '';

                const matchJid =
                    (normalizedJid &&
                        (p.id === jid ||
                            p.lid === jid ||
                            p.pn === jid ||
                            p.phoneNumber === jid ||
                            pId === normalizedJid ||
                            pLid === normalizedJid)) ||
                    false;
                const matchPhone = normalizedPhone && pPhone && pPhone === normalizedPhone;

                if (matchJid || matchPhone) {
                    return p;
                }
            }
        } catch (err) {
            logger.debug(`findParticipant failed for ${groupId}: ${err.message}`);
        }
        return null;
    }

    /** Whether the connected bot account is admin/superadmin in this group. */
    async isBotGroupAdmin(sock, groupId) {
        if (!groupId?.endsWith('@g.us') || !sock?.user?.id) {
            return false;
        }

        try {
            const groupMetadata = await sock.groupMetadata(groupId);
            const botPhone = getBotAccountPhone(sock);
            const botRaw = String(sock.user.id).replace(/:\d+(?=@)/, '');
            const botJid = jidNormalizedUser(botRaw) || botRaw;

            const jidCandidates = new Set([botJid, botRaw].filter(Boolean));
            if (botPhone) {
                jidCandidates.add(`${botPhone}@s.whatsapp.net`);
            }
            const botLid = sock.authState?.creds?.me?.lid || sock.user?.lid;
            if (botLid) {
                jidCandidates.add(jidNormalizedUser(String(botLid).replace(/:\d+(?=@)/, '')));
            }

            for (const p of groupMetadata.participants || []) {
                const pPhone = normalizePhoneNumber(participantToPhone(p));
                const pId = jidNormalizedUser(String(p.id || '').replace(/:\d+(?=@)/, ''));
                const pLid = p.lid ? jidNormalizedUser(String(p.lid).replace(/:\d+(?=@)/, '')) : '';

                const matchJid =
                    jidCandidates.has(p.id) ||
                    jidCandidates.has(p.lid) ||
                    jidCandidates.has(p.pn) ||
                    jidCandidates.has(p.phoneNumber) ||
                    jidCandidates.has(pId) ||
                    (pLid && jidCandidates.has(pLid));

                const matchPhone = botPhone && pPhone && pPhone === botPhone;

                if ((matchJid || matchPhone) && (p.admin === 'admin' || p.admin === 'superadmin')) {
                    return true;
                }
            }
        } catch (err) {
            logger.debug(`isBotGroupAdmin failed for ${groupId}: ${err.message}`);
        }

        return false;
    }

    async isBotGroupAdminAsync(sock, groupId) {
        return this.isBotGroupAdmin(sock, groupId);
    }

    async isSenderGroupAdminAsync(sock, groupId, senderJid) {
        return this.isSenderGroupAdmin(sock, groupId, senderJid);
    }

    /** Owners, moderators (env + dynamic), or DB bot admins — can manually post /news */
    async canManualPostNews(senderJid) {
        const phoneNumber = extractPhoneNumber(senderJid);
        if (!phoneNumber) {
            return false;
        }
        if (this.isOwner(phoneNumber) || this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
            return true;
        }
        return this.isBotAdmin(phoneNumber);
    }

    /**
     * Live WhatsApp group admins across all participating groups.
     * @param {import('baileys').WASocket} sock
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

    /** Group staff: owners, moderators (env + dynamic), DB admins, or WhatsApp group admin */
    async isStaff(sock, chatId, phoneNumber) {
        if (this.isOwner(phoneNumber)) {
            return true;
        }
        if (this.isModerator(phoneNumber)) {
            return true;
        }
        if (await this.isDynamicModerator(phoneNumber)) {
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
        const [admins, dynamicMods] = await Promise.all([
            this.admins.find({}, { projection: { _id: 0 } }).sort({ added_at: 1 }).toArray(),
            this.getAllDynamicModerators(),
        ]);
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
        const dynamicModRows = dynamicMods.map((mod) => ({
            phone_number: mod.phone_number,
            role: 'Moderator',
            added_at: mod.added_at,
        }));
        const seen = new Set([
            ...ownerRows.map((row) => row.phone_number),
            ...moderatorRows.map((row) => row.phone_number),
            ...dynamicModRows.map((row) => row.phone_number),
        ]);
        const botAdminRows = admins
            .filter((admin) => !seen.has(admin.phone_number))
            .map((admin) => ({ ...admin, role: 'Bot admin' }));
        return ownerRows.concat(moderatorRows, dynamicModRows, botAdminRows);
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
                    news_enabled: true,
                    github_trending: true,
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

    async setNewsEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    news_enabled: enabled,
                    news_set_by: setBy,
                    news_set_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '📰 Tech news ON' : '📰 Tech news OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isNewsEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { news_enabled: 1, is_active: 1 } }
        );
        if (!row?.is_active) {
            return false;
        }
        return row.news_enabled !== false;
    }

    async getNewsEnabledGroups() {
        return this.groups
            .find(
                { is_active: true, news_enabled: { $ne: false } },
                { projection: { _id: 0 } }
            )
            .sort({ activated_at: -1 })
            .toArray();
    }

    async setGithubTrendingEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    github_trending: enabled,
                    github_trending_by: setBy,
                    github_trending_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
        logger.info(
            `${enabled ? '🐙 GitHub trending ON' : '🐙 GitHub trending OFF'}: ${groupName} (${groupId}) by ${setBy}`
        );
    }

    async isGithubTrendingEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { github_trending: 1, is_active: 1 } }
        );
        if (!row?.is_active) {
            return false;
        }
        return row.github_trending !== false;
    }

    async getGithubTrendingGroups() {
        return this.groups
            .find(
                { is_active: true, github_trending: { $ne: false } },
                { projection: { _id: 0 } }
            )
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

    // ─── Movie & trending toggles ──────────────────────────────────────────────

    async setMovieEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    movie_enabled: enabled,
                    movie_set_by: setBy,
                    movie_set_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
    }

    async isMovieEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { movie_enabled: 1 } }
        );
        return row?.movie_enabled === true;
    }

    async getMovieEnabledGroups() {
        return this.groups
            .find({ movie_enabled: true }, { projection: { _id: 0 } })
            .toArray();
    }

    async setWeeklyTrendingEnabled(groupId, groupName, enabled, setBy) {
        await this.groups.updateOne(
            { group_id: groupId },
            {
                $set: {
                    group_name: groupName,
                    weekly_trending: enabled,
                    weekly_trending_by: setBy,
                    weekly_trending_at: new Date(),
                },
                $setOnInsert: { group_id: groupId, is_active: false },
            },
            { upsert: true }
        );
    }

    async isWeeklyTrendingEnabled(groupId) {
        const row = await this.groups.findOne(
            { group_id: groupId },
            { projection: { weekly_trending: 1 } }
        );
        return row?.weekly_trending === true;
    }

    async getWeeklyTrendingGroups() {
        return this.groups
            .find({ weekly_trending: true }, { projection: { _id: 0 } })
            .toArray();
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

    // ─── Premium users ─────────────────────────────────────────────────────────

    async initPremium() {
        this.premiumUsers = this.mongoDb.collection('premium_users');
        await this.premiumUsers.createIndex(
            { phone_number: 1 },
            { unique: true, name: 'premium_phone' }
        );
    }

    async addPremiumUser(phoneNumber, addedBy) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        const existing = await this.premiumUsers.findOne({ phone_number: phone });
        if (existing) {
            return { ok: false, reason: 'already', phone_number: phone };
        }
        await this.premiumUsers.insertOne({
            phone_number: phone,
            added_by: addedBy,
            added_at: new Date(),
        });
        logger.info(`⭐ Premium user added: ${phone} by ${addedBy}`);
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removePremiumUser(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        const result = await this.premiumUsers.deleteOne({ phone_number: phone });
        if (result.deletedCount > 0) {
            logger.info(`⭐ Premium user removed: ${phone}`);
            return { ok: true, reason: 'removed', phone_number: phone };
        }
        return { ok: false, reason: 'not_found' };
    }

    async isPremiumUser(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) return false;
        return Boolean(await this.premiumUsers?.findOne({ phone_number: phone }));
    }

    async getAllPremiumUsers() {
        if (!this.premiumUsers) return [];
        return this.premiumUsers.find({}, { projection: { _id: 0 } })
            .sort({ added_at: -1 })
            .toArray();
    }

    // ─── Dynamic moderators ──────────────────────────────────────────────────

    async initDynamicModerators() {
        this.dynamicModerators = this.mongoDb.collection('dynamic_moderators');
        await this.dynamicModerators.createIndex(
            { phone_number: 1 },
            { unique: true, name: 'dynamic_mod_phone' }
        );
    }

    async addDynamicModerator(phoneNumber, addedBy) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone || phone.length < 10) {
            return { ok: false, reason: 'invalid' };
        }
        if (this.isOwner(phone)) {
            return { ok: false, reason: 'owner' };
        }
        const existing = await this.dynamicModerators.findOne({ phone_number: phone });
        if (existing) {
            return { ok: false, reason: 'already', phone_number: phone };
        }
        await this.dynamicModerators.insertOne({
            phone_number: phone,
            added_by: addedBy,
            added_at: new Date(),
        });
        logger.info(`🛡️ Dynamic moderator added: ${phone} by ${addedBy}`);
        return { ok: true, reason: 'added', phone_number: phone };
    }

    async removeDynamicModerator(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) {
            return { ok: false, reason: 'invalid' };
        }
        const result = await this.dynamicModerators.deleteOne({ phone_number: phone });
        if (result.deletedCount > 0) {
            logger.info(`🛡️ Dynamic moderator removed: ${phone}`);
            return { ok: true, reason: 'removed', phone_number: phone };
        }
        return { ok: false, reason: 'not_found' };
    }

    async isDynamicModerator(phoneNumber) {
        const phone = normalizePhoneNumber(phoneNumber);
        if (!phone) return false;
        return Boolean(await this.dynamicModerators?.findOne({ phone_number: phone }));
    }

    async getAllDynamicModerators() {
        if (!this.dynamicModerators) return [];
        return this.dynamicModerators.find({}, { projection: { _id: 0 } })
            .sort({ added_at: -1 })
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
        this.premiumUsers = null;
        this.dynamicModerators = null;
    }
}

export default GroupManager;
