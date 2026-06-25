/**
 * Tracks group participant sets to detect new joins (welcome messages).
 */

import { jidNormalizedUser } from 'baileys';
import { logger } from './logger.js';
import { extractPhoneNumber, normalizePhoneNumber } from './permissions.js';
import { normalizeParticipantEntry } from './welcomeMessage.js';

function participantKeys(p) {
    const keys = new Set();
    if (!p) return keys;

    for (const raw of [p.id, p.lid, p.pn, p.phoneNumber, p.jid]) {
        const jid = normalizeParticipantEntry(raw);
        if (jid) keys.add(jid);
        const phone = normalizePhoneNumber(extractPhoneNumber(jid || raw || ''));
        if (phone) keys.add(phone);
    }

    return keys;
}

class GroupParticipantSnapshot {
    constructor() {
        /** @type {Map<string, Set<string>>} */
        this._snapshots = new Map();
    }

    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    async seedGroup(sock, groupId) {
        if (!groupId?.endsWith('@g.us')) return;
        try {
            const meta = await sock.groupMetadata(groupId);
            const keys = new Set();
            for (const p of meta.participants || []) {
                for (const k of participantKeys(p)) keys.add(k);
            }
            this._snapshots.set(groupId, keys);
            logger.debug(`Participant snapshot seeded: ${groupId} (${keys.size} keys)`);
        } catch (err) {
            logger.debug(`Participant snapshot seed failed for ${groupId}: ${err.message}`);
        }
    }

    /**
     * @param {import('baileys').WASocket} sock
     */
    async seedAllGroups(sock) {
        if (!sock?.groupFetchAllParticipating) return;
        try {
            const groups = await sock.groupFetchAllParticipating();
            for (const groupId of Object.keys(groups)) {
                await this.seedGroup(sock, groupId);
            }
            logger.info(`👋 Participant snapshots seeded for ${Object.keys(groups).length} group(s)`);
        } catch (err) {
            logger.warn(`Failed to seed participant snapshots: ${err.message}`);
        }
    }

    /**
     * Seed snapshot if missing (avoids treating every member as new).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    async ensureSeeded(sock, groupId) {
        if (!groupId?.endsWith('@g.us')) return;
        if (this._snapshots.has(groupId) && this._snapshots.get(groupId).size > 0) {
            return;
        }
        await this.seedGroup(sock, groupId);
    }

    /**
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     * @returns {Promise<object[]>} new participant records
     */
    async detectNewParticipants(sock, groupId) {
        if (!groupId?.endsWith('@g.us')) return [];

        const prev = this._snapshots.get(groupId);
        if (!prev || prev.size === 0) {
            await this.seedGroup(sock, groupId);
            return [];
        }

        const meta = await sock.groupMetadata(groupId);
        const newOnes = [];
        const current = new Set();

        for (const p of meta.participants || []) {
            const keys = participantKeys(p);
            for (const k of keys) current.add(k);

            if (!keys.size) continue;

            const alreadyKnown = [...keys].some((k) => prev.has(k));
            if (!alreadyKnown) {
                newOnes.push(p);
            }
        }

        this._snapshots.set(groupId, current);
        return newOnes;
    }

    /**
     * Refresh snapshot without detecting joins (e.g. after remove).
     * @param {import('baileys').WASocket} sock
     * @param {string} groupId
     */
    async refresh(sock, groupId) {
        await this.seedGroup(sock, groupId);
    }
}

export const groupParticipantSnapshot = new GroupParticipantSnapshot();

/**
 * Resolve hint strings/objects to participant entries for welcome.
 * @param {Array<string | object>} hints
 * @returns {string[]}
 */
export function resolveJoinHints(hints) {
    const out = [];
    for (const hint of hints || []) {
        const jid = normalizeParticipantEntry(hint);
        if (jid) out.push(jid);
    }
    return [...new Set(out)];
}
