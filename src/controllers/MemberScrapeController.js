/**
 * Scrape group participants and prepare member lists for owner broadcasts.
 */

import { jidNormalizedUser } from 'baileys';
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
 * Prefer phone JID; otherwise report the LID so it can be RESOLVED later.
 *
 * A `@lid` is a group-scoped privacy identifier, not an addressable inbox —
 * `sendMessage` to one cannot deliver a DM. This used to return the LID as a
 * ready-to-send target, so every hidden-number member was counted as
 * reachable and then silently failed. `via: 'lid'` now means "needs
 * resolving", and `resolveDmTargets()` below turns it into a phone JID or
 * drops it.
 *
 * @returns {{ jid: string, via: 'phone' } | { lid: string, via: 'lid' } | null}
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
        return { lid: lidJid, via: 'lid' };
    }

    return null;
}

/**
 * Turn a LID into the phone JID that can actually receive a DM.
 *
 * Baileys keeps the mapping it learned from group metadata and message
 * receipts; `getPNForLID` is the reverse of the `getLIDForPN` lookup already
 * used for privacy tokens. Members whose number WhatsApp has never revealed
 * to us stay unresolvable, and are excluded rather than counted and skipped.
 *
 * @returns {Promise<string|null>} phone JID
 */
export async function resolveLidToPhoneJid(sock, lidJid) {
    const store = sock?.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return null;
    try {
        const pn = await store.getPNForLID(lidJid);
        if (!pn) return null;
        const phone = extractPhoneNumber(String(pn).split('@')[0].split(':')[0]);
        return /^\d{10,15}$/.test(phone) ? `${phone}@s.whatsapp.net` : null;
    } catch {
        return null;
    }
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

        // Fire-and-forget — don't block scrape on per-user DB writes
        if (this.userManager && participants.length) {
            void this._cacheParticipantNames(participants);
        }

        const stats = await this.groupMemberDatabase.upsertMembers(groupId, name, participants);
        return { ...stats, group_name: name, group_id: groupId };
    }

    /** Forget one group's scraped members. */
    async clearGroup(groupId) {
        return this.groupMemberDatabase.clearGroup(groupId);
    }

    /** Forget every scraped group. */
    async clearAllGroups() {
        return this.groupMemberDatabase.clearAllGroups();
    }

    /**
     * Purge members not seen in a scrape for `days`.
     *
     * Groups that stopped being re-scraped leave rows behind indefinitely, and
     * those people may have left long ago. Sending to them wastes the daily
     * cap and invites reports.
     */
    async pruneStale(days = 60) {
        const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
        const stale = await this.groupMemberDatabase.countStaleMembers(cutoff);
        if (!stale) return { removed: 0, days };
        const res = await this.groupMemberDatabase.pruneStaleMembers(cutoff);
        return { ...res, days };
    }

    async _cacheParticipantNames(participants) {
        for (const participant of participants) {
            if (!participant.id || !participant.notify) {
                continue;
            }
            try {
                const stored = await this.userManager.getUser(participant.id);
                if (!stored?.pushName) {
                    await this.userManager.updateUser(participant.id, participant.notify);
                }
            } catch {
                // ignore individual name cache failures
            }
        }
    }

    filterTargetsForBroadcast(targets, sock) {
        if (!sock?.user?.id) {
            return targets;
        }
        const selfPhone = extractPhoneNumber(sock.user.id);
        const selfJid = sock.user.id.split(':')[0];
        return targets.filter((jid) => {
            const phone = extractPhoneNumber(jid.split(':')[0]);
            return jid !== selfJid && jid !== sock.user.id && phone !== selfPhone;
        });
    }

    async getStoredGroupsWithCounts(sock = null) {
        const groups = await this.groupMemberDatabase.getScrapedGroups();
        const rows = [];
        for (const group of groups) {
            const count = await this.groupMemberDatabase.getMemberCount(group.group_id);
            const dmStats = await this.getDmTargetStats(group.group_id, sock);
            rows.push({ ...group, stored_count: count, ...dmStats });
        }
        return rows;
    }

    /**
     * Reachability breakdown for one group.
     *
     * `dm_count` is now what can ACTUALLY be delivered. It used to include
     * every LID, so the bot announced a reach it could not achieve and the
     * difference vanished into silent send failures.
     */
    async getDmTargetStats(groupId, sock = null) {
        const { targets, lidResolved, unreachable } = await this.resolveDmTargets(groupId, sock);
        return {
            dm_count: targets.length,
            phone_dm_count: targets.length - lidResolved,
            lid_dm_count: lidResolved,
            unreachable_count: unreachable,
        };
    }

    /**
     * Deliverable phone JIDs for a group.
     *
     * @param {object|null} sock needed to resolve LIDs; without it, LID-only
     *   members are reported unreachable rather than silently included.
     * @returns {Promise<{ targets: string[], lidResolved: number, unreachable: number }>}
     */
    async resolveDmTargets(groupId, sock = null) {
        const members = await this.groupMemberDatabase.getMembersForGroup(groupId);
        const seen = new Set();
        const targets = [];
        let lidResolved = 0;
        let unreachable = 0;

        for (const member of members) {
            const target = dmTargetForMember(member);
            if (!target) {
                unreachable += 1;
                continue;
            }

            let jid = target.jid;
            let fromLid = false;
            if (target.via === 'lid') {
                jid = sock ? await resolveLidToPhoneJid(sock, target.lid) : null;
                if (!jid) {
                    unreachable += 1;
                    continue;
                }
                fromLid = true;
            }

            if (seen.has(jid)) continue;
            seen.add(jid);
            targets.push(jid);
            if (fromLid) lidResolved += 1;
        }

        return { targets, lidResolved, unreachable };
    }

    /** Back-compat: deliverable JIDs only. */
    async getDmTargets(groupId, sock = null) {
        const { targets } = await this.resolveDmTargets(groupId, sock);
        return targets;
    }

    /** Unique DM targets across every scraped group (one message per person). */
    async getAllDedupedDmTargets(sock) {
        const groups = await this.getStoredGroupsWithCounts(sock);
        const seen = new Set();
        const targets = [];
        let unreachable = 0;

        for (const group of groups) {
            const res = await this.resolveDmTargets(group.group_id, sock);
            unreachable += res.unreachable;
            for (const jid of this.filterTargetsForBroadcast(res.targets, sock)) {
                if (seen.has(jid)) continue;
                seen.add(jid);
                targets.push(jid);
            }
        }

        return { groups, targets, unreachable };
    }
}

export default MemberScrapeController;
