/**
 * Scrape group participants and prepare member lists for owner broadcasts.
 */

import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from '../utils/permissions.js';

function participantToPhone(participant) {
    const fromPn = extractPhoneNumber(participant.phoneNumber || participant.pn || '');
    if (/^\d{10,15}$/.test(fromPn)) {
        return fromPn;
    }
    const id = participant.id || '';
    if (id.includes('@lid')) {
        return '';
    }
    const fromId = extractPhoneNumber(id);
    return /^\d{10,15}$/.test(fromId) ? fromId : '';
}

function normalizeLidJid(value) {
    if (!value) {
        return '';
    }
    const jid = value.includes('@') ? value : `${value}@lid`;
    return jidNormalizedUser(jid) || jid;
}

/**
 * Prefer phone JID; fall back to LID when WhatsApp hides the number.
 * @returns {{ jid: string, via: 'phone' | 'lid' } | null}
 */
export function dmTargetForMember(member) {
    const phone = normalizePhoneNumber(member.phone);
    if (/^\d{10,15}$/.test(phone)) {
        return { jid: `${phone}@s.whatsapp.net`, via: 'phone' };
    }

    const jid = member.jid || '';
    if (jid.endsWith('@s.whatsapp.net')) {
        const phoneFromJid = extractPhoneNumber(jid.split(':')[0]);
        if (/^\d{10,15}$/.test(phoneFromJid)) {
            return { jid: `${phoneFromJid}@s.whatsapp.net`, via: 'phone' };
        }
    }

    const lidSource = member.lid || (jid.endsWith('@lid') ? jid : '');
    const lidJid = normalizeLidJid(lidSource);
    if (lidJid.endsWith('@lid')) {
        return { jid: lidJid, via: 'lid' };
    }

    return null;
}

class MemberScrapeController {
    constructor(groupMemberDatabase, userManager = null) {
        this.groupMemberDatabase = groupMemberDatabase;
        this.userManager = userManager;
    }

    async fetchParticipatingGroups(sock) {
        if (!sock?.groupFetchAllParticipating) {
            return [];
        }

        try {
            const participating = await sock.groupFetchAllParticipating();
            return Object.entries(participating)
                .map(([groupId, meta]) => ({
                    group_id: groupId,
                    group_name: meta.subject || 'Unknown Group',
                    member_count: meta.participants?.length ?? meta.size ?? 0,
                }))
                .sort((a, b) => a.group_name.localeCompare(b.group_name));
        } catch (err) {
            logger.error(`Failed to list participating groups: ${err.message}`);
            return [];
        }
    }

    async scrapeGroup(sock, groupId, groupName) {
        const meta = await sock.groupMetadata(groupId);
        const participants = meta.participants || [];
        const name = meta.subject || groupName || 'Unknown Group';

        if (this.userManager) {
            for (const participant of participants) {
                if (participant.id) {
                    const stored = await this.userManager.getUser(participant.id);
                    if (!stored?.pushName && participant.notify) {
                        await this.userManager.updateUser(participant.id, participant.notify);
                    }
                }
            }
        }

        const stats = await this.groupMemberDatabase.upsertMembers(groupId, name, participants);
        return { ...stats, group_name: name, group_id: groupId };
    }

    async getStoredGroupsWithCounts() {
        const groups = await this.groupMemberDatabase.getScrapedGroups();
        const rows = [];
        for (const group of groups) {
            const count = await this.groupMemberDatabase.getMemberCount(group.group_id);
            const dmStats = await this.getDmTargetStats(group.group_id);
            rows.push({ ...group, stored_count: count, ...dmStats });
        }
        return rows;
    }

    async getDmTargetStats(groupId) {
        const members = await this.groupMemberDatabase.getMembersForGroup(groupId);
        const seen = new Set();
        let dm_count = 0;
        let phone_dm_count = 0;
        let lid_dm_count = 0;

        for (const member of members) {
            const target = dmTargetForMember(member);
            if (!target || seen.has(target.jid)) {
                continue;
            }
            seen.add(target.jid);
            dm_count++;
            if (target.via === 'lid') {
                lid_dm_count++;
            } else {
                phone_dm_count++;
            }
        }

        return { dm_count, phone_dm_count, lid_dm_count };
    }

    async getDmTargets(groupId) {
        const members = await this.groupMemberDatabase.getMembersForGroup(groupId);
        const seen = new Set();
        const targets = [];

        for (const member of members) {
            const target = dmTargetForMember(member);
            if (!target || seen.has(target.jid)) {
                continue;
            }
            seen.add(target.jid);
            targets.push(target.jid);
        }

        return targets;
    }
}

export default MemberScrapeController;
