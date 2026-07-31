import { getCyberDashboardHtml } from '../src/dashboard/cyberGirlyDashboard.js';

const h = getCyberDashboardHtml();
if (h.includes('upgradeIcons')) throw new Error('upgradeIcons hack still present');
if (h.includes(",'C'],['News")) throw new Error('letter KPI icons still present');
if (!h.includes('📚') || !h.includes('📰') || !h.includes('🎬')) throw new Error('emoji KPI icons missing');
if (!h.includes('group-kpi-icon')) throw new Error('group icons missing');
console.log('OK icons fixed at render time');
