import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerTiming } from './engine.js';

test('parseServerTiming handles flash and Cloudflare header shapes', () => {
  assert.equal(parseServerTiming('cfRequestDuration;dur=1.25'), 1.25);
  assert.equal(parseServerTiming('cfReqDur;dur=3'), 3);
  assert.equal(parseServerTiming('cfSpeedEdge;dur=4, cfSpeedWorker;dur=29'), 33);
  assert.equal(parseServerTiming('cfL4;desc="?proto=TCP&rtt=9281"'), undefined);
  assert.equal(parseServerTiming('cfRequestDuration;dur=0.001'), undefined);
  assert.equal(parseServerTiming(null), undefined);
});
