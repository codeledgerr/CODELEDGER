// Unit tests for the forecast algorithm. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorForecast,
  classifySwap,
  computeForecast,
  MAX_TARGET_DISTANCE,
  MIN_TARGET_DISTANCE,
  momentumBps,
  Path,
  pressureBps,
  toPriceTick,
  validateForecast,
} from './algorithm.mjs';

const EVEN_HASH = `0x${'0'.repeat(63)}2`;
const ODD_HASH = `0x${'0'.repeat(63)}3`;
const ETH = 10n ** 18n;

/** 32 swaps whose price ticks follow `moves` from `start`; buys/sells and volumes per swap. */
function sample(start, moves, { buy = () => true, volume = () => ETH } = {}) {
  let t = start;
  return moves.map((m, i) => {
    t += m;
    return { priceTick: t, isBuy: buy(i), ethVolume: volume(i) };
  });
}

const forecast = (start, swaps, hash = EVEN_HASH) =>
  computeForecast({ startTick: start, swaps, currentPriceTick: swaps.at(-1).priceTick, blockHash: hash });

test('price tick: CLEDGER as currency1 negates the pool tick', () => {
  assert.equal(toPriceTick(-201500, false), 201500);
  assert.equal(toPriceTick(201500, true), 201500);
});

test('swap classification: ETH paid into the pool is a buy', () => {
  // CLEDGER is currency1: ETH is amount0
  assert.deepEqual(classifySwap(-5n * ETH, 1000n, false), { isBuy: true, ethVolume: 5n * ETH });
  assert.deepEqual(classifySwap(2n * ETH, -1000n, false), { isBuy: false, ethVolume: 2n * ETH });
  // CLEDGER is currency0: ETH is amount1
  assert.deepEqual(classifySwap(1000n, -3n * ETH, true), { isBuy: true, ethVolume: 3n * ETH });
});

test('momentum is net move over total move, in -1..+1', () => {
  assert.equal(momentumBps([0, 10, 20]), 10_000);
  assert.equal(momentumBps([0, -10, -20]), -10_000);
  assert.equal(momentumBps([0, 10, 0]), 0);
  assert.equal(momentumBps([0, 30, 20]), 5_000);
  assert.equal(momentumBps([5, 5, 5]), 0);
});

test('pressure uses ETH volume', () => {
  assert.equal(pressureBps(124n * ETH / 10n, 71n * ETH / 10n), 2717); // 12.4 vs 7.1 ETH
  assert.equal(pressureBps(0n, 0n), 0);
  assert.equal(pressureBps(0n, ETH), -10_000);
});

test('steady rise with buying -> UP, symmetric targets', () => {
  const swaps = sample(201_400, Array(32).fill(5));
  const f = forecast(201_400, swaps);
  assert.equal(f.codeChoice, Path.UP);
  assert.equal(f.details.decidedBy, 'score');
  assert.equal(f.referenceTick, 201_560);
  assert.equal(f.upTargetTick - f.referenceTick, f.referenceTick - f.downTargetTick);
  assert.equal(f.details.targetDistance, 30); // 5 ticks/swap * 6
});

test('steady fall with selling -> DOWN', () => {
  const swaps = sample(0, Array(32).fill(-10), { buy: () => false });
  const f = forecast(0, swaps);
  assert.equal(f.codeChoice, Path.DOWN);
  assert.equal(f.details.score, -10_000);
  assert.equal(f.details.targetDistance, 60);
});

test('score weights 0.40 / 0.40 / 0.20', () => {
  // flat-ish long path but all buys: long 0, pressure +1, short 0 -> score 0.40
  const moves = [...Array(12).fill(10), ...Array(12).fill(-10), 5, -5, 5, -5, 5, -5, 5, -5];
  const f = forecast(0, sample(0, moves));
  assert.equal(f.details.longMomentum, 0);
  assert.equal(f.details.shortMomentum, 0);
  assert.equal(f.details.pressure, 10_000);
  assert.equal(f.details.score, 4_000);
  assert.equal(f.codeChoice, Path.UP);
});

test('neutral score -> short momentum decides', () => {
  // 24 moves down then 8 up, equal buy/sell volume:
  // long = -160/320 = -0.5, pressure = 0, short = +1 -> score = -0.2 + 0 + 0.2 = 0 (neutral)
  const moves = [...Array(24).fill(-10), ...Array(8).fill(10)];
  const swaps = sample(0, moves, { buy: (i) => i % 2 === 0 });
  const f = forecast(0, swaps, ODD_HASH);
  assert.equal(f.details.score, 0);
  assert.equal(f.details.shortMomentum, 10_000);
  assert.equal(f.codeChoice, Path.UP);
  assert.equal(f.details.decidedBy, 'short-momentum tie-breaker');
});

test('everything neutral -> block hash decides, deterministically', () => {
  const swaps = sample(100, Array(32).fill(0), { buy: (i) => i % 2 === 0 });
  const up = forecast(100, swaps, EVEN_HASH);
  const down = forecast(100, swaps, ODD_HASH);
  assert.equal(up.codeChoice, Path.UP);
  assert.equal(down.codeChoice, Path.DOWN);
  assert.equal(up.details.decidedBy, 'block-hash fallback');
  assert.deepEqual(forecast(100, swaps, EVEN_HASH), up);
});

test('target distance is clamped to the fixed bounds', () => {
  const calm = forecast(0, sample(0, Array(32).fill(0), { buy: (i) => i % 2 === 0 }));
  assert.equal(calm.details.targetDistance, MIN_TARGET_DISTANCE);
  const wild = forecast(0, sample(0, Array(16).fill([3000, -3000]).flat()));
  assert.equal(wild.details.targetDistance, MAX_TARGET_DISTANCE);
});

test('requires exactly 32 swaps', () => {
  assert.throws(() => forecast(0, sample(0, Array(31).fill(1))));
});

test('validation rejects bad targets', () => {
  const ok = { referenceTick: 100, upTargetTick: 160, downTargetTick: 40, codeChoice: Path.UP };
  const ctx = { livePriceTick: 100, maxReferenceDrift: 200 };
  assert.deepEqual(validateForecast(ok, ctx), []);
  assert.ok(validateForecast({ ...ok, upTargetTick: 90 }, ctx).length);
  assert.ok(validateForecast({ ...ok, downTargetTick: 110 }, ctx).length);
  assert.ok(validateForecast({ ...ok, codeChoice: Path.NONE }, ctx).length);
  assert.ok(validateForecast({ ...ok, upTargetTick: 100 + MAX_TARGET_DISTANCE + 1 }, ctx).length);
  assert.ok(validateForecast({ ...ok, upTargetTick: 110 }, ctx).length); // below minimum distance
  assert.ok(validateForecast(ok, { ...ctx, livePriceTick: 170 }).length); // UP already reached
  assert.ok(validateForecast(ok, { ...ctx, livePriceTick: 100 + 201 }).length);
  assert.ok(validateForecast({ referenceTick: 887_000, upTargetTick: 887_300, downTargetTick: 886_700, codeChoice: 1 }, { livePriceTick: 887_000, maxReferenceDrift: 200 }).length);
});

test('anchorForecast moves reference and targets to the live tick, keeping distance and choice', () => {
  const f = { referenceTick: -1000, upTargetTick: -940, downTargetTick: -1060, codeChoice: Path.DOWN, details: {} };
  const a = anchorForecast(f, -1250);
  assert.equal(a.referenceTick, -1250);
  assert.equal(a.upTargetTick, -1190);
  assert.equal(a.downTargetTick, -1310);
  assert.equal(a.codeChoice, Path.DOWN);
  assert.deepEqual(validateForecast(a, { livePriceTick: -1250, maxReferenceDrift: 200 }), []);
});
