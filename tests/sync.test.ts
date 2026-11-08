import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerClock, chooseCorrection, projectPosition } from '../src/sync.ts';
import { currentPlayback } from '../worker/state.ts';

const epoch = 1_800_000_000_000;

test('client projection matches authoritative time for paused, playing, rates and bounds', () => {
  for (const paused of [false, true]) {
    for (const rate of [0.25, 1, 2, 4]) {
      const playback = { paused, rate, position: 12.345, updatedAt: epoch, revision: 7 };
      for (const time of [epoch - 100, epoch, epoch + 1234, epoch + 1e10]) {
        assert.equal(projectPosition(playback, time), currentPlayback(playback, time).position);
      }
      assert.equal(playback.position, 12.345);
      assert.equal(playback.updatedAt, epoch);
    }
  }
});

test('precise seeks require an explicit alignment; buffering pauses do not seek', () => {
  assert.deepEqual(chooseCorrection(0, 0.025, true, 1, true), { seek: null, rate: 1 });
  assert.deepEqual(chooseCorrection(0, 0.026, true, 1, true), { seek: 0.026, rate: 1 });
  assert.deepEqual(chooseCorrection(0, 0.026, false, 2, true), { seek: 0.026, rate: 2 });
  assert.deepEqual(chooseCorrection(0, 0.4, true, 1), { seek: null, rate: 1 });
  assert.deepEqual(chooseCorrection(0, 0.4, false, 1), { seek: null, rate: 1.04 });
  assert.deepEqual(chooseCorrection(0, 2, false, 1), { seek: null, rate: 1.05 });
  assert.deepEqual(chooseCorrection(0, 2.001, false, 1), { seek: 2.001, rate: 1 });
});

test('correction uses proportional bounded speed changes instead of seeking for ordinary drift', () => {
  assert.deepEqual(chooseCorrection(0, 0.04, false, 2), { seek: null, rate: 2 });
  assert.deepEqual(chooseCorrection(0.2, 0, false, 2), { seek: null, rate: 1.96 });
  assert.deepEqual(chooseCorrection(0, 0.1, false, 1), { seek: null, rate: 1.01 });
  assert.deepEqual(chooseCorrection(0, 1.5, false, 2), { seek: null, rate: 2.1 });
  assert.deepEqual(chooseCorrection(0, 0.079, false, 0.25), { seek: null, rate: 0.25 });
  assert.deepEqual(chooseCorrection(0, 0.02, true, 4), { seek: null, rate: 4 });
  assert.deepEqual(chooseCorrection(0, 0, false, 1), { seek: null, rate: 1 });
});

test('clock selects low RTT samples instead of following delayed jitter', () => {
  let local = 0;
  const clock = new ServerClock(() => local, () => epoch + 50000);
  assert.equal(clock.ready, false);
  assert.equal(clock.latency, null);
  local = 20;
  assert.equal(clock.sample(0, local, epoch + 10), true);
  assert.equal(clock.now(), epoch + 20);
  local = 450;
  clock.sample(250, local, epoch + 430);
  local = 800;
  clock.sample(500, local, epoch + 750);
  assert.equal(clock.ready, true);
  assert.equal(clock.latency, 20);
  assert.equal(clock.now(), epoch + 800);
});

test('clock advances on performance time despite large forwards and backwards wall clock changes', () => {
  let local = 0;
  let wall = epoch;
  const clock = new ServerClock(() => local, () => wall);
  local = 10;
  clock.sample(0, local, epoch + 5);
  wall += 3_600_000;
  local = 1010;
  assert.equal(clock.now(), epoch + 1010);
  wall -= 7_200_000;
  local = 2010;
  assert.equal(clock.now(), epoch + 2010);
});

test('initial calibration uses the best of several samples before becoming ready', () => {
  let local = 200;
  const clock = new ServerClock(() => local, () => epoch + 50000);
  clock.sample(0, local, epoch + 180);
  local = 270;
  clock.sample(250, local, epoch + 260);
  local = 600;
  clock.sample(500, local, epoch + 580);
  assert.equal(clock.ready, true);
  assert.equal(clock.latency, 20);
  assert.equal(clock.now(), epoch + local);
});

test('better clock samples converge without running time backwards', () => {
  let local = 20;
  const clock = new ServerClock(() => local, () => epoch);
  clock.sample(0, local, epoch + 30);
  local = 50;
  clock.sample(30, local, epoch + 60);
  local = 80;
  clock.sample(60, local, epoch + 90);
  assert.equal(clock.ready, true);
  assert.equal(clock.now(), epoch + 100);
  local = 260;
  clock.sample(250, local, epoch + 255);
  let previous = clock.now();
  for (local = 261; local <= 1000; local++) {
    const now = clock.now();
    assert.ok(now >= previous);
    previous = now;
  }
  assert.equal(clock.now(), epoch + local);
  assert.equal(clock.latency, 10);
});

test('periodic samples discard old best RTT and reject invalid timestamps', () => {
  let local = 10;
  const clock = new ServerClock(() => local, () => epoch);
  clock.sample(0, local, epoch + 5);
  local = 70020;
  clock.sample(70000, local, epoch + 70010);
  assert.equal(clock.latency, 20);
  assert.equal(clock.ready, false);
  for (const values of [[20, 10, epoch], [-1, 10, epoch], [0, 10001, epoch], [0, 10, NaN], [NaN, 10, epoch]]) {
    assert.equal(clock.sample(values[0], values[1], values[2]), false);
  }
  assert.equal(clock.latency, 20);
});
