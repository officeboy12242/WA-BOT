/**
 * Self-check: dashboard HTML + telemetry counters.
 */
import assert from 'node:assert/strict';
import { botTelemetry } from '../src/utils/botTelemetry.js';
import { getCyberDashboardHtml } from '../src/dashboard/cyberGirlyDashboard.js';
import { messageQueue } from '../src/utils/messageQueue.js';

botTelemetry.track('command', { cmd: 'movie', status: 'ok', ms: 40, chatId: 'g@g.us' });
botTelemetry.track('post', { kind: 'news', title: 'AI chips' });
const live = botTelemetry.liveStats();
assert.ok(live.commandsToday.some((c) => c.cmd === 'movie'));
assert.equal(live.postsToday.news, 1);

const html = getCyberDashboardHtml();
assert.match(html, /MISSION CONTROL/);
assert.match(html, /chartContent/);
assert.match(html, /PUBLIC LIVE/);
assert.match(html, /tilt3d|Magnetic 3D tilt/);
assert.doesNotMatch(html, /autoTabs|Auto-rotate tabs/);

const stats = messageQueue.stats();
assert.ok('pending' in stats);

console.log('check-dashboard: ok');
