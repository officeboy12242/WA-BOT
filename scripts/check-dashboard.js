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
assert.match(html, /Bot Mission Control/);
assert.match(html, /Content Factory/);
assert.match(html, /Command Center/);
assert.match(html, /Scheduler execution flow/);
assert.match(html, /AI Insights/);
assert.match(html, /data-insight/);
assert.match(html, /data-range/);
assert.match(html, /data-view/);
assert.match(html, /api\/dashboard\/snapshot/);
assert.match(html, /api\/dashboard\/stream/);

const stats = messageQueue.stats();
assert.ok('pending' in stats);
messageQueue.destroy();

console.log('check-dashboard: ok');
