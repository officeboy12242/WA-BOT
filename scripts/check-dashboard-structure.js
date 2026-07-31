import { getCyberDashboardHtml } from '../src/dashboard/cyberGirlyDashboard.js';

const h = getCyberDashboardHtml();
const ids = ['pulse', 'content', 'commands', 'groups', 'analytics', 'insights', 'settings'];
let bad = 0;
for (const id of ids) {
  const i = h.indexOf(`id="${id}"`);
  const j = h.indexOf('</section>', i);
  const chunk = h.slice(i, j);
  const tip = chunk.includes('class="tip"');
  const title = chunk.includes('section-title');
  const inlineStyle = /<style>/.test(chunk);
  const ok = tip && title && !inlineStyle;
  if (!ok) bad += 1;
  console.log(id, { tip, title, inlineStyle, ok });
}
if (h.includes('style="margin-top:16px"')) {
  console.log('warn: leftover inline margin-top still present');
}
if (bad) throw new Error(`${bad} page(s) not aligned`);
console.log('OK all pages share title + tip structure');
