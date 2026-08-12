/**
 * Self-check for GitHub freshness + past-slot helpers.
 * Run: node scripts/check-github-post-fix.js
 */

import { getPastDueSlotsToday, formatSlotKey } from '../src/utils/newsScheduler.js';

// Past slots: 09:00 and 11:30 should be past at 12:00; 14:00 not.
// Fixed "now" (noon IST) so the check is deterministic at any hour of the day.
const times = ['09:00', '11:30', '14:00', '16:30', '19:00'];
const noonIst = new Date('2026-08-12T12:00:00+05:30');
const past = getPastDueSlotsToday(times, 'Asia/Kolkata', noonIst);
if (!Array.isArray(past) || past.length === 0) {
    throw new Error('expected some past slots at noon IST; got ' + past.length);
}
if (past.length !== 2 || past[0].index !== 0 || past[1].index !== 1) {
    throw new Error('at noon IST only 09:00 and 11:30 should be past; got ' + JSON.stringify(past.map((s) => s.index)));
}
for (const slot of past) {
    if (typeof slot.index !== 'number') throw new Error('slot index missing');
    const key = formatSlotKey(new Date(), 'Asia/Kolkata', slot.hour, slot.minute);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(key)) throw new Error('bad slot key ' + key);
}

// filterFreshForGroups semantics — inline mock of the new rule
async function filterFreshForGroups(repos, postedMap, groupIds) {
    const fresh = [];
    for (const repo of repos) {
        let missingSomewhere = false;
        for (const gid of groupIds) {
            if (!postedMap.has(`${repo}:${gid}`)) {
                missingSomewhere = true;
                break;
            }
        }
        if (missingSomewhere) fresh.push(repo);
    }
    return fresh;
}

const groups = ['g1', 'g2', 'g3'];
const posted = new Set(['owner/repo:g1']); // partial fan-out
const fresh = await filterFreshForGroups(['owner/repo', 'other/repo'], posted, groups);
if (!fresh.includes('owner/repo')) throw new Error('partial post should still be fresh');
if (!fresh.includes('other/repo')) throw new Error('unposted should be fresh');

const postedAll = new Set(['owner/repo:g1', 'owner/repo:g2', 'owner/repo:g3']);
const fresh2 = await filterFreshForGroups(['owner/repo'], postedAll, groups);
if (fresh2.length !== 0) throw new Error('fully posted should not be fresh');

console.log('github post fix check ok');
