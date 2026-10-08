// TWO PATHS forecast algorithm.
//
// Pure functions only: no network, no clock, no randomness. Given the same swaps, the same live
// price tick and the same block hash, it always returns the same forecast.
//
// All scores are integers in basis points (BPS): -10000 = -1.0, +10000 = +1.0. Integer math keeps
// the result exactly reproducible by anyone re-running it.
//
// Ticks here are PRICE TICKS of CLEDGER priced in ETH: a higher price tick means CLEDGER got more
// expensive (UP). This is the same convention CodeLedgerVoting uses for its targets.

export const BPS = 10_000;

/** Swaps in the sample. */
export const SAMPLE_SWAPS = 32;
/** Swaps in the short-momentum sample (the newest part of the 32). */
export const SHORT_SWAPS = 8;

/** SCORE = 0.40 * long + 0.40 * pressure + 0.20 * short. Weights in percent. */
export const WEIGHT_LONG = 40;
export const WEIGHT_PRESSURE = 40;
export const WEIGHT_SHORT = 20;

/** |SCORE| <= 0.05 is neutral. */
export const NEUTRAL_SCORE_BPS = 500;
/** |ShortMomentum| <= 0.05 is neutral (tie-breaker skipped). */
export const NEUTRAL_SHORT_BPS = 500;

/** targetDistance = averageAbsoluteTickMove * TARGET_MULTIPLIER, then clamped. */
export const TARGET_MULTIPLIER = 6;
/** About 0.3%: targets never closer than this. */
export const MIN_TARGET_DISTANCE = 30;
/** About 16%: targets never further than this. */
export const MAX_TARGET_DISTANCE = 1500;

/** Uniswap v4 TickMath bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const Path = Object.freeze({ NONE: 0, UP: 1, DOWN: 2 });
export const pathName = (p) => (p === Path.UP ? 'UP' : p === Path.DOWN ? 'DOWN' : 'NONE');

/**
 * Price tick of CLEDGER in ETH from a raw pool tick.
 * The raw pool tick prices currency1 in currency0. If CLEDGER is currency1 (always the case
 * with native ETH, address(0), as currency0) the raw tick prices CLEDGER in ETH inverted,
 * so it is negated.
 */
export function toPriceTick(poolTick, cledgerIsCurrency0) {
  return cledgerIsCurrency0 ? poolTick : -poolTick;
}

/**
 * ETH side of a Swap event, from the swapper's point of view (v4 emits the caller's delta:
 * negative = paid into the pool). Returns { isBuy, ethVolume } with ethVolume in wei (BigInt).
 */
export function classifySwap(amount0, amount1, cledgerIsCurrency0) {
  const ethDelta = cledgerIsCurrency0 ? amount1 : amount0;
  return { isBuy: ethDelta < 0n, ethVolume: ethDelta < 0n ? -ethDelta : ethDelta };
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Directional efficiency of a tick path: net move / total absolute move, in BPS.
 * +10000 = every move was up, -10000 = every move was down, 0 = no net move.
 * Already in -1 ... +1, so no arbitrary scale constant is needed.
 */
export function momentumBps(ticks) {
  let travelled = 0;
  for (let i = 1; i < ticks.length; i++) travelled += Math.abs(ticks[i] - ticks[i - 1]);
  if (travelled === 0) return 0;
  const net = ticks[ticks.length - 1] - ticks[0];
  return Math.trunc((net * BPS) / travelled);
}

/** (buy - sell) / (buy + sell) in BPS, from ETH volumes in wei. */
export function pressureBps(buyVolume, sellVolume) {
  const total = buyVolume + sellVolume;
  if (total === 0n) return 0;
  return Number(((buyVolume - sellVolume) * BigInt(BPS)) / total);
}

/**
 * Builds the forecast.
 *
 * @param {object}   input
 * @param {number}   input.startTick     price tick right before the oldest sampled swap
 *                                       (the tick after the swap preceding the sample)
 * @param {Array<{priceTick:number,isBuy:boolean,ethVolume:bigint}>} input.swaps
 *                                       the last SAMPLE_SWAPS swaps, oldest first
 * @param {number}   input.currentPriceTick live price tick (becomes the reference tick)
 * @param {string}   input.blockHash     hash of the block the data was read at (0x...)
 */
export function computeForecast({ startTick, swaps, currentPriceTick, blockHash }) {
  if (swaps.length !== SAMPLE_SWAPS) throw new Error(`need exactly ${SAMPLE_SWAPS} swaps, got ${swaps.length}`);

  // ticks[0] = before the sample, ticks[i] = after sampled swap i. 32 moves in total.
  const ticks = [startTick, ...swaps.map((s) => s.priceTick)];

  // A. Long momentum: net direction over all 32 swaps.
  const longMomentum = momentumBps(ticks);

  // B. Buy / sell pressure: ETH volume.
  let buyVolume = 0n;
  let sellVolume = 0n;
  for (const s of swaps) {
    if (s.isBuy) buyVolume += s.ethVolume;
    else sellVolume += s.ethVolume;
  }
  const pressure = pressureBps(buyVolume, sellVolume);

  // C. Short momentum: the last 8 swaps (8 moves).
  const shortMomentum = momentumBps(ticks.slice(-(SHORT_SWAPS + 1)));

  // D. Volatility: average absolute tick move per swap. Sets target distance only.
  let travelled = 0;
  for (let i = 1; i < ticks.length; i++) travelled += Math.abs(ticks[i] - ticks[i - 1]);
  const distance = clamp(
    Math.ceil((travelled * TARGET_MULTIPLIER) / SAMPLE_SWAPS),
    MIN_TARGET_DISTANCE,
    MAX_TARGET_DISTANCE,
  );

  // SCORE, kept at x100 scale so the weighting has no rounding.
  const score100 = WEIGHT_LONG * longMomentum + WEIGHT_PRESSURE * pressure + WEIGHT_SHORT * shortMomentum;
  const score = Math.trunc(score100 / 100);

  let codeChoice;
  let decidedBy;
  if (Math.abs(score100) > NEUTRAL_SCORE_BPS * 100) {
    codeChoice = score100 > 0 ? Path.UP : Path.DOWN;
    decidedBy = 'score';
  } else if (Math.abs(shortMomentum) > NEUTRAL_SHORT_BPS) {
    codeChoice = shortMomentum > 0 ? Path.UP : Path.DOWN;
    decidedBy = 'short-momentum tie-breaker';
  } else {
    // Public, deterministic fallback: lowest bit of the block hash. Even = UP, odd = DOWN.
    codeChoice = (BigInt(blockHash) & 1n) === 0n ? Path.UP : Path.DOWN;
    decidedBy = 'block-hash fallback';
  }

  const referenceTick = currentPriceTick;
  return {
    referenceTick,
    upTargetTick: referenceTick + distance,
    downTargetTick: referenceTick - distance,
    codeChoice,
    details: {
      longMomentum,
      pressure,
      shortMomentum,
      score,
      decidedBy,
      averageAbsTickMove: travelled / SAMPLE_SWAPS,
      targetDistance: distance,
      buyVolume,
      sellVolume,
    },
  };
}

/**
 * Validates a forecast against the rules CodeLedgerVoting.pushForecast enforces plus this
 * algorithm's own bounds. Returns a list of problems; empty means valid.
 */
export function validateForecast(f, { livePriceTick, maxReferenceDrift }) {
  const problems = [];
  const { referenceTick: ref, upTargetTick: up, downTargetTick: down, codeChoice } = f;
  for (const [name, v] of Object.entries({ ref, up, down })) {
    if (!Number.isInteger(v)) problems.push(`${name} is not an integer`);
  }
  if (codeChoice !== Path.UP && codeChoice !== Path.DOWN) problems.push('CODE CHOICE must be UP or DOWN');
  if (!(up > ref)) problems.push('UP target must be above the reference tick');
  if (!(down < ref)) problems.push('DOWN target must be below the reference tick');
  if (up > MAX_TICK || down < MIN_TICK) problems.push('target outside the Uniswap v4 tick range');
  for (const [name, d] of [['UP', up - ref], ['DOWN', ref - down]]) {
    if (d < MIN_TARGET_DISTANCE || d > MAX_TARGET_DISTANCE) {
      problems.push(`${name} distance ${d} outside [${MIN_TARGET_DISTANCE}, ${MAX_TARGET_DISTANCE}]`);
    }
  }
  if (!(livePriceTick < up && livePriceTick > down)) problems.push('a target is already reached at the live tick');
  if (Math.abs(ref - livePriceTick) > maxReferenceDrift) problems.push('reference tick too far from the live tick');
  return problems;
}
