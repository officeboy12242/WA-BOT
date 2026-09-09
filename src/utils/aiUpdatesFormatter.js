/**
 * Format one AI update as a plain WhatsApp message — headline, one line on
 * why it matters, source link. No tags, no mentions, no decoration.
 */

/**
 * @param {{ title: string, url: string }} item
 * @param {string} whyItMatters
 */
export function formatAiUpdateMessage(item, whyItMatters) {
    let text = '🤖 *AI Updates*\n\n';
    text += `*${item.title}*\n`;
    if (whyItMatters) {
        text += `${whyItMatters}\n`;
    }
    // Full URL on its own line — WhatsApp generates the link preview from this.
    text += `\n${item.url}`;
    return text;
}
