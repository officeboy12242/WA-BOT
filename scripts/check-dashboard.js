/**
 * Self-check: dashboard HTML + telemetry counters + bandwidth-aware refresh.
 */
import assert from 'node:assert/strict';
import { botTelemetry } from '../src/utils/botTelemetry.js';
import { getCyberDashboardHtml } from '../src/dashboard/cyberGirlyDashboard.js';
import { messageQueue } from '../src/utils/messageQueue.js';
import DashboardService from '../src/services/DashboardService.js';

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
assert.match(html, /Feature adoption/);
assert.match(html, /groupSearch/);
assert.match(html, /View details/);
assert.match(html, /data-range/);
assert.match(html, /data-view/);
assert.match(html, /api\/dashboard\/snapshot/);
assert.match(html, /api\/dashboard\/stream/);

// Bandwidth-aware client
assert.match(html, /POLL_MS=60000/);
assert.match(html, /DEBOUNCE_MS=2500/);
assert.match(html, /If-None-Match/);
assert.match(html, /scheduleRefresh/);
assert.match(html, /visibilitychange/);
assert.match(html, /pageVisible/);
assert.match(html, /every 60 seconds/);
assert.doesNotMatch(html, /every 15 seconds/);
assert.doesNotMatch(html, /setInterval\(refresh,15000\)/);
assert.match(html, /Jobs pending/);
assert.match(html, /s\.jobs\?\.pending/);

const svc = new DashboardService({});
assert.equal(typeof svc.getCachedSnapshot, 'function');
assert.equal(typeof svc.invalidateSnapshotCache, 'function');
assert.equal(typeof svc.getJobQueueStats, 'function');
svc._snapCache = { snap: { at: 'cached' }, expires: Date.now() + 10_000 };
const cached = await svc.getCachedSnapshot();
assert.equal(cached.at, 'cached');
svc.invalidateSnapshotCache();
assert.equal(svc._snapCache, null);

const stats = messageQueue.stats();
assert.ok('pending' in stats);
messageQueue.destroy();

console.log('check-dashboard: ok');
