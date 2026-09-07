/**
 * Self-check for the Interview Q scheduler.
 *
 * Regression guard for the 2026-09-07 outage: isSkippedDay() used a
 * non-capturing regex but read m[1], so every slot key produced
 * `Intl.format(Invalid Date)` → RangeError thrown BEFORE runSlot's try/catch,
 * killing the whole tick. The bot looked healthy while zero interview Qs
 * posted (Sunday masked it — nothing posts on Sunday anyway).
 *
 * 1. Unit: slotWeekday() classifies Sunday/Monday/garbage keys without throwing.
 * 2. Integration: the REAL scheduler must deliver two due slots to
 *    service.postSlotToGroups on its startup tick (the old bug produced zero).
 * 3. Resilience: a slot whose service call throws must not starve the next
 *    slot in the same tick.
 *
 * Run: node scripts/check-iq-scheduler.js
 */
import {
    startInterviewQuestionScheduler,
    slotWeekday,
} from '../src/interviewQuestion/interviewQuestion.scheduler.js';

let failures = 0;
const ok = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => {
    console.error(`✖ ${msg}`);
    failures += 1;
};

function istParts(date = new Date()) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')) % 24,
        minute: Number(get('minute')),
        weekday: get('weekday'),
    };
}

function istHmAgo(minutesAgo) {
    const now = istParts();
    const total = now.hour * 60 + now.minute - minutesAgo;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── 1) Unit: slotWeekday ────────────────────────────────────────────────────
try {
    const cases = [
        ['2026-09-06T15:00', 'Sun'],
        ['2026-09-07T11:00', 'Mon'],
        ['garbage', null],
        ['', null],
    ];
    for (const [key, expected] of cases) {
        const got = slotWeekday(key);
        if (got !== expected) fail(`slotWeekday('${key}') = ${got}, expected ${expected}`);
    }
    if (!failures) ok(`slotWeekday unit cases pass (Sun/Mon/garbage → ${slotWeekday('2026-09-06T15:00')}/${slotWeekday('2026-09-07T11:00')}/null, no throw)`);
} catch (err) {
    fail(`slotWeekday threw: ${err.message}`);
}

// ── 2) + 3) Integration against the real scheduler ─────────────────────────
const ist = istParts();
const minutesOfDay = ist.hour * 60 + ist.minute;
if (ist.weekday === 'Sun') {
    console.log('⏭ Integration scenarios skipped: scheduler is legitimately off on Sundays (by design).');
} else if (minutesOfDay < 3) {
    console.log('⏭ Integration scenarios skipped: within 3 min of IST midnight (due-times would cross the day boundary).');
} else {
    const makeConfig = (t1, t2) => ({
        INTERVIEW_Q_ENABLED: true,
        INTERVIEW_Q_TIMES: [t1, t2],
        INTERVIEW_Q_TIMEZONE: 'Asia/Kolkata',
        INTERVIEW_Q_SKIP_SUNDAY: true,
        INTERVIEW_Q_SUMMARY_TIME: '03:33',
    });
    const makeService = (impl) => ({
        recoverPendingAnswers: async () => {},
        isSlotFullyPosted: async () => false,
        postSlotToGroups: impl,
        postWeeklySummaryToGroups: async () => ({ posted: 0, groups: 0, skipped: 0 }),
    });
    const waitFor = async (predicate, timeoutMs = 9000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (predicate()) return true;
            await new Promise((r) => setTimeout(r, 200));
        }
        return predicate();
    };

    // Scenario 2: both due slots must reach the service on the startup tick.
    {
        const t1 = istHmAgo(1);
        const t2 = istHmAgo(2);
        const expected = new Set([`${ist.date}T${t1}`, `${ist.date}T${t2}`]);
        const calls = [];
        const svc = makeService(async (_sock, { slotKey }) => {
            calls.push(slotKey);
            return { posted: 1, groups: 1, skipped: 0 };
        });
        const sched = startInterviewQuestionScheduler({
            getSock: () => ({}),
            botState: {},
            service: svc,
            config: makeConfig(t1, t2),
        });
        const bothPosted = await waitFor(
            () => expected.size === 2 && [...expected].every((k) => calls.includes(k))
        );
        sched.stop();
        if (bothPosted && calls.length === 2) {
            ok(`startup tick posted both due slots (${[...expected].join(' , ')})`);
        } else {
            fail(`due slots did not all reach the service — calls=${JSON.stringify(calls)}, expected=${[...expected].join(',')}`);
        }
    }

    // Scenario 3: first slot's service call throws → second slot must still post.
    {
        const t1 = istHmAgo(1);
        const t2 = istHmAgo(2);
        const key2 = `${ist.date}T${t2}`;
        const calls = [];
        let invocations = 0;
        const svc = makeService(async (_sock, { slotKey }) => {
            invocations += 1;
            calls.push(slotKey);
            if (invocations === 1) throw new Error('boom (injected)');
            return { posted: 1, groups: 1, skipped: 0 };
        });
        const sched = startInterviewQuestionScheduler({
            getSock: () => ({}),
            botState: {},
            service: svc,
            config: makeConfig(t1, t2),
        });
        const secondPosted = await waitFor(() => {
            const i = calls.indexOf(key2);
            return i !== -1 && invocations > i;
        });
        sched.stop();
        if (secondPosted) {
            ok('a throwing slot does not starve the next slot in the tick');
        } else {
            fail(`second slot never posted after first slot threw — calls=${JSON.stringify(calls)}`);
        }
    }
}

process.exit(failures ? 1 : 0);
