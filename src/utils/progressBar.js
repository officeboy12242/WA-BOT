/**
 * Text progress bar — same style as /ping (█ filled, ░ empty).
 */
export function createProgressBar(percent, length = 10) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.round((clamped / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}
