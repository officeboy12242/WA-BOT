/**
 * Parse BUY / NO TRADE signals from AI trade analysis text.
 */

export function parseTradeSignal(body) {
    const text = String(body || '');
    const recLine = text.match(/Recommendation:\s*(.+)/i)?.[1]?.trim() || '';
    const confMatch = text.match(/Confidence\s*Score:\s*(\d{1,3})\s*%?/i);
    const confidence = confMatch ? Math.min(100, parseInt(confMatch[1], 10)) : 0;

    const isNoTrade = /NO\s*TRADE/i.test(recLine) || /❌/.test(recLine);
    const isBuyCall = /BUY\s*CALL/i.test(recLine) && !isNoTrade;
    const isBuyPut = /BUY\s*PUT/i.test(recLine) && !isNoTrade;

    const minConfidence = 70;
    const isActionable =
        (isBuyCall || isBuyPut) && confidence >= minConfidence && !isNoTrade;

    return {
        confidence,
        isBuyCall,
        isBuyPut,
        isNoTrade: isNoTrade || (!isBuyCall && !isBuyPut),
        isActionable,
        recommendation: recLine,
    };
}

/**
 * Extract JSON symbol list from AI discovery response.
 * @returns {string[]}
 */
export function parseDiscoverySymbols(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];

    const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = jsonBlock || text;

    try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
            return parsed.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
        }
        if (Array.isArray(parsed.symbols)) {
            return parsed.symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
        }
        if (Array.isArray(parsed.picks)) {
            return parsed.picks
                .map((p) => (typeof p === 'string' ? p : p?.symbol))
                .filter(Boolean)
                .map((s) => String(s).trim().toUpperCase());
        }
    } catch {
        // fall through
    }

    const arrayMatch = candidate.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
        try {
            const arr = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arr)) {
                return arr.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
            }
        } catch {
            // ignore
        }
    }

    return [];
}
