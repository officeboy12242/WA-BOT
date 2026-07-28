/**
 * Self-check: big-group cache warm + summarynow ACL + chat-log day count cache.
 */
import assert from 'node:assert/strict';
import { findCommand } from '../src/commands/registry.js';
import GroupManager from '../src/models/GroupManager.js';
import { groupParticipantSnapshot } from '../src/utils/groupParticipantSnapshot.js';

const summaryNow = findCommand('/summarynow');
assert.equal(summaryNow?.role, 'admins', '/summarynow must be admins+owner (admins role)');

const gm = new GroupManager({}, {}, {
    OWNER_NUMBERS: ['9999999999'],
    MODERATOR_NUMBERS: [],
});

const fakeParticipating = {
    '120363@g.us': {
        id: '120363@g.us',
        subject: 'Big Group',
        participants: Array.from({ length: 50 }, (_, i) => ({
            id: `91${String(i).padStart(10, '0')}@s.whatsapp.net`,
            admin: i === 0 ? 'superadmin' : null,
        })),
    },
};

const warmed = gm.warmMetaFromParticipating(fakeParticipating);
assert.equal(warmed, 1);

const meta = await gm.getGroupMetadataCached(
    { groupMetadata: async () => { throw new Error('should use cache'); } },
    '120363@g.us',
);
assert.equal(meta.subject, 'Big Group');
assert.equal(meta.participants.length, 50);

const seeded = groupParticipantSnapshot.seedFromParticipating(fakeParticipating);
assert.equal(seeded, 1);
assert.ok(groupParticipantSnapshot.cloneGroupKeys('120363@g.us').size >= 50);

console.log('check-big-group-perf: ok');
