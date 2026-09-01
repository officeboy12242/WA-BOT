/**
 * Hidden @all for WhatsApp groups — notifies members without listing numbers.
 * Pattern already used by IPO alerts: bare `@` tokens + mentions[] array.
 */

import { jidNormalizedUser } from 'baileys';

/**
 * @param {import('baileys').WASocket} sock
 * @param {string} groupId
 * @param {{ excludeJids?: string[], max?: number }} [opts]
 * @returns {Promise<{ mentions: string[], tagText: string }>}
 */
export async function buildHiddenMentionAll(sock, groupId, opts = {}) {
    if (!sock || !groupId?.endsWith('@g.us')) {
        return { mentions: [], tagText: '' };
    }

    try {
        const meta = await sock.groupMetadata(groupId);
        const exclude = new Set(
            (opts.excludeJids || [])
                .map((j) => jidNormalizedUser(j) || j)
                .filter(Boolean)
        );
        const me = jidNormalizedUser(sock.user?.id) || sock.user?.id;
        if (me) exclude.add(me);
        if (sock.user?.lid) {
            const lid = jidNormalizedUser(sock.user.lid) || sock.user.lid;
            if (lid) exclude.add(lid);
        }

        let mentions = (meta.participants || [])
            .map((p) => p.id || p)
            .filter(Boolean)
            .filter((id) => !exclude.has(jidNormalizedUser(id) || id));

        const max = Math.max(1, Number(opts.max) || 900);
        if (mentions.length > max) mentions = mentions.slice(0, max);

        const tagText = mentions.length ? `\n\n${mentions.map(() => '@').join(' ')}` : '';
        return { mentions, tagText };
    } catch {
        return { mentions: [], tagText: '' };
    }
}

/**
 * @param {string} text
 * @param {{ mentions: string[], tagText: string }} pack
 */
export function withHiddenMentions(text, pack) {
    const mentions = pack?.mentions?.length ? pack.mentions : undefined;
    return {
        text: `${text || ''}${pack?.tagText || ''}`,
        ...(mentions ? { mentions } : {}),
    };
}
