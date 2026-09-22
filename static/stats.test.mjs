import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, jitter, scaleThreshold, aimScores, summarize, perSize, fmtBps } from './stats.js';

test('percentile interpolates and handles edge cases', () => {
  assert.equal(percentile([], 0.5), undefined);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10, 1, 5], 0), 1);
  assert.equal(percentile([10, 1, 5], 1), 10);
});

test('jitter is mean absolute consecutive difference', () => {
  assert.equal(jitter([10]), undefined);
  assert.equal(jitter([10, 12, 9]), (2 + 3) / 2);
});

test('scaleThreshold buckets like d3', () => {
  const s = scaleThreshold([10, 20], ['a', 'b', 'c']);
  assert.equal(s(5), 'a');
  assert.equal(s(10), 'b');
  assert.equal(s(19.9), 'b');
  assert.equal(s(20), 'c');
});

test('aimScores matches Cloudflare tables', () => {
  // Excellent connection: 5ms latency, 2ms jitter, 500 Mbps both ways, no loss, +3ms loaded.
  const great = aimScores({ latency: 5, jitter: 2, download: 5e8, upload: 5e8, downLoadedLatency: 8, upLoadedLatency: 7, packetLoss: 0 });
  assert.equal(great.streaming.points, 20 + 10 + 30 + 20);
  assert.equal(great.streaming.classificationName, 'great');
  assert.equal(great.gaming.points, 50);
  assert.equal(great.gaming.classificationName, 'great');
  assert.equal(great.rtc.points, 60);
  assert.equal(great.rtc.classificationName, 'great');

  // Poor: 150ms latency, 30ms jitter, 5 Mbps, 8% loss, +200ms under load.
  const bad = aimScores({ latency: 150, jitter: 30, download: 5e6, upload: 1e6, downLoadedLatency: 350, upLoadedLatency: 300, packetLoss: 0.08 });
  assert.equal(bad.streaming.points, Math.max(0, -10 + 0 + 5 + -10));
  assert.equal(bad.streaming.classificationName, 'bad');
  assert.equal(bad.gaming.classificationName, 'bad');

  // Missing packet loss defaults to 0 points; missing loaded latency omits every experience.
  const noLoss = aimScores({ latency: 5, jitter: 2, download: 5e8, downLoadedLatency: 8 });
  assert.equal(noLoss.streaming.points, 20 + 0 + 30 + 20);
  assert.deepEqual(aimScores({ latency: 5, jitter: 2, download: 5e8 }), {});
  // ...unless the caller supplies a default for the missing loaded-latency increase.
  const assumed = aimScores({ latency: 5, jitter: 2, download: 5e8, upload: 5e8, packetLoss: 0 }, { defaultLoadedLatencyIncrease: 0 });
  assert.equal(assumed.gaming.points, 20 + 10 + 20);
  assert.equal(assumed.gaming.classificationName, 'great');
});

test('summarize applies percentiles and min-duration filter', () => {
  const state = {
    latency: [{ ping: 10 }, { ping: 12 }, { ping: 11 }],
    down: { 100000: [{ bps: 1e8, duration: 5 }, { bps: 2e8, duration: 50 }], 1000000: [{ bps: 3e8, duration: 100 }] },
    up: {},
    downLoaded: [{ ping: 20 }, { ping: 30 }],
    upLoaded: [],
    packetLoss: 0.01,
  };
  const s = summarize(state);
  assert.equal(s.latency, 11);
  assert.equal(s.download, percentile([2e8, 3e8], 0.9));
  assert.equal(s.upload, undefined);
  assert.equal(s.downLoadedLatency, 25);
  assert.equal(s.upLoadedLatency, undefined);
  assert.equal(s.packetLoss, 0.01);
  const rows = perSize(state);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bytes, 100000);
  assert.equal(rows[0].count, 2);
});

test('fmtBps scales units', () => {
  assert.equal(fmtBps(1.5e9), '1.50 Gbps');
  assert.equal(fmtBps(250e6), '250 Mbps');
  assert.equal(fmtBps(25e6), '25.0 Mbps');
  assert.equal(fmtBps(2.5e6), '2.50 Mbps');
  assert.equal(fmtBps(500e3), '500 kbps');
});
