import { SpeedTest } from './engine.js';
import { summarize, perSize, aimScores, fmtBps, fmtMs, fmtBytes } from './stats.js';
import { latencyChart, throughputChart } from './charts.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const basePath = body.dataset.basePath || '';
const HISTORY_KEY = 'flash.history.v1';
const ENDPOINT_KEY = 'flash.endpoint.v1';

const PRESETS = {
  this: () => ({ label: `${location.host}${basePath}`, downloadUrl: `${basePath}/__down`, uploadUrl: `${basePath}/__up`, turnUrl: `${basePath}/__turn`, metaUrl: `${basePath}/__meta` }),
  cloudflare: () => ({ label: 'speed.cloudflare.com', downloadUrl: 'https://speed.cloudflare.com/__down', uploadUrl: 'https://speed.cloudflare.com/__up', turnUrl: null, metaFromHeaders: true }),
  custom: () => {
    const saved = localStorage.getItem('flash.custom') || '';
    const v = prompt('Base URL of another flash server (e.g. http://host:8080/speed)', saved);
    if (!v) return null;
    const base = v.replace(/\/+$/, '');
    localStorage.setItem('flash.custom', base);
    return { label: base, downloadUrl: `${base}/__down`, uploadUrl: `${base}/__up`, turnUrl: `${base}/__turn`, metaUrl: `${base}/__meta` };
  },
};

let endpoint = PRESETS.this();
let test = null;
let latencySeries = []; // [{t, ping, phase}]
let lastResult = null;
let renderQueued = false;

// ---------- rendering ----------
function setText(id, txt) { $(id).textContent = txt; }

function bigNumber(id, unitId, bps) {
  if (!Number.isFinite(bps)) { setText(id, '—'); setText(unitId, ''); return; }
  const [num, unit] = fmtBps(bps).split(' ');
  setText(id, num); setText(unitId, unit);
}

function renderSummary(state) {
  const s = summarize(state);
  const final = !!state.finishedAt;
  const tooShort = 'transfers finished in under 250 ms, link never loaded';
  bigNumber('v-download', 'u-download', s.download);
  bigNumber('v-upload', 'u-upload', s.upload);
  setText('v-latency', fmtMs(s.latency));
  setText('v-jitter', fmtMs(s.jitter));
  setText('v-dl-loaded', fmtMs(s.downLoadedLatency));
  setText('n-dl-loaded', Number.isFinite(s.downLoadedJitter) ? `jitter ${fmtMs(s.downLoadedJitter)}` : final && Number.isFinite(s.download) ? tooShort : '');
  setText('v-ul-loaded', fmtMs(s.upLoadedLatency));
  setText('n-ul-loaded', Number.isFinite(s.upLoadedJitter) ? `jitter ${fmtMs(s.upLoadedJitter)}` : final && Number.isFinite(s.upload) ? tooShort : '');
  if (Number.isFinite(s.packetLoss)) {
    setText('v-loss', (s.packetLoss * 100).toFixed(1) + '%');
    const d = state.packetLossDetail;
    setText('n-loss', d ? `${d.received} of ${d.sent} packets returned` : '');
  } else if (state.packetLossDetail?.unavailable) {
    setText('v-loss', 'n/a'); setText('n-loss', state.packetLossDetail.reason);
  } else { setText('v-loss', '—'); setText('n-loss', ''); }
  const dur = (state.finishedAt || Date.now()) - (state.startedAt || Date.now());
  setText('v-duration', state.startedAt ? (dur / 1000).toFixed(1) + ' s' : '—');
  const noLoaded = !Number.isFinite(s.downLoadedLatency) && !Number.isFinite(s.upLoadedLatency);
  const assume = final && noLoaded && Number.isFinite(s.download) && Number.isFinite(s.upload);
  renderAim(aimScores(s, assume ? { defaultLoadedLatencyIncrease: 0 } : {}));
  setText('aim-note', assume ? 'Loaded latency could not be sampled (transfers too short), so no latency increase under load is assumed.' : '');
  return s;
}

function renderAim(scores) {
  for (const card of $('aim').querySelectorAll('.aim-card')) {
    const sc = scores[card.dataset.k];
    const badge = card.querySelector('.badge');
    if (!sc) { badge.textContent = '—'; badge.removeAttribute('data-c'); card.querySelector('.pts').textContent = ''; continue; }
    badge.textContent = sc.classificationName;
    badge.dataset.c = sc.classificationName;
    card.querySelector('.pts').textContent = `${sc.points} pts`;
  }
}

function renderTable(state) {
  const tb = $('table-sizes').querySelector('tbody');
  tb.replaceChildren(...perSize(state).map((r) => {
    const tr = document.createElement('tr');
    for (const v of [r.dir === 'down' ? 'Download' : 'Upload', fmtBytes(r.bytes), r.count, fmtBps(r.min), fmtBps(r.median), fmtBps(r.p90)]) {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    }
    return tr;
  }));
}

function scheduleRender(state) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSummary(state);
    latencyChart($('chart-latency'), $('legend-latency'), latencySeries);
    throughputChart($('chart-throughput'), $('legend-throughput'), state, fmtBytes);
    renderTable(state);
  });
}

function setProgress(frac, msg) {
  $('bar-fill').style.width = Math.round(frac * 100) + '%';
  if (msg !== undefined) setText('status', msg);
}

function stageLabel(step) {
  switch (step.type) {
    case 'latency': return `Measuring latency (${step.numPackets} pings)`;
    case 'download': return `Downloading ${fmtBytes(step.bytes)} × ${step.count}`;
    case 'upload': return `Uploading ${fmtBytes(step.bytes)} × ${step.count}`;
    case 'packetLoss': return `Packet loss: ${step.numPackets} packets through TURN`;
    default: return step.type;
  }
}

// ---------- meta ----------
async function loadMeta() {
  setText('m-endpoint', endpoint.label);
  try {
    if (endpoint.metaFromHeaders) {
      // Cloudflare exposes client details as cf-meta-* headers on __down.
      const r = await fetch(endpoint.downloadUrl + '?bytes=0', { cache: 'no-store' });
      const h = (k) => r.headers.get('cf-meta-' + k) || '';
      setText('m-ip', h('ip') || '—');
      setText('m-host', [h('asn') && 'AS' + h('asn'), h('city'), h('country')].filter(Boolean).join(', ') || '—');
      setText('m-server', h('colo') ? `Cloudflare ${h('colo')}` : endpoint.label);
      setText('m-proto', '—');
      return;
    }
    if (!endpoint.metaUrl) throw new Error('no meta endpoint');
    const r = await fetch(endpoint.metaUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    // Accepts this app's /__meta and Cloudflare's /meta shapes.
    setText('m-ip', m.ip || m.clientIp || '—');
    setText('m-host', m.hostname || m.asOrganization || '—');
    setText('m-server', m.server || (m.colo ? `Cloudflare ${m.colo}` : '—'));
    setText('m-proto', m.protocol ? m.protocol + (m.tls ? ' (TLS)' : '') : m.httpProtocol || '—');
  } catch {
    setText('m-ip', '—'); setText('m-host', '—'); setText('m-server', endpoint.label); setText('m-proto', '—');
  }
}

// ---------- history ----------
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20))); }

function compactState(state) {
  const trim = (arr) => arr.map((s) => ({ ping: s.ping, time: s.time }));
  const buckets = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((s) => ({ bps: s.bps, duration: s.duration, bytes: s.bytes }))]));
  return { latency: trim(state.latency), down: buckets(state.down), up: buckets(state.up), downLoaded: trim(state.downLoaded), upLoaded: trim(state.upLoaded), packetLoss: state.packetLoss, packetLossDetail: state.packetLossDetail, startedAt: state.startedAt, finishedAt: state.finishedAt };
}

function buildResult(state) {
  const summary = summarize(state);
  return {
    version: 1, at: new Date(state.startedAt).toISOString(), endpoint: endpoint.label,
    client: { ip: $('m-ip').textContent, hostname: $('m-host').textContent, userAgent: navigator.userAgent },
    server: $('m-server').textContent, durationMs: state.finishedAt - state.startedAt,
    summary, aim: aimScores(summary), perSize: perSize(state), latencySeries, state: compactState(state),
  };
}

function summaryText(r) {
  const s = r.summary, a = r.aim;
  const cls = (k) => a[k]?.classificationName || 'n/a';
  return [
    `flash speed test · ${new Date(r.at).toLocaleString()} · ${r.endpoint}`,
    `Download ${fmtBps(s.download)} · Upload ${fmtBps(s.upload)} · Latency ${fmtMs(s.latency)} · Jitter ${fmtMs(s.jitter)} · Loss ${Number.isFinite(s.packetLoss) ? (s.packetLoss * 100).toFixed(1) + '%' : 'n/a'}`,
    `Loaded latency: download ${fmtMs(s.downLoadedLatency)}, upload ${fmtMs(s.upLoadedLatency)}`,
    `AIM: streaming ${cls('streaming')} · gaming ${cls('gaming')} · video chat ${cls('rtc')}`,
  ].join('\n');
}

function renderHistory() {
  const h = loadHistory();
  const ol = $('history');
  if (!h.length) { ol.innerHTML = '<li class="muted">No runs yet.</li>'; return; }
  ol.replaceChildren(...h.map((r, i) => {
    const li = document.createElement('li');
    const time = document.createElement('time'); time.dateTime = r.at; time.textContent = new Date(r.at).toLocaleString();
    const txt = document.createElement('span'); txt.textContent = `↓ ${fmtBps(r.summary.download)} · ↑ ${fmtBps(r.summary.upload)} · ${fmtMs(r.summary.latency)}`;
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'View';
    btn.addEventListener('click', () => showResult(r));
    li.append(time, txt, btn);
    return li;
  }));
}

function showResult(r) {
  if (test?.running) return;
  lastResult = r;
  latencySeries = r.latencySeries || [];
  scheduleRender(r.state);
  setProgress(1, `Showing run from ${new Date(r.at).toLocaleString()} against ${r.endpoint}.`);
  setText('m-endpoint', r.endpoint);
  for (const id of ['copy-summary', 'copy-json', 'download-json']) $(id).disabled = false;
}

// ---------- run ----------
function start() {
  if (test?.running) return;
  test = new SpeedTest({ downloadUrl: endpoint.downloadUrl, uploadUrl: endpoint.uploadUrl, turnUrl: endpoint.turnUrl });
  latencySeries = [];
  lastResult = null;
  const t0 = performance.now();
  const total = test.cfg.measurements.length;
  for (const id of ['copy-summary', 'copy-json', 'download-json']) $(id).disabled = true;
  $('start').textContent = 'Abort'; $('start').classList.add('abort'); $('endpoint').disabled = true;

  test.on('stage', ({ index, step }) => setProgress(index / total, stageLabel(step)));
  test.on('latency', ({ sample, phase }) => { latencySeries.push({ t: performance.now() - t0, ping: sample.ping, phase }); scheduleRender(test.state); });
  test.on('sample', () => scheduleRender(test.state));
  test.on('packetLossProgress', ({ sent, received, total: n }) => setProgress(undefined, `Packet loss: ${received}/${sent} returned of ${n}`));
  test.on('packetLoss', () => scheduleRender(test.state));
  test.on('directionFinished', ({ dir }) => setText('status', `${dir === 'down' ? 'Download' : 'Upload'} saturated, skipping larger sizes.`));
  test.on('done', ({ state }) => {
    scheduleRender(state);
    lastResult = buildResult(state);
    const h = loadHistory(); h.unshift(lastResult); saveHistory(h); renderHistory();
    setProgress(1, `Done in ${((state.finishedAt - state.startedAt) / 1000).toFixed(1)} s.`);
    for (const id of ['copy-summary', 'copy-json', 'download-json']) $(id).disabled = false;
    finish();
  });
  test.on('aborted', () => { setProgress(0, 'Aborted.'); finish(); });
  test.on('error', ({ message }) => { setProgress(0, `Error: ${message}`); finish(); });
  loadMeta();
  test.run();
}

function finish() {
  $('start').textContent = 'Run again'; $('start').classList.remove('abort'); $('endpoint').disabled = false;
}

$('start').addEventListener('click', () => (test?.running ? test.abort() : start()));
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea,button')) return;
  if ((e.key === 'Enter' || e.key === ' ') && !test?.running) { e.preventDefault(); start(); }
  if (e.key === 'Escape' && test?.running) test.abort();
});

$('endpoint').addEventListener('change', (e) => {
  const ep = PRESETS[e.target.value]?.();
  if (!ep) { e.target.value = 'this'; endpoint = PRESETS.this(); }
  else endpoint = ep;
  localStorage.setItem(ENDPOINT_KEY, e.target.value);
  loadMeta();
});

$('copy-summary').addEventListener('click', () => lastResult && navigator.clipboard.writeText(summaryText(lastResult)));
$('copy-json').addEventListener('click', () => lastResult && navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2)));
$('download-json').addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `flash-${lastResult.at.replace(/[:.]/g, '-')}.json`; a.click();
  URL.revokeObjectURL(a.href);
});
$('clear-history').addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

// initial paint
const savedEp = localStorage.getItem(ENDPOINT_KEY);
if (savedEp && savedEp !== 'custom' && PRESETS[savedEp]) { $('endpoint').value = savedEp; endpoint = PRESETS[savedEp](); }
renderHistory();
scheduleRender({ latency: [], down: {}, up: {}, downLoaded: [], upLoaded: [] });
loadMeta();
