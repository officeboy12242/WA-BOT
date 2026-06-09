/**
 * Format Inshorts articles for WhatsApp — always a single message
 */

const HEADER = '⚡️ *TECH FLASH* ⚡️';
const FOOTER = `${'━'.repeat(24)}\n⚡ Powered by CoursesDrivee`;
const SEPARATOR = `\n\n${'─'.repeat(24)}\n\n`;
const MAX_MSG_LEN = 4090;

function escapeWhatsApp(text) {
    return text.replace(/[*_~`]/g, (ch) => `\\${ch}`);
}

function buildBlock(article, summaryMaxLen) {
    let summary = article.summary || '';
    if (summaryMaxLen > 0 && summary.length > summaryMaxLen) {
        summary = `${summary.slice(0, Math.max(0, summaryMaxLen - 3))}...`;
    }
    return `📌 *${escapeWhatsApp(article.title)}*\n\n💬 ${escapeWhatsApp(summary)}`;
}

function assembleMessage(blocks) {
    const body = blocks.join(SEPARATOR);
    return `${HEADER}\n\n${body}\n\n${FOOTER}`;
}

/**
 * @param {Array<{title: string, summary: string}>} articles
 * @returns {string}
 */
export function formatNewsPost(articles) {
    const arts = articles.slice(0, 10);
    if (!arts.length) {
        return '';
    }

    for (let summaryMax = 500; summaryMax >= 60; summaryMax -= 40) {
        const msg = assembleMessage(arts.map((a) => buildBlock(a, summaryMax)));
        if (msg.length <= MAX_MSG_LEN) {
            return msg;
        }
    }

    for (let count = arts.length; count >= 1; count--) {
        const subset = arts.slice(0, count);
        for (let summaryMax = 300; summaryMax >= 60; summaryMax -= 40) {
            const msg = assembleMessage(subset.map((a) => buildBlock(a, summaryMax)));
            if (msg.length <= MAX_MSG_LEN) {
                return msg;
            }
        }
    }

    return assembleMessage([buildBlock(arts[0], 200)]);
}

/**
 * @param {Array<{title: string, summary: string}>} articles
 * @returns {string[]}
 */
export function formatNewsPosts(articles) {
    const single = formatNewsPost(articles);
    return single ? [single] : [];
}
