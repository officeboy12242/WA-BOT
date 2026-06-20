/**
 * Scrape group participants and prepare member lists for owner broadcasts.
 */

import { logger } from '../utils/logger.js';
import { normalizePhoneNumber } from '../utils/permissions.js';

function dmJidForMember(member) {
    const phone = normalizePhoneNumber(member.phone);
    if (/^\d{10,15}$/.test(phone)) {
        return `${phone}@s.whatsapp.net`;
    }
    if (member.jid?.endsWith('@s.whatsapp.net')) {
        return member.jid;
    }
    if (member.lid) {
        return member.lid.includes('@') ? member.lid : `${member.lid}@lid`;
    }
    if (member.jid?.endsWith('@lid')) {
        return member.jid;
    }
    return '';
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
            rows.push({ ...group, stored_count: count });
        }
        return rows;
    }

    async getDmTargets(groupId) {
        const members = await this.groupMemberDatabase.getMembersForGroup(groupId);
        const seen = new Set();
        const targets = [];

        for (const member of members) {
            const jid = dmJidForMember(member);
            if (!jid || seen.has(jid)) {
                continue;
            }
            seen.add(jid);
            targets.push(jid);
        }

        return targets;
    }
}

export default MemberScrapeController;
