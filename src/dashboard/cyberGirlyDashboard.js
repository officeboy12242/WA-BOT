/**
 * Public cyber-girly mission control — continuous motion, no auth.
 * Sensitive bits (phone, raw JIDs) are stripped server-side before render.
 */

export function getCyberDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sassy // Live Mission Control</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script type="module" src="https://unpkg.com/@splinetool/viewer@1.9.82/build/spline-viewer.js"></script>
<style>
:root {
  --bg0: #0a0612; --bg1: #16081f;
  --pink: #ff4fd8; --pink2: #ff7ae5; --mag: #c44cff; --cyan: #5ef2ff;
  --lilac: #d9b3ff; --text: #ffe9fb; --muted: #c9a0e0;
  --stroke: rgba(255, 126, 229, 0.35); --ok: #6dffb0; --warn: #ffd36e; --bad: #ff6b9d;
  --font: "Segoe UI", "Trebuchet MS", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: var(--font); color: var(--text);
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(255, 79, 216, 0.28), transparent 55%),
    radial-gradient(900px 500px at 90% 0%, rgba(94, 242, 255, 0.18), transparent 50%),
    radial-gradient(800px 700px at 50% 120%, rgba(196, 76, 255, 0.22), transparent 55%),
    linear-gradient(160deg, var(--bg0), var(--bg1) 55%, #1a0b28);
  overflow-x: hidden;
}
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.16; z-index: 0;
  background-image:
    linear-gradient(rgba(255,126,229,0.15) 1px, transparent 1px),
    linear-gradient(90deg, rgba(94,242,255,0.1) 1px, transparent 1px);
  background-size: 42px 42px;
  animation: gridDrift 22s linear infinite;
}
@keyframes gridDrift { to { background-position: 42px 42px; } }
#sparkles {
  position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;
}
.spark {
  position: absolute; width: 4px; height: 4px; border-radius: 50%;
  background: #fff; box-shadow: 0 0 10px #ff7ae5, 0 0 18px #5ef2ff;
  animation: floatSpark linear infinite; opacity: 0;
}
@keyframes floatSpark {
  0% { transform: translateY(100vh) scale(0.4); opacity: 0; }
  12% { opacity: 0.9; }
  100% { transform: translateY(-10vh) scale(1.2); opacity: 0; }
}
.wrap {
  max-width: 1280px; margin: 0 auto; padding: 14px 16px 48px; position: relative; z-index: 1;
  perspective: 1400px; transform-style: preserve-3d;
}

.ticker {
  overflow: hidden; border-radius: 999px; margin-bottom: 14px;
  border: 1px solid var(--stroke);
  background: rgba(12,4,20,0.65);
  box-shadow: 0 10px 28px rgba(255,79,216,0.18), 0 2px 0 rgba(255,255,255,0.08) inset;
  transform: translateZ(20px);
  transition: transform .35s ease, box-shadow .35s ease;
}
.ticker:hover {
  transform: translateZ(40px) rotateX(6deg) scale(1.01);
  box-shadow: 0 18px 40px rgba(94,242,255,0.22), 0 0 30px rgba(255,79,216,0.25);
}
.ticker-track {
  display: flex; gap: 40px; white-space: nowrap; width: max-content;
  padding: 10px 0; animation: marquee 38s linear infinite;
}
.ticker:hover .ticker-track { animation-play-state: paused; }
@keyframes marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.ticker-item {
  font-size: 0.8rem; color: #f7d6ff; letter-spacing: 0.02em;
  display: inline-flex; align-items: center; gap: 8px;
}
.ticker-item::before {
  content: "✦"; color: var(--cyan);
  animation: blink 1.4s ease-in-out infinite;
}
@keyframes blink { 50% { opacity: 0.35; transform: scale(1.25); } }

.hero {
  display: grid; grid-template-columns: 1.4fr 0.8fr; gap: 16px; align-items: stretch;
  margin-bottom: 16px; transform-style: preserve-3d;
}
@media (max-width: 900px) { .hero { grid-template-columns: 1fr; } }
.glass, .card, .kpi, .panel {
  transform-style: preserve-3d;
  will-change: transform;
}
.glass {
  background:
    linear-gradient(160deg, rgba(255,255,255,0.1), transparent 35%),
    linear-gradient(145deg, rgba(255,79,216,0.14), rgba(94,242,255,0.06) 55%, rgba(196,76,255,0.12));
  border: 1px solid var(--stroke); border-radius: 22px;
  box-shadow:
    0 1px 0 rgba(255,255,255,0.12) inset,
    0 -8px 20px rgba(0,0,0,0.35) inset,
    0 18px 40px rgba(255, 40, 180, 0.16),
    0 6px 0 rgba(90, 20, 80, 0.45);
  backdrop-filter: blur(14px);
  position: relative;
  transition: transform .2s ease, box-shadow .25s ease;
}
.glass::before {
  content: ""; position: absolute; inset: 1px; border-radius: 21px; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,0.14), transparent 28%);
  opacity: 0.55;
}
.glass::after {
  content: ""; position: absolute; inset: -1px; border-radius: 22px; pointer-events: none;
  background: linear-gradient(120deg, transparent 30%, rgba(255,122,229,0.35), transparent 70%);
  opacity: 0.35; mix-blend-mode: screen;
  animation: sheen 5.5s ease-in-out infinite;
}
@keyframes sheen {
  0%, 100% { transform: translateX(-30%); opacity: 0.15; }
  50% { transform: translateX(30%); opacity: 0.45; }
}
.tilt-active {
  box-shadow:
    0 1px 0 rgba(255,255,255,0.18) inset,
    0 -10px 24px rgba(0,0,0,0.4) inset,
    0 28px 55px rgba(255, 79, 216, 0.28),
    0 0 40px rgba(94,242,255,0.18) !important;
}
.hero-main { padding: 22px 24px; overflow: hidden; }
.hero-main h1 {
  margin: 0 0 6px; font-size: clamp(1.6rem, 3vw, 2.3rem); letter-spacing: 0.04em;
  background: linear-gradient(90deg, #fff, var(--pink2), var(--cyan), var(--pink2), #fff);
  background-size: 220% auto;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: titleShine 6s linear infinite;
}
@keyframes titleShine { to { background-position: 220% center; } }
.hero-main .sub { color: #e2b7f5; opacity: 0.9; margin-bottom: 14px; }
.live-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: 999px; margin-bottom: 12px;
  background: rgba(109,255,176,0.12); border: 1px solid rgba(109,255,176,0.35);
  color: var(--ok); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em;
}
.live-chip .pulse-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--ok);
  box-shadow: 0 0 0 0 rgba(109,255,176,0.7);
  animation: livePulse 1.6s infinite;
}
@keyframes livePulse {
  0% { box-shadow: 0 0 0 0 rgba(109,255,176,0.7); }
  70% { box-shadow: 0 0 0 12px rgba(109,255,176,0); }
  100% { box-shadow: 0 0 0 0 rgba(109,255,176,0); }
}
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill {
  padding: 7px 12px; border-radius: 999px; font-size: 0.78rem; font-weight: 600;
  border: 1px solid var(--stroke); background: rgba(0,0,0,0.25);
  display: inline-flex; align-items: center; gap: 6px;
  animation: pillFloat 4s ease-in-out infinite;
}
.pill:nth-child(2) { animation-delay: .4s; }
.pill:nth-child(3) { animation-delay: .8s; }
.pill:nth-child(4) { animation-delay: 1.2s; }
@keyframes pillFloat {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 10px currentColor; }
.dot.on { background: var(--ok); }
.dot.wait { background: var(--warn); }
#orbHost {
  height: 320px; border-radius: 22px; overflow: hidden; position: relative;
  padding: 0;
  background:
    radial-gradient(circle at 50% 80%, rgba(255,79,216,0.22), transparent 55%),
    radial-gradient(circle at 20% 20%, rgba(196,76,255,0.18), transparent 45%),
    linear-gradient(180deg, rgba(12,6,18,0.35), rgba(6,2,12,0.65));
}
#orbHost spline-viewer {
  display: block; width: 100%; height: 100%;
}
#orbHost .orb-label {
  position: absolute; left: 12px; bottom: 10px; z-index: 2;
  font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase;
  color: #ffb6f0; opacity: 0.8; pointer-events: none;
  text-shadow: 0 0 8px rgba(0,0,0,0.8);
}
#orbHost .orb-credit {
  position: absolute; right: 10px; bottom: 8px; z-index: 2;
  font-size: 0.58rem; color: #9a7ab0; opacity: 0.7;
  text-decoration: none;
}
#orbHost .orb-credit:hover { color: #ff7ae5; opacity: 1; }

.kpi-grid {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin: 14px 0 18px;
  perspective: 900px; transform-style: preserve-3d;
}
@media (max-width: 1100px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 640px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
.kpi {
  padding: 14px; border-radius: 18px; min-height: 96px; cursor: default;
  background:
    linear-gradient(165deg, rgba(255,255,255,0.12), transparent 40%),
    rgba(12, 4, 20, 0.62);
  border: 1px solid rgba(255,126,229,0.28);
  box-shadow:
    0 1px 0 rgba(255,255,255,0.1) inset,
    0 10px 0 rgba(70, 15, 70, 0.55),
    0 16px 28px rgba(255,79,216,0.12);
  transition: transform .18s ease, box-shadow .22s ease, border-color .22s ease;
  animation: kpiBreathe 3.8s ease-in-out infinite;
  transform: translateZ(0) rotateX(8deg);
}
.kpi:nth-child(odd) { animation-delay: .6s; }
@keyframes kpiBreathe {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.06); }
}
.kpi:hover, .kpi.tilt-active {
  border-color: rgba(94,242,255,0.55);
  z-index: 3;
}
.kpi .label { font-size: 0.72rem; color: #d7a8ef; letter-spacing: 0.08em; text-transform: uppercase; }
.kpi .value { font-size: 1.55rem; font-weight: 700; margin-top: 6px; color: #fff; text-shadow: 0 2px 0 rgba(0,0,0,0.35); }
.kpi .hint { font-size: 0.72rem; color: var(--cyan); margin-top: 4px; opacity: 0.9; }
.kpi.pop .value { animation: popNum .45s ease; }
@keyframes popNum {
  0% { transform: scale(1); }
  40% { transform: scale(1.18); color: var(--cyan); }
  100% { transform: scale(1); }
}

.tabs {
  display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px;
  perspective: 800px; transform-style: preserve-3d;
}
.tab {
  border: 1px solid var(--stroke); background: rgba(0,0,0,0.35); color: var(--lilac);
  padding: 11px 16px; border-radius: 999px; cursor: pointer; font-weight: 600; font-size: 0.85rem;
  transform: translateZ(0) rotateX(12deg);
  box-shadow: 0 8px 0 rgba(60, 10, 55, 0.7), 0 12px 22px rgba(255,79,216,0.12);
  transition: transform .18s ease, box-shadow .2s ease, color .2s ease, border-color .2s ease, background .2s ease;
  position: relative; overflow: hidden;
}
.tab::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: radial-gradient(circle at var(--mx, 50%) var(--my, 50%), rgba(255,255,255,0.35), transparent 45%);
  opacity: 0; transition: opacity .2s ease;
}
.tab:hover::before { opacity: 1; }
.tab:hover {
  color: #fff; border-color: var(--cyan);
  transform: translateZ(28px) rotateX(0deg) rotateY(var(--ry, 0deg)) scale(1.06);
  box-shadow:
    0 0 0 1px rgba(94,242,255,0.35),
    0 14px 0 rgba(40, 8, 50, 0.55),
    0 22px 36px rgba(255,79,216,0.35),
    0 0 28px rgba(94,242,255,0.25);
}
.tab:active {
  transform: translateZ(8px) rotateX(8deg) scale(0.98);
  box-shadow: 0 4px 0 rgba(60, 10, 55, 0.7), 0 8px 16px rgba(255,79,216,0.2);
}
.tab.active {
  color: #1a0518;
  background: linear-gradient(120deg, var(--pink), var(--cyan));
  border-color: transparent;
  box-shadow:
    0 10px 0 rgba(90, 20, 110, 0.45),
    0 18px 34px rgba(255,79,216,0.4),
    0 0 24px rgba(94,242,255,0.3);
  animation: none;
}
.tab.active:hover {
  color: #120312;
  filter: brightness(1.08);
}
.panel {
  display: none; padding: 16px;
  transform: translateZ(12px) rotateX(2deg);
}
.panel.active { display: block; animation: panelIn .4s cubic-bezier(.2,.8,.2,1); }
@keyframes panelIn {
  from { opacity: 0; transform: translateZ(-40px) rotateX(18deg) scale(0.96); }
  to { opacity: 1; transform: translateZ(12px) rotateX(2deg) scale(1); }
}
.grid-2 { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 12px; transform-style: preserve-3d; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; transform-style: preserve-3d; }
@media (max-width: 980px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }
.card {
  padding: 14px; border-radius: 18px;
  background:
    linear-gradient(165deg, rgba(255,255,255,0.1), transparent 38%),
    rgba(8,3,16,0.62);
  border: 1px solid rgba(255,126,229,0.24); min-height: 120px;
  box-shadow:
    0 1px 0 rgba(255,255,255,0.1) inset,
    0 12px 0 rgba(55, 10, 60, 0.5),
    0 18px 30px rgba(0,0,0,0.35);
  transition: transform .18s ease, box-shadow .22s ease, border-color .22s ease;
  transform: translateZ(0) rotateX(4deg);
}
.card:hover, .card.tilt-active {
  border-color: rgba(255,122,229,0.55);
  z-index: 2;
}
.card h3 {
  margin: 0 0 10px; font-size: 0.95rem; color: var(--pink2);
  letter-spacing: 0.06em; text-transform: uppercase;
}
.chart-box { position: relative; height: 240px; }
.feed {
  max-height: 360px; overflow: auto; display: flex; flex-direction: column; gap: 8px;
  scrollbar-width: thin; scrollbar-color: var(--pink) transparent;
}
.feed-item {
  padding: 10px 12px; border-radius: 14px; background: rgba(255,79,216,0.07);
  border-left: 3px solid var(--pink); font-size: 0.82rem;
  animation: slideIn .35s ease;
}
@keyframes slideIn { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
.feed-item .meta { color: #c9a0e0; font-size: 0.72rem; margin-top: 4px; }
.badge {
  display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.68rem;
  background: rgba(94,242,255,0.15); color: var(--cyan); margin-right: 6px;
}
.group-row {
  display: grid; grid-template-columns: 1.4fr 0.6fr 1.4fr; gap: 8px; align-items: center;
  padding: 10px; border-radius: 14px; margin-bottom: 8px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,126,229,0.15);
  animation: rowIn .5s ease both;
}
.group-row:nth-child(2) { animation-delay: .05s; }
.group-row:nth-child(3) { animation-delay: .1s; }
.group-row:nth-child(4) { animation-delay: .15s; }
@keyframes rowIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (max-width: 800px) { .group-row { grid-template-columns: 1fr; } }
.reasons { display: flex; flex-wrap: wrap; gap: 5px; }
.reason {
  font-size: 0.68rem; padding: 3px 8px; border-radius: 999px;
  background: rgba(196,76,255,0.2); color: #f0d6ff; border: 1px solid rgba(196,76,255,0.35);
}
.news-card {
  padding: 10px; border-radius: 14px; margin-bottom: 8px;
  background: linear-gradient(120deg, rgba(94,242,255,0.08), rgba(255,79,216,0.08));
  border: 1px solid rgba(94,242,255,0.2);
  animation: newsGlow 3.2s ease-in-out infinite;
}
@keyframes newsGlow {
  0%, 100% { border-color: rgba(94,242,255,0.2); }
  50% { border-color: rgba(255,122,229,0.55); }
}
.footer { margin-top: 16px; text-align: center; color: #b789cf; font-size: 0.75rem; opacity: 0.9; }
.live-flash {
  position: fixed; right: 16px; bottom: 16px; z-index: 20;
  padding: 10px 14px; border-radius: 14px; background: rgba(20,6,30,0.92);
  border: 1px solid var(--pink); color: #fff; font-size: 0.8rem;
  box-shadow: 0 0 24px rgba(255,79,216,0.4); transform: translateY(120%);
  transition: transform .3s ease;
}
.live-flash.show { transform: translateY(0); }
.hearts {
  position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden;
}
.heart {
  position: absolute; bottom: -20px; font-size: 14px; opacity: 0;
  animation: riseHeart linear infinite;
  filter: drop-shadow(0 0 6px #ff7ae5);
}
@keyframes riseHeart {
  0% { transform: translateY(0) rotate(0deg) scale(0.6); opacity: 0; }
  15% { opacity: 0.7; }
  100% { transform: translateY(-110vh) rotate(25deg) scale(1.1); opacity: 0; }
}
</style>
</head>
<body>
<div id="sparkles"></div>
<div class="hearts" id="hearts"></div>
<div class="wrap">
  <div class="ticker" aria-hidden="true">
    <div class="ticker-track" id="tickerTrack">
      <span class="ticker-item">Sassy bot is live</span>
      <span class="ticker-item">Free courses dropping</span>
      <span class="ticker-item">Tech news highlights</span>
      <span class="ticker-item">Movie searches buzzing</span>
      <span class="ticker-item">Public mission control</span>
    </div>
  </div>

  <div class="hero">
    <div class="glass hero-main">
      <div class="live-chip"><span class="pulse-dot"></span> PUBLIC LIVE BOARD</div>
      <h1>✦ SASSY MISSION CONTROL</h1>
      <div class="sub">Cyber-girly ops wall · courses · news · movies · groups — open for everyone</div>
      <div class="pills">
        <span class="pill"><span class="dot" id="connDot"></span> <span id="connText">connecting…</span></span>
        <span class="pill">⏱ <span id="uptime">—</span></span>
        <span class="pill">🎛 queue <span id="queueDepth">0</span></span>
        <span class="pill">🎬 movie slots <span id="movieSlots">0/6</span></span>
        <span class="pill">📡 <span id="sseState">SSE…</span></span>
      </div>
    </div>
    <div class="glass" id="orbHost">
      <!-- Official Spline Look-At demo: object tracks cursor. Swap url for any exported .splinecode -->
      <spline-viewer
        url="https://prod.spline.design/FVZWbQH2B6ndj9UU/scene.splinecode"
        events-target="global"
        background="transparent"
        loading-anim-type="spinner-small-dark"
      ></spline-viewer>
      <div class="orb-label">spline · tracks your cursor</div>
      <a class="orb-credit" href="https://viewer.spline.design/" target="_blank" rel="noopener noreferrer">Made in Spline</a>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi glass" data-kpi="courses"><div class="label">Courses today</div><div class="value" id="kCourses">0</div><div class="hint" id="kCoursesHint">unique + posts</div></div>
    <div class="kpi glass" data-kpi="news"><div class="label">News posts</div><div class="value" id="kNews">0</div><div class="hint">today</div></div>
    <div class="kpi glass" data-kpi="movies"><div class="label">Movie searches</div><div class="value" id="kMovies">0</div><div class="hint">today</div></div>
    <div class="kpi glass" data-kpi="github"><div class="label">GitHub posts</div><div class="value" id="kGithub">0</div><div class="hint">today</div></div>
    <div class="kpi glass" data-kpi="cmds"><div class="label">Commands</div><div class="value" id="kCmds">0</div><div class="hint" id="kCmdHint">ok / fail</div></div>
    <div class="kpi glass" data-kpi="lat"><div class="label">Avg latency</div><div class="value" id="kLat">0ms</div><div class="hint">commands</div></div>
  </div>

  <div class="tabs">
    <button class="tab active" data-tab="pulse">Pulse</button>
    <button class="tab" data-tab="content">Content Factory</button>
    <button class="tab" data-tab="commands">Commands</button>
    <button class="tab" data-tab="groups">Groups Intel</button>
    <button class="tab" data-tab="analytics">Analytics</button>
  </div>

  <section class="panel glass active" id="panel-pulse">
    <div class="grid-2">
      <div class="card">
        <h3>Live activity feed</h3>
        <div class="feed" id="liveFeed"></div>
      </div>
      <div class="card">
        <h3>System pulse</h3>
        <div class="chart-box"><canvas id="chartPulse"></canvas></div>
        <div style="margin-top:10px;font-size:0.8rem;color:#d7a8ef" id="sysLine">—</div>
      </div>
    </div>
  </section>

  <section class="panel glass" id="panel-content">
    <div class="grid-2">
      <div class="card">
        <h3>Posts / hour · courses vs news vs movies</h3>
        <div class="chart-box"><canvas id="chartContent"></canvas></div>
      </div>
      <div class="card">
        <h3>Today’s news highlights</h3>
        <div id="newsHighlights"></div>
      </div>
    </div>
    <div class="grid-2" style="margin-top:12px">
      <div class="card">
        <h3>Latest course drops</h3>
        <div id="courseList"></div>
      </div>
      <div class="card">
        <h3>Top movie searches</h3>
        <div class="chart-box" style="height:220px"><canvas id="chartTopMovies"></canvas></div>
      </div>
    </div>
  </section>

  <section class="panel glass" id="panel-commands">
    <div class="grid-2">
      <div class="card">
        <h3>Top commands today</h3>
        <div class="chart-box"><canvas id="chartCmds"></canvas></div>
      </div>
      <div class="card">
        <h3>Command feed</h3>
        <div class="feed" id="cmdFeed"></div>
      </div>
    </div>
  </section>

  <section class="panel glass" id="panel-groups">
    <div class="card" style="margin-bottom:12px">
      <h3>Feature footprint</h3>
      <div class="pills" id="featurePills"></div>
    </div>
    <div class="card">
      <h3>Most active groups · why they’re buzzing</h3>
      <div id="groupRank"></div>
    </div>
  </section>

  <section class="panel glass" id="panel-analytics">
    <div class="grid-3">
      <div class="card"><h3>Courses · 14d</h3><div class="chart-box"><canvas id="chartACourses"></canvas></div></div>
      <div class="card"><h3>News · 14d</h3><div class="chart-box"><canvas id="chartANews"></canvas></div></div>
      <div class="card"><h3>Movies · 14d</h3><div class="chart-box"><canvas id="chartAMovies"></canvas></div></div>
    </div>
  </section>

  <div class="footer">public 3D live board · magnetic hover tilt · manual tabs only · SSE + auto refresh</div>
</div>
<div class="live-flash" id="toast"></div>

<script>
const qs = (s) => document.querySelector(s);
const qsa = (s) => [...document.querySelectorAll(s)];
const neon = { pink: '#ff4fd8', cyan: '#5ef2ff', mag: '#c44cff', lilac: '#d9b3ff', pink2: '#ff7ae5' };
Chart.defaults.color = neon.lilac;
Chart.defaults.borderColor = 'rgba(255,126,229,0.15)';
Chart.defaults.font.family = 'Segoe UI, system-ui, sans-serif';

const charts = {};
const prevKpi = {};

function lineOpts() {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 900 },
    plugins: { legend: { display: true, labels: { boxWidth: 10 } } },
    scales: {
      x: { ticks: { maxTicksLimit: 8 }, grid: { color: 'rgba(255,126,229,0.08)' } },
      y: { beginAtZero: true, grid: { color: 'rgba(94,242,255,0.06)' } }
    },
    elements: { line: { tension: 0.4, borderWidth: 2 }, point: { radius: 0, hoverRadius: 4 } }
  };
}

function upsertChart(id, type, data, options) {
  const canvas = qs('#' + id);
  if (!canvas) return;
  if (charts[id]) { charts[id].data = data; charts[id].update(); return; }
  charts[id] = new Chart(canvas, { type, data, options });
}

function toast(msg) {
  const el = qs('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
}

function animateNumber(el, next, suffix = '') {
  const key = el.id;
  const from = Number(prevKpi[key] || 0);
  const to = Number(String(next).replace(/[^0-9.-]/g, '')) || 0;
  prevKpi[key] = to;
  if (from === to) { el.textContent = to + suffix; return; }
  const parent = el.closest('.kpi');
  if (parent) { parent.classList.remove('pop'); void parent.offsetWidth; parent.classList.add('pop'); }
  const start = performance.now();
  const dur = 650;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderFeed(el, items, mapFn) {
  el.innerHTML = items.slice(0, 40).map(mapFn).join('') || '<div class="feed-item">Waiting for the next sparkle of activity ✨</div>';
}

function updateTicker(s) {
  const bits = [];
  const c = s.content || {};
  const live = s.live || {};
  bits.push((c.uniqueCoursesToday || c.coursesToday || 0) + ' courses today');
  bits.push((c.newsToday || 0) + ' news posts');
  bits.push((c.movieSearchesToday || 0) + ' movie searches');
  bits.push((c.githubToday || 0) + ' github drops');
  const topCmd = (live.commandsToday || [])[0];
  if (topCmd) bits.push('hot cmd /' + topCmd.cmd);
  const g = (s.groups && s.groups.ranked && s.groups.ranked[0]);
  if (g) bits.push('buzzing: ' + String(g.name || '').slice(0, 28));
  bits.push('Sassy is online and serving looks');
  const doubled = bits.concat(bits).map(t => '<span class="ticker-item">' + t + '</span>').join('');
  qs('#tickerTrack').innerHTML = doubled;
}

function applySnapshot(s) {
  const conn = s.connection || {};
  const live = s.live || {};
  const content = s.content || {};
  const groups = s.groups || {};
  const analytics = s.analytics || {};
  const queue = s.queue || {};
  const movie = s.movieConcurrency || {};

  const status = conn.status || 'unknown';
  const dot = qs('#connDot');
  dot.className = 'dot' + (status === 'connected' ? ' on' : status === 'waiting_for_scan' ? ' wait' : '');
  qs('#connText').textContent = status === 'connected' ? 'bot online' : String(status).replaceAll('_', ' ');
  qs('#queueDepth').textContent = String(queue.pending || 0);
  qs('#movieSlots').textContent = (movie.active || 0) + '/' + (movie.max || 6);
  if (s.uptime != null) {
    const u = Math.floor(s.uptime);
    qs('#uptime').textContent = Math.floor(u/3600) + 'h ' + Math.floor((u%3600)/60) + 'm ' + (u%60) + 's';
  }

  animateNumber(qs('#kCourses'), content.uniqueCoursesToday ?? content.coursesToday ?? 0);
  qs('#kCoursesHint').textContent = (content.coursesToday || 0) + ' group posts · ' + (content.coursesWeek || 0) + ' week';
  animateNumber(qs('#kNews'), content.newsToday || 0);
  animateNumber(qs('#kMovies'), content.movieSearchesToday || 0);
  animateNumber(qs('#kGithub'), content.githubToday || 0);
  const cmdTotal = (live.commandOk || 0) + (live.commandFail || 0);
  animateNumber(qs('#kCmds'), cmdTotal);
  qs('#kCmdHint').textContent = (live.commandOk || 0) + ' ok · ' + (live.commandFail || 0) + ' fail';
  animateNumber(qs('#kLat'), live.avgLatencyMs || 0, 'ms');

  updateTicker(s);

  renderFeed(qs('#liveFeed'), live.recent || [], (ev) => {
    const title = ev.cmd || ev.kind || ev.message || ev.query || 'update';
    return '<div class="feed-item"><span class="badge">' + (ev.type || 'event') + '</span><strong>' +
      String(title).slice(0, 80) + '</strong><div class="meta">' + fmtTime(ev.at) +
      (ev.ms != null ? ' · ' + ev.ms + 'ms' : '') +
      (ev.status ? ' · ' + ev.status : '') + '</div></div>';
  });

  renderFeed(qs('#cmdFeed'), (live.recent || []).filter(e => e.type === 'command'), (ev) =>
    '<div class="feed-item"><span class="badge">/' + (ev.cmd || '?') + '</span>' + (ev.status || '') +
    '<div class="meta">' + fmtTime(ev.at) + (ev.ms != null ? ' · ' + ev.ms + 'ms' : '') + '</div></div>'
  );

  qs('#newsHighlights').innerHTML = (content.recentNews || []).slice(0, 8).map(n =>
    '<div class="news-card"><strong>' + String(n.title || '').slice(0, 120) +
    '</strong><div class="meta" style="color:#c9a0e0;font-size:0.72rem;margin-top:4px">' + fmtTime(n.at) + '</div></div>'
  ).join('') || '<div class="news-card">No news posts yet today</div>';

  qs('#courseList').innerHTML = (content.recentCourses || []).slice(0, 10).map(c =>
    '<div class="feed-item"><span class="badge">course</span>' + String(c.name || '').slice(0, 90) +
    '<div class="meta">' + fmtTime(c.at) + '</div></div>'
  ).join('') || '<div class="feed-item">No courses posted today</div>';

  const fc = groups.featureCounts || {};
  qs('#featurePills').innerHTML = [
    ['courses', fc.courses], ['news', fc.news], ['movie', fc.movie],
    ['summary', fc.summary], ['github', fc.github], ['tracked groups', fc.total]
  ].map(([k,v]) => '<span class="pill">' + k + ' · <strong>' + (v||0) + '</strong></span>').join('');

  qs('#groupRank').innerHTML = (groups.ranked || []).map((g, i) =>
    '<div class="group-row"><div><strong>#' + (i+1) + ' ' + String(g.name||'').slice(0,40) +
    '</strong><div class="meta" style="color:#c9a0e0;font-size:0.72rem">score ' + g.score +
    ' · chat ' + g.chat + ' · movie ' + g.movie + '</div></div><div>⚡ ' + g.score +
    '</div><div class="reasons">' + (g.reasons||[]).map(r => '<span class="reason">' + r + '</span>').join('') +
    '</div></div>'
  ).join('') || '<div class="feed-item">No group activity yet today</div>';

  const ch = content.charts || {};
  const labels = (ch.coursesHourly && ch.coursesHourly.labels) || [];
  upsertChart('chartContent', 'line', {
    labels,
    datasets: [
      { label: 'Courses', data: (ch.coursesHourly && ch.coursesHourly.values) || [], borderColor: neon.pink, backgroundColor: 'rgba(255,79,216,0.15)', fill: true },
      { label: 'News', data: (ch.newsHourly && ch.newsHourly.values) || [], borderColor: neon.cyan, backgroundColor: 'rgba(94,242,255,0.1)', fill: true },
      { label: 'Movies', data: (ch.movieHourly && ch.movieHourly.values) || [], borderColor: neon.mag, backgroundColor: 'rgba(196,76,255,0.12)', fill: true }
    ]
  }, lineOpts());

  const top = content.topMovies || [];
  upsertChart('chartTopMovies', 'bar', {
    labels: top.map(t => String(t.query||'').slice(0,18)),
    datasets: [{ label: 'Searches', data: top.map(t => t.count), backgroundColor: 'rgba(255,79,216,0.55)', borderRadius: 8 }]
  }, { responsive: true, maintainAspectRatio: false, animation: { duration: 800 }, plugins: { legend: { display: false } },
       scales: { x: { ticks: { maxRotation: 45 } }, y: { beginAtZero: true } } });

  const cmds = live.commandsToday || [];
  upsertChart('chartCmds', 'doughnut', {
    labels: cmds.slice(0, 8).map(c => '/' + c.cmd),
    datasets: [{ data: cmds.slice(0, 8).map(c => c.count),
      backgroundColor: ['#ff4fd8','#5ef2ff','#c44cff','#ff7ae5','#7ef0ff','#e9a0ff','#ff9ad5','#a6f7ff'] }]
  }, { responsive: true, maintainAspectRatio: false, animation: { animateRotate: true, duration: 900 }, plugins: { legend: { position: 'right' } } });

  const pulseVals = labels.map((_, i) =>
    ((ch.coursesHourly && ch.coursesHourly.values[i]) || 0) +
    ((ch.newsHourly && ch.newsHourly.values[i]) || 0) +
    ((ch.movieHourly && ch.movieHourly.values[i]) || 0)
  );
  upsertChart('chartPulse', 'line', {
    labels,
    datasets: [{ label: 'Activity units', data: pulseVals, borderColor: neon.pink2, backgroundColor: 'rgba(255,122,229,0.18)', fill: true }]
  }, lineOpts());

  upsertChart('chartACourses', 'bar', {
    labels: (analytics.coursesDaily && analytics.coursesDaily.labels) || [],
    datasets: [{ data: (analytics.coursesDaily && analytics.coursesDaily.values) || [], backgroundColor: 'rgba(255,79,216,0.5)', borderRadius: 6 }]
  }, { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } });
  upsertChart('chartANews', 'bar', {
    labels: (analytics.newsDaily && analytics.newsDaily.labels) || [],
    datasets: [{ data: (analytics.newsDaily && analytics.newsDaily.values) || [], backgroundColor: 'rgba(94,242,255,0.45)', borderRadius: 6 }]
  }, { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } });
  upsertChart('chartAMovies', 'bar', {
    labels: (analytics.moviesDaily && analytics.moviesDaily.labels) || [],
    datasets: [{ data: (analytics.moviesDaily && analytics.moviesDaily.values) || [], backgroundColor: 'rgba(196,76,255,0.5)', borderRadius: 6 }]
  }, { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } });

  qs('#sysLine').textContent = 'Public board · trade today ' + (content.tradeToday || 0) + ' · updated ' + fmtTime(s.at);
}

async function refresh() {
  try {
    const res = await fetch('/api/dashboard/snapshot');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applySnapshot(await res.json());
  } catch (err) {
    qs('#connText').textContent = 'snapshot error';
    console.warn(err);
  }
}

function connectSSE() {
  const es = new EventSource('/api/dashboard/stream');
  qs('#sseState').textContent = 'SSE connecting';
  es.onopen = () => { qs('#sseState').textContent = 'live'; };
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      if (ev.type === 'hello' || ev.type === 'ping') return;
      toast('✦ ' + (ev.type || 'event') + ' · ' + (ev.cmd || ev.kind || ev.message || ev.query || 'tick'));
      if (ev.type === 'command' || ev.type === 'post' || ev.type === 'movie') refresh();
      else {
        const feed = qs('#liveFeed');
        const node = document.createElement('div');
        node.className = 'feed-item';
        node.innerHTML = '<span class="badge">' + (ev.type||'evt') + '</span>' +
          String(ev.cmd || ev.kind || ev.message || 'update').slice(0,80);
        feed.prepend(node);
      }
    } catch {}
  };
  es.onerror = () => { qs('#sseState').textContent = 'SSE retry'; };
}

qsa('.tab').forEach(btn => btn.addEventListener('click', () => {
  qsa('.tab').forEach(b => b.classList.remove('active'));
  qsa('.panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  qs('#panel-' + btn.dataset.tab).classList.add('active');
}));

/* Magnetic 3D tilt — unique cursor-follow hover (no auto tab switching) */
(function tilt3d() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  function bindTilt(el, { maxX = 14, maxY = 18, lift = 26 } = {}) {
    let raf = 0;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const ry = (px - 0.5) * maxY;
      const rx = (0.5 - py) * maxX;
      el.style.setProperty('--mx', (px * 100) + '%');
      el.style.setProperty('--my', (py * 100) + '%');
      el.style.setProperty('--ry', ry.toFixed(2) + 'deg');
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.classList.add('tilt-active');
        el.style.transform =
          'translateZ(' + lift + 'px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) scale(1.03)';
      });
    });
    el.addEventListener('pointerleave', () => {
      cancelAnimationFrame(raf);
      el.classList.remove('tilt-active');
      el.style.transform = '';
      el.style.removeProperty('--mx');
      el.style.removeProperty('--my');
      el.style.removeProperty('--ry');
    });
  }

  qsa('.tab').forEach((el) => bindTilt(el, { maxX: 10, maxY: 16, lift: 30 }));
  qsa('.kpi').forEach((el) => bindTilt(el, { maxX: 16, maxY: 18, lift: 34 }));
  qsa('.card').forEach((el) => bindTilt(el, { maxX: 10, maxY: 12, lift: 22 }));
  qsa('.hero-main').forEach((el) => bindTilt(el, { maxX: 8, maxY: 10, lift: 18 }));
})();

/* Floating sparkles */
(function sparks() {
  const host = qs('#sparkles');
  for (let i = 0; i < 28; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = Math.random() * 100 + '%';
    s.style.animationDuration = (8 + Math.random() * 14) + 's';
    s.style.animationDelay = (Math.random() * 10) + 's';
    s.style.width = s.style.height = (2 + Math.random() * 3) + 'px';
    host.appendChild(s);
  }
})();

/* Soft rising hearts */
(function hearts() {
  const host = qs('#hearts');
  const glyphs = ['♡','✦','✧','💖','🌸'];
  for (let i = 0; i < 14; i++) {
    const h = document.createElement('div');
    h.className = 'heart';
    h.textContent = glyphs[i % glyphs.length];
    h.style.left = Math.random() * 100 + '%';
    h.style.animationDuration = (10 + Math.random() * 16) + 's';
    h.style.animationDelay = (Math.random() * 12) + 's';
    h.style.fontSize = (10 + Math.random() * 14) + 'px';
    host.appendChild(h);
  }
})();

refresh();
connectSSE();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
