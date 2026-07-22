import { formatProgressLine } from '../src/utils/progressBar.js';

const dialogue = '🎬 _"Mogambo khush hua!"_ — Your movie is being found... 🔍';
const query = 'Avengers';

function formatSourceLine(emoji, label, status, detail = '') {
    let line;
    if (status === 'done') {
        line = `${emoji} ${label} ✓${detail ? ` (${detail})` : ''}`;
    } else {
        line = `${emoji} ${label} …`;
    }
    return `> ${line}`;
}

function formatMovieSearchProgress(dialogue, query, state) {
    const percent = state.percent ?? 0;

    let msg = `${dialogue}\n\n`;
    msg += `*$ movie --search*\n`;
    msg += `> *${query}*\n`;
    msg += `${formatProgressLine('SRC', percent, { decimals: 1 })}\n`;
    msg += `\n*$ sources*\n`;

    if (state.hd !== undefined) {
        const detail = state.hdCount != null ? `${state.hdCount} found` : '';
        msg += `${formatSourceLine('📡', 'HDHub4u', state.hd, detail)}\n`;
    }
    if (state.drive !== undefined) {
        const detail = state.driveCount != null ? `${state.driveCount} found` : '';
        msg += `${formatSourceLine('💾', 'Drive vault', state.drive, detail)}\n`;
    }
    if (state.atoz !== undefined) {
        const detail = state.atozCount != null ? `${state.atozCount} found` : '';
        msg += `${formatSourceLine('📺', 'AtoZ cinema', state.atoz, detail)}\n`;
    }
    if (state.shorten === 'loading') {
        msg += '> 🔗 Shortening links…\n';
    }

    return msg.trimEnd();
}

console.log('--- /ping style reference ---\n');
console.log(formatProgressLine('CPU', 39.2, { decimals: 1 }));
console.log(formatProgressLine('MEM', 59.7, { decimals: 1 }));

console.log('\n--- Movie search (45%) ---\n');
console.log(formatMovieSearchProgress(dialogue, query, {
    percent: 45,
    hd: 'done',
    hdCount: 4,
    drive: 'loading',
    atoz: 'loading',
}));
