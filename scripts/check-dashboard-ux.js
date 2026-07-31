import { getCyberDashboardHtml } from '../src/dashboard/cyberGirlyDashboard.js';
import fs from 'fs';

const h = getCyberDashboardHtml();
const need = [
  'Workload &amp; movie vault',
  'id="movieSlots"',
  'id="movieCachePanel"',
  'id="analyticsMix"',
  'id="analyticsDays"',
  'id="aiActions"',
  'id="insightStatus"',
  'data-insight="workload"',
  'function renderAnalytics',
  'function seriesStats',
];
let bad = 0;
for (const n of need) {
  const ok = h.includes(n);
  if (!ok) bad += 1;
  console.log(ok ? 'ok' : 'MISS', n);
}

const script = h.split('<script>')[1].split('</script>')[0];
try {
  new Function(script);
  console.log('ok script parses');
} catch (e) {
  bad += 1;
  console.error('script parse fail', e.message);
}

const svc = fs.readFileSync('src/services/DashboardService.js', 'utf8');
if (!svc.includes('getMovieCacheStats') || !svc.includes('movieCache')) {
  bad += 1;
  console.error('MISS movieCache in DashboardService');
} else {
  console.log('ok DashboardService movieCache');
}

if (bad) throw new Error(bad + ' checks failed');
console.log('OK dashboard ux redesign checks');
