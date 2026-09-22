// Hand-rolled SVG charts. Marks per the dataviz spec: >=8px markers with a
// 2px surface ring, 2px medians, hairline grid, text in text tokens, hover
// tooltips with hit targets larger than the mark.

const NS = 'http://www.w3.org/2000/svg';
const W = 900, H = 240, PAD = { l: 48, r: 16, t: 12, b: 30 };

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}

function ticks(max) {
  // Pick the tick count that keeps steps round for the nice maximum:
  // 1, 2.5 and 5 mantissas split into 5 steps, 2 into 4.
  const m = max / Math.pow(10, Math.floor(Math.log10(max)));
  const n = Math.abs(m - 2) < 1e-9 ? 4 : 5;
  const out = [];
  for (let i = 0; i <= n; i++) out.push((max / n) * i);
  return out;
}

function fmtTick(v, step) {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const tooltip = () => document.getElementById('tooltip');
function bindHover(hit, text) {
  hit.addEventListener('pointerenter', (e) => {
    const t = tooltip(); if (!t) return;
    t.textContent = text; t.hidden = false;
    place(e);
  });
  hit.addEventListener('pointermove', place);
  hit.addEventListener('pointerleave', () => { const t = tooltip(); if (t) t.hidden = true; });
}
function place(e) {
  const t = tooltip(); if (!t || t.hidden) return;
  const x = Math.min(e.clientX + 12, window.innerWidth - t.offsetWidth - 8);
  const y = Math.min(e.clientY + 12, window.innerHeight - t.offsetHeight - 8);
  t.style.left = x + 'px'; t.style.top = y + 'px';
}

function frame(container, yMax, yLabel, unit) {
  container.replaceChildren();
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': yLabel });
  container.appendChild(svg);
  const grid = el('g', { class: 'grid' }, svg);
  const axis = el('g', { class: 'axis' }, svg);
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / yMax);
  const tks = ticks(yMax);
  const step = tks[1] - tks[0];
  tks.forEach((tv) => {
    el('line', { x1: PAD.l, x2: W - PAD.r, y1: y(tv), y2: y(tv) }, grid);
    const t = el('text', { x: PAD.l - 8, y: y(tv) + 4, 'text-anchor': 'end' }, axis);
    t.textContent = fmtTick(tv, step);
  });
  if (unit) {
    // A wide number+unit string (e.g. "1,000 Mbps") right-anchored in the
    // narrow left margin overflows off the chart; give the unit its own
    // label clear of the numeric ticks instead.
    const u = el('text', { x: W - PAD.r, y: PAD.t - 2, 'text-anchor': 'end' }, axis);
    u.textContent = unit;
  }
  return { svg, axis, y };
}

const PHASES = [
  { key: 'idle', label: 'Unloaded', color: 'var(--series-1)' },
  { key: 'download', label: 'During download', color: 'var(--series-2)' },
  { key: 'upload', label: 'During upload', color: 'var(--series-3)' },
];

export function renderLegend(container, items) {
  container.replaceChildren(...items.map(({ label, color }) => {
    const s = document.createElement('span');
    const i = document.createElement('i'); i.style.setProperty('--c', color);
    s.append(i, label);
    return s;
  }));
}

/** samples: [{ t: ms since start, ping, phase }] */
export function latencyChart(container, legendEl, samples) {
  renderLegend(legendEl, PHASES);
  if (!samples.length) { empty(container, 'Latency samples appear here once the test starts.'); return; }
  const yMax = niceMax(Math.max(...samples.map((s) => s.ping)) * 1.1);
  const xMax = Math.max(1000, ...samples.map((s) => s.t));
  const { svg, axis, y } = frame(container, yMax, 'Latency in milliseconds over test time', 'ms');
  const x = (t) => PAD.l + (W - PAD.l - PAD.r) * (t / xMax);
  for (let i = 0; i <= 4; i++) {
    const t = (xMax / 4) * i;
    const tx = el('text', { x: x(t), y: H - PAD.b + 16, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, axis);
    tx.textContent = (t / 1000).toFixed(xMax < 10000 ? 1 : 0) + 's';
  }
  const g = el('g', {}, svg);
  for (const s of samples) {
    const ph = PHASES.find((p) => p.key === s.phase) || PHASES[0];
    el('circle', { class: 'dot', cx: x(s.t), cy: y(s.ping), r: 4, fill: ph.color }, g);
    const hit = el('circle', { class: 'hit', cx: x(s.t), cy: y(s.ping), r: 9 }, g);
    bindHover(hit, `${ph.label}\n${s.ping.toFixed(2)} ms at ${(s.t / 1000).toFixed(1)} s`);
  }
}

const DIRS = [
  { key: 'down', label: 'Download', color: 'var(--series-1)', dx: -14 },
  { key: 'up', label: 'Upload', color: 'var(--series-2)', dx: 14 },
];

/** state.down / state.up: { [bytes]: [{bps}] } */
export function throughputChart(container, legendEl, state, fmtBytes) {
  renderLegend(legendEl, DIRS);
  const sizes = [...new Set([...Object.keys(state.down || {}), ...Object.keys(state.up || {})].map(Number))].sort((a, b) => a - b);
  const all = [...Object.values(state.down || {}), ...Object.values(state.up || {})].flat().map((s) => s.bps).filter(Number.isFinite);
  if (!sizes.length || !all.length) { empty(container, 'Per-request throughput appears here as transfers complete.'); return; }
  const unit = Math.max(...all) >= 1e9 ? 'Gbps' : 'Mbps';
  const div = unit === 'Gbps' ? 1e9 : 1e6;
  const yMax = niceMax((Math.max(...all) / div) * 1.1);
  const { svg, axis, y } = frame(container, yMax, `Throughput in ${unit} by request size`, unit);
  const band = (W - PAD.l - PAD.r) / sizes.length;
  const x = (i) => PAD.l + band * (i + 0.5);
  sizes.forEach((sz, i) => {
    const t = el('text', { x: x(i), y: H - PAD.b + 16, 'text-anchor': 'middle' }, axis);
    t.textContent = fmtBytes(sz);
  });
  const g = el('g', {}, svg);
  for (const d of DIRS) {
    sizes.forEach((sz, i) => {
      const samples = (state[d.key]?.[sz] || []).filter((s) => Number.isFinite(s.bps));
      if (!samples.length) return;
      const cx = x(i) + d.dx;
      const bps = samples.map((s) => s.bps).sort((a, b) => a - b);
      const med = bps[Math.floor(bps.length / 2)] / div;
      el('line', { class: 'med', x1: cx - 9, x2: cx + 9, y1: y(med), y2: y(med), stroke: d.color }, g);
      samples.forEach((s, j) => {
        const jitter = ((j % 3) - 1) * 3; // tiny deterministic spread so stacked dots stay visible
        const cy = y(s.bps / div);
        el('circle', { class: 'dot', cx: cx + jitter, cy, r: 4, fill: d.color }, g);
        const hit = el('circle', { class: 'hit', cx: cx + jitter, cy, r: 9 }, g);
        bindHover(hit, `${d.label} ${fmtBytes(sz)}\n${(s.bps / div).toFixed(unit === 'Gbps' ? 2 : 1)} ${unit} in ${s.duration.toFixed(0)} ms`);
      });
    });
  }
}

function empty(container, msg) {
  container.replaceChildren();
  const svg = el('svg', { viewBox: `0 0 ${W} 60` });
  const t = el('text', { class: 'empty', x: W / 2, y: 36, 'text-anchor': 'middle' }, svg);
  t.textContent = msg;
  container.appendChild(svg);
}
