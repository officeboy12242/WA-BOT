/**
 * Entry state for trade alerts (trading-copilot style).
 */

export const ENTRY_STATES = {
    VALID_ENTRY: 'VALID_ENTRY',
    ENTRY_MISSED: 'ENTRY_MISSED',
    NEXT_SESSION_WATCH: 'NEXT_SESSION_WATCH',
    PREMARKET_WATCH: 'PREMARKET_WATCH',
    NO_ACTIVE_ENTRY: 'NO_ACTIVE_ENTRY',
};

export function computeEntryState({
    marketMode,
    quote = null,
    entryLow = null,
    entryHigh = null,
    target1 = null,
} = {}) {
    const price = Number(quote?.price);
    const low = Number(entryLow);
    const high = Number(entryHigh);
    const t1 = Number(target1);

    if (marketMode === 'RESEARCH' || marketMode === 'AFTER_HOURS') {
        return { state: ENTRY_STATES.NEXT_SESSION_WATCH, label: '⏭️ Next-session watch' };
    }
    if (marketMode === 'PREMARKET' || marketMode === 'PREOPEN') {
        return { state: ENTRY_STATES.PREMARKET_WATCH, label: '🌅 Premarket watch' };
    }

    if (!Number.isFinite(price)) {
        return { state: ENTRY_STATES.NO_ACTIVE_ENTRY, label: '⛔ No active entry' };
    }

    if (Number.isFinite(t1) && price >= t1) {
        return { state: ENTRY_STATES.ENTRY_MISSED, label: '⚠️ Entry missed (past T1)' };
    }

    if (Number.isFinite(low) && Number.isFinite(high)) {
        if (price >= low && price <= high) {
            return { state: ENTRY_STATES.VALID_ENTRY, label: '✅ Valid entry' };
        }
        if (price > high * 1.035) {
            return { state: ENTRY_STATES.ENTRY_MISSED, label: '⚠️ Entry missed (chasing)' };
        }
    }

    return { state: ENTRY_STATES.NEXT_SESSION_WATCH, label: '👁️ Watch for entry zone' };
}

export function formatEntryStateLine(entryState) {
    return entryState?.label || '';
}
