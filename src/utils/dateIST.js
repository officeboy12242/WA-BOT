/**
 * Calendar date helpers in Asia/Kolkata (IST).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function getTodayDateStrIST(fromMs = Date.now()) {
    const ist = new Date(fromMs + IST_OFFSET_MS);
    return ist.toISOString().split('T')[0];
}

/** Calendar day that just ended — used when recap posts at midnight. */
export function getYesterdayDateStrIST(fromMs = Date.now()) {
    return getTodayDateStrIST(fromMs - 24 * 60 * 60 * 1000);
}

/**
 * Which IST calendar day to summarize when the job runs.
 * Midnight (00:00) → day that just ended; evening slot → same IST date.
 */
export function getRecapDateStrIST(fromMs = Date.now(), recapHour = 0, recapMinute = 0) {
    if (recapHour === 0 && recapMinute === 0) {
        return getYesterdayDateStrIST(fromMs);
    }
    return getTodayDateStrIST(fromMs);
}

export function formatDateLabelIST(dateStr) {
    return new Date(`${dateStr}T00:00:00+05:30`).toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}
