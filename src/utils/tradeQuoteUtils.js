/**
 * Ensure trade analysis uses verified live spot price, not AI guesses.
 */

/**
 * @param {string} body
 * @param {{ price?: number, changePct?: number | null, currency?: string } | null} quote
 * @returns {string}
 */
export function enforceLiveSpotPrice(body, quote) {
    if (!body || quote?.price == null) return body;

    const currency = quote.currency || 'INR';
    let line = `Spot Price: ${quote.price} ${currency}`;
    if (quote.changePct != null) {
        const sign = quote.changePct >= 0 ? '+' : '';
        line += ` (${sign}${quote.changePct}% today, live market data)`;
    } else {
        line += ' (live market data)';
    }

    if (/Spot Price:/i.test(body)) {
        return body.replace(/^Spot Price:.*$/im, line);
    }

    if (/^Stock:/im.test(body)) {
        return body.replace(/^(Stock:.*)$/im, `$1\n${line}`);
    }

    return `${line}\n${body}`;
}

/**
 * @param {{ price?: number, changePct?: number | null, currency?: string } | null} quote
 * @returns {string}
 */
export function formatMandatorySpotLine(quote) {
    if (quote?.price == null) {
        return 'MANDATORY: No live spot price — you MUST output ❌ NO TRADE only. Do not guess price.';
    }
    const currency = quote.currency || 'INR';
    const pct =
        quote.changePct != null
            ? `, ${quote.changePct >= 0 ? '+' : ''}${quote.changePct}% today`
            : '';
    return (
        `MANDATORY Spot Price line — copy EXACTLY (do not use analyst targets or old prices):\n` +
        `Spot Price: ${quote.price} ${currency}${pct} (live market data)`
    );
}
