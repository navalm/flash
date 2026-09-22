// Measurement engine. Mirrors cloudflare/speedtest's sequence and math:
// sequential HTTP requests timed with PerformanceResourceTiming, server
// processing time subtracted via Server-Timing, loaded-latency pings fired
// while transfers are in flight, and packet loss through a TURN loopback.

export const DEFAULT_MEASUREMENTS = [
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
  { type: 'latency', numPackets: 20 },
  { type: 'download', bytes: 1e5, count: 9 },
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 1e6, count: 8 },
  { type: 'latency', numPackets: 2 },
  { type: 'upload', bytes: 1e5, count: 8 },
  { type: 'latency', numPackets: 2 },
  { type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3000 },
  { type: 'upload', bytes: 1e6, count: 6 },
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 1e7, count: 6 },
  { type: 'latency', numPackets: 2 },
  { type: 'upload', bytes: 1e7, count: 4 },
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 2.5e7, count: 4 },
  { type: 'latency', numPackets: 2 },
  { type: 'upload', bytes: 2.5e7, count: 4 },
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 1e8, count: 3 },
  { type: 'latency', numPackets: 2 },
  { type: 'upload', bytes: 5e7, count: 3 },
  { type: 'latency', numPackets: 2 },
  { type: 'download', bytes: 2.5e8, count: 2 },
];

export const DEFAULTS = {
  downloadUrl: '__down',
  uploadUrl: '__up',
  turnUrl: '__turn', // null disables packet loss
  measurements: DEFAULT_MEASUREMENTS,
  measureDownloadLoadedLatency: true,
  measureUploadLoadedLatency: true,
  loadedLatencyThrottle: 400,
  loadedRequestMinDuration: 250,
  loadedLatencyMaxPoints: 20,
  bandwidthFinishRequestDuration: 1000,
  estimatedServerTime: 0,
  packetLossConnectionTimeout: 5000,
};

const HEADER_FRACTION = 0.005;
const SERVER_TIMING_RE = /(?:^|,\s*)cfReq(?:uest)?Dur(?:ation)?;\s*dur=([0-9.]+)/i;

export function parseServerTiming(header) {
  if (!header) return undefined;
  const m = header.match(SERVER_TIMING_RE);
  if (m && +m[1] > 0.01) return +m[1];
  // Cloudflare's edge reports cfSpeedEdge + cfSpeedWorker instead; sum them.
  let sum = 0;
  for (const x of header.matchAll(/(?:^|,\s*)cfSpeed[a-zA-Z]*;\s*dur=([0-9.]+)/gi)) sum += +x[1];
  return sum > 0.01 ? sum : undefined;
}

const blobCache = new Map();
function zeroBlob(bytes) {
  if (!blobCache.has(bytes)) blobCache.set(bytes, new Blob([new Uint8Array(bytes)]));
  return blobCache.get(bytes);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

class AbortedError extends Error { constructor() { super('aborted'); this.name = 'AbortedError'; } }

export class SpeedTest extends EventTarget {
  constructor(options = {}) {
    super();
    this.cfg = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.state = {
      latency: [], down: {}, up: {}, downLoaded: [], upLoaded: [],
      packetLoss: undefined, packetLossDetail: undefined,
      finished: { down: false, up: false }, startedAt: undefined, finishedAt: undefined,
    };
    this.#seq = 0;
    this.#running = false;
    this.#ac = null;
  }

  get running() { return this.#running; }

  on(name, fn) { this.addEventListener(name, (e) => fn(e.detail)); return this; }

  abort() { this.#ac?.abort(new AbortedError()); }

  async run() {
    if (this.#running) return;
    this.reset();
    this.#running = true;
    this.#ac = new AbortController();
    this.state.startedAt = Date.now();
    performance.setResourceTimingBufferSize?.(4000);
    this.#emit('start', {});
    try {
      const steps = this.cfg.measurements;
      for (let i = 0; i < steps.length; i++) {
        const m = steps[i];
        if (m.type === 'download' && this.state.finished.down) continue;
        if (m.type === 'upload' && this.state.finished.up) continue;
        this.#emit('stage', { index: i, total: steps.length, step: m });
        if (m.type === 'latency') await this.#latencyStage(m);
        else if (m.type === 'packetLoss') await this.#packetLossStage(m);
        else await this.#bandwidthStage(m);
      }
      this.state.finishedAt = Date.now();
      this.#emit('done', { state: this.state });
    } catch (err) {
      if (err?.name === 'AbortedError' || err?.name === 'AbortError') this.#emit('aborted', {});
      else { console.error(err); this.#emit('error', { message: err?.message || String(err) }); }
    } finally {
      this.#running = false;
    }
  }

  // --- internals ---
  #seq = 0;
  #running = false;
  #ac = null;

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  #url(dir, bytes, params) {
    const u = new URL(dir === 'down' ? this.cfg.downloadUrl : this.cfg.uploadUrl, document.baseURI);
    u.searchParams.set('bytes', String(bytes));
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    u.searchParams.set('r', String(++this.#seq));
    return u.href;
  }

  async #perfEntry(url) {
    for (let i = 0; i < 10; i++) {
      const entries = performance.getEntriesByName(url);
      const e = entries[entries.length - 1];
      if (e && e.responseEnd > 0) return e;
      await new Promise((r) => setTimeout(r, 0));
    }
    return undefined;
  }

  /** One timed request. Returns {ttfb, payloadTime, serverTime, ping, duration, bps, transferSize, bytes, time}. */
  async #request(dir, bytes, params) {
    const url = this.#url(dir, bytes, params);
    const init = { cache: 'no-store', signal: this.#ac.signal };
    if (dir === 'up') { init.method = 'POST'; init.body = zeroBlob(bytes); }
    const t0 = performance.now();
    const resp = await fetch(url, init);
    const tHeaders = performance.now();
    if (!resp.ok) throw new Error(`${dir === 'down' ? 'Download' : 'Upload'} request failed: HTTP ${resp.status}`);
    const serverTime = parseServerTiming(resp.headers.get('server-timing'));
    await resp.arrayBuffer();
    const tEnd = performance.now();

    const perf = await this.#perfEntry(url);
    let ttfb, payloadTime, transferSize = 0;
    if (perf && perf.responseStart > 0 && perf.requestStart > 0) {
      ttfb = perf.responseStart - perf.requestStart;
      payloadTime = perf.responseEnd - perf.responseStart;
      transferSize = perf.transferSize || 0;
    } else {
      // Cross-origin without Timing-Allow-Origin, or buffer cleared: fall back to fetch timings.
      ttfb = tHeaders - t0;
      payloadTime = tEnd - tHeaders;
    }
    const baseServerTime = serverTime ?? this.cfg.estimatedServerTime;
    const ping = Math.max(0, ttfb - baseServerTime);
    const duration = dir === 'down' ? ping + payloadTime : ttfb;
    const bits = dir === 'down'
      ? 8 * (transferSize || bytes * (1 + HEADER_FRACTION))
      : 8 * bytes * (1 + HEADER_FRACTION);
    const bps = duration > 0 ? bits / (duration / 1000) : undefined;
    return { dir, bytes, ttfb, payloadTime, serverTime: serverTime ?? -1, ping, duration, bps, transferSize, time: Date.now() };
  }

  async #latencyStage(m) {
    for (let i = 0; i < m.numPackets; i++) {
      const s = await this.#request('down', 0);
      this.state.latency.push(s);
      this.#emit('latency', { sample: s, phase: 'idle' });
    }
  }

  async #bandwidthStage(m) {
    const dir = m.type === 'download' ? 'down' : 'up';
    const bucket = (this.state[dir][m.bytes] ||= []);
    const loadedKey = dir === 'down' ? 'downLoaded' : 'upLoaded';
    const measureLoaded = dir === 'down' ? this.cfg.measureDownloadLoadedLatency : this.cfg.measureUploadLoadedLatency;

    let minDuration = Infinity;
    let inFlight = null; // { id, pings: [] }
    let pingerStop = false;
    const pinger = measureLoaded ? (async () => {
      while (!pingerStop) {
        const target = inFlight;
        if (!target) { await sleep(20, this.#ac.signal); continue; }
        const started = performance.now();
        try {
          const s = await this.#request('down', 0, { during: m.type });
          if (inFlight === target) target.pings.push(s);
        } catch (e) { if (pingerStop) break; throw e; }
        const wait = this.cfg.loadedLatencyThrottle - (performance.now() - started);
        if (wait > 0) await sleep(wait, this.#ac.signal);
      }
    })() : Promise.resolve();

    try {
      for (let i = 0; i < m.count; i++) {
        inFlight = { id: this.#seq + 1, pings: [] };
        const s = await this.#request(dir, m.bytes);
        const done = inFlight; inFlight = null;
        bucket.push(s);
        minDuration = Math.min(minDuration, s.duration);
        this.#emit('sample', { sample: s, count: i + 1, total: m.count });
        if (s.duration >= this.cfg.loadedRequestMinDuration && done.pings.length) {
          const arr = this.state[loadedKey];
          arr.push(...done.pings);
          if (arr.length > this.cfg.loadedLatencyMaxPoints) arr.splice(0, arr.length - this.cfg.loadedLatencyMaxPoints);
          for (const p of done.pings) this.#emit('latency', { sample: p, phase: m.type });
        }
      }
    } finally {
      pingerStop = true;
    }
    await pinger.catch(() => {});
    performance.clearResourceTimings();

    if (minDuration > this.cfg.bandwidthFinishRequestDuration && !m.bypassMinDuration) {
      this.state.finished[dir] = true;
      this.#emit('directionFinished', { dir });
    }
  }

  async #packetLossStage(m) {
    const unavailable = (reason) => {
      this.state.packetLossDetail = { unavailable: true, reason };
      this.#emit('packetLoss', this.state.packetLossDetail);
    };
    if (typeof RTCPeerConnection === 'undefined') return unavailable('WebRTC is not available here');
    if (!this.cfg.turnUrl) return unavailable('no TURN relay for this endpoint');
    let turn;
    try {
      const r = await fetch(new URL(this.cfg.turnUrl, document.baseURI), { cache: 'no-store', signal: this.#ac.signal });
      turn = await r.json();
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return unavailable('could not fetch TURN credentials');
    }
    if (!turn?.enabled) return unavailable('TURN relay disabled on server');
    const { measurePacketLoss } = await import('./packetloss.js');
    try {
      const result = await measurePacketLoss({
        iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }],
        numPackets: m.numPackets, batchSize: m.batchSize, batchWaitTime: m.batchWaitTime,
        responsesWaitTime: m.responsesWaitTime, connectionTimeout: this.cfg.packetLossConnectionTimeout,
        signal: this.#ac.signal,
        onProgress: (p) => this.#emit('packetLossProgress', p),
      });
      this.state.packetLoss = result.lossRatio;
      this.state.packetLossDetail = result;
      this.#emit('packetLoss', result);
    } catch (e) {
      if (e?.name === 'AbortedError' || e?.name === 'AbortError') throw e;
      unavailable(e?.message || 'packet loss measurement failed');
    }
  }
}
