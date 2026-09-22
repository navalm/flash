// Pure measurement math. No DOM, no fetch. Mirrors the calculations in
// cloudflare/speedtest (Results/MeasurementCalculations + ScoresCalculations).

/** Value at percentile p (0..1) of a numeric array, linear interpolation. */
export function percentile(values, p) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  if (xs.length === 1) return xs[0];
  const idx = (xs.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/** Mean absolute difference between consecutive latency samples. */
export function jitter(latencies) {
  const xs = latencies.filter(Number.isFinite);
  if (xs.length < 2) return undefined;
  let sum = 0;
  for (let i = 1; i < xs.length; i++) sum += Math.abs(xs[i] - xs[i - 1]);
  return sum / (xs.length - 1);
}

/** d3-style threshold scale: domain has n cut points, range has n+1 outputs. */
export function scaleThreshold(domain, range) {
  return (v) => {
    let i = 0;
    while (i < domain.length && v >= domain[i]) i++;
    return range[i];
  };
}

export const AIM_SCORING = {
  packetLoss: scaleThreshold([0.01, 0.05, 0.25, 0.5], [10, 5, 0, -10, -20]),
  latency: scaleThreshold([10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20]),
  loadedLatencyIncrease: scaleThreshold([10, 20, 50, 100, 500], [20, 10, 5, 0, -10, -20]),
  jitter: scaleThreshold([10, 20, 100, 500], [10, 5, 0, -10, -20]),
  download: scaleThreshold([1e6, 10e6, 50e6, 100e6], [0, 5, 10, 20, 30]),
  upload: scaleThreshold([1e6, 10e6, 50e6, 100e6], [0, 5, 10, 20, 30]),
};

export const AIM_EXPERIENCES = {
  streaming: { input: ['latency', 'packetLoss', 'download', 'loadedLatencyIncrease'], pointThresholds: [15, 20, 40, 60] },
  gaming: { input: ['latency', 'packetLoss', 'loadedLatencyIncrease'], pointThresholds: [5, 15, 25, 30] },
  rtc: { input: ['latency', 'jitter', 'packetLoss', 'loadedLatencyIncrease'], pointThresholds: [5, 15, 25, 40] },
};

export const CLASSIFICATIONS = ['bad', 'poor', 'average', 'good', 'great'];

/**
 * summary: { latency, jitter, download, upload, downLoadedLatency, upLoadedLatency, packetLoss }
 * Returns { streaming: {points, classificationIdx, classificationName}, gaming: ..., rtc: ... }.
 * An experience is omitted when one of its inputs is unavailable (packetLoss defaults to 0 points).
 */
export function aimScores(summary, { defaultLoadedLatencyIncrease } = {}) {
  const derived = { ...summary };
  if (Number.isFinite(summary.latency) && (Number.isFinite(summary.downLoadedLatency) || Number.isFinite(summary.upLoadedLatency))) {
    derived.loadedLatencyIncrease = Math.max(summary.downLoadedLatency ?? -Infinity, summary.upLoadedLatency ?? -Infinity) - summary.latency;
  } else if (Number.isFinite(defaultLoadedLatencyIncrease)) {
    // Links so fast that no transfer lasts long enough to be "loaded" never
    // yield loaded pings; callers may treat the increase as zero once done.
    derived.loadedLatencyIncrease = defaultLoadedLatencyIncrease;
  }
  const points = {};
  for (const [k, fn] of Object.entries(AIM_SCORING)) {
    const v = derived[k];
    if (Number.isFinite(v)) points[k] = fn(v);
    else if (k === 'packetLoss') points[k] = 0;
  }
  const out = {};
  for (const [name, def] of Object.entries(AIM_EXPERIENCES)) {
    if (!def.input.every((k) => k in points)) continue;
    const sum = Math.max(0, def.input.reduce((a, k) => a + points[k], 0));
    const idx = scaleThreshold(def.pointThresholds, [0, 1, 2, 3, 4])(sum);
    out[name] = { points: sum, classificationIdx: idx, classificationName: CLASSIFICATIONS[idx] };
  }
  return out;
}

export const LATENCY_PERCENTILE = 0.5;
export const BANDWIDTH_PERCENTILE = 0.9;
export const BANDWIDTH_MIN_REQUEST_MS = 10;

/**
 * Build the summary from raw engine state.
 * state.latency: [{ping}], state.down/up: { [bytes]: [{bps, duration}] },
 * state.downLoaded/upLoaded: [{ping}], state.packetLoss: number|undefined
 */
export function summarize(state) {
  const pings = (state.latency || []).map((s) => s.ping);
  const bw = (dir) => {
    const samples = Object.values(state[dir] || {}).flat()
      .filter((s) => Number.isFinite(s.bps) && s.duration >= BANDWIDTH_MIN_REQUEST_MS)
      .map((s) => s.bps);
    return percentile(samples, BANDWIDTH_PERCENTILE);
  };
  const loaded = (arr) => {
    const p = (arr || []).map((s) => s.ping);
    return { latency: percentile(p, LATENCY_PERCENTILE), jitter: jitter(p) };
  };
  const dl = loaded(state.downLoaded);
  const ul = loaded(state.upLoaded);
  return {
    latency: percentile(pings, LATENCY_PERCENTILE),
    jitter: jitter(pings),
    download: bw('down'),
    upload: bw('up'),
    downLoadedLatency: dl.latency,
    downLoadedJitter: dl.jitter,
    upLoadedLatency: ul.latency,
    upLoadedJitter: ul.jitter,
    packetLoss: state.packetLoss,
  };
}

/** Per-size breakdown for the table: [{dir, bytes, count, min, median, p90}] */
export function perSize(state) {
  const rows = [];
  for (const dir of ['down', 'up']) {
    for (const [bytes, samples] of Object.entries(state[dir] || {})) {
      const bps = samples.filter((s) => Number.isFinite(s.bps)).map((s) => s.bps);
      if (bps.length === 0) continue;
      rows.push({ dir, bytes: +bytes, count: bps.length, min: Math.min(...bps), median: percentile(bps, 0.5), p90: percentile(bps, 0.9) });
    }
  }
  return rows.sort((a, b) => a.dir.localeCompare(b.dir) || a.bytes - b.bytes);
}

export function fmtBps(bps) {
  if (!Number.isFinite(bps)) return '—';
  const mbps = bps / 1e6;
  if (mbps >= 1000) return (mbps / 1000).toFixed(2) + ' Gbps';
  if (mbps >= 100) return mbps.toFixed(0) + ' Mbps';
  if (mbps >= 10) return mbps.toFixed(1) + ' Mbps';
  if (mbps >= 1) return mbps.toFixed(2) + ' Mbps';
  return (bps / 1e3).toFixed(0) + ' kbps';
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  return (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + ' ms';
}

export function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(0) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kB';
  return b + ' B';
}
