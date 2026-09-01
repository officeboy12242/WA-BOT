/**
 * Relay Univest research picks → WhatsApp groups via webhook.
 * Your Univest backend POSTs here when a pick is published — no scraping needed.
 */

import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { plainSendMessage } from '../utils/waMessage.js';
import { formatUnivestPick, normalizeUnivestPick } from '../utils/univestPickFormat.js';

export function parseUnivestWebhookBody(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body.map(normalizeUnivestPick).filter(Boolean);
    if (Array.isArray(body.picks)) return body.picks.map(normalizeUnivestPick).filter(Boolean);
    if (Array.isArray(body.data)) return body.data.map(normalizeUnivestPick).filter(Boolean);
    const one = normalizeUnivestPick(body);
    return one ? [one] : [];
}

export class UnivestPickRelay {
    constructor(cfg = config) {
        this.groups = (cfg.UNIVEST_PICK_GROUPS || []).filter(Boolean);
        this.enabled = cfg.UNIVEST_WEBHOOK_ENABLED !== false && this.groups.length > 0;
    }

    setGroups(groups) {
        this.groups = (groups || []).filter(Boolean);
        this.enabled = config.UNIVEST_WEBHOOK_ENABLED !== false && this.groups.length > 0;
    }

    async relay(sock, body) {
        if (!this.enabled) {
            return { ok: false, error: 'UNIVEST webhook disabled or UNIVEST_PICK_GROUPS empty' };
        }
        if (!sock) {
            return { ok: false, error: 'WhatsApp not connected' };
        }

        const picks = parseUnivestWebhookBody(body);
        if (!picks.length) {
            return { ok: false, error: 'No valid picks (need symbol + action)' };
        }

        let sent = 0;
        for (const pick of picks) {
            const text = formatUnivestPick(pick);
            if (!text) continue;
            for (const chatId of this.groups) {
                try {
                    await plainSendMessage(sock, chatId, { text, linkPreview: false });
                    sent++;
                } catch (err) {
                    logger.warn(`Univest pick relay failed ${chatId}: ${err.message}`);
                }
            }
        }

        logger.info(`Univest pick relay: ${picks.length} pick(s) → ${sent} message(s)`);
        return { ok: true, picks: picks.length, sent };
    }
}

export const univestPickRelay = new UnivestPickRelay();
