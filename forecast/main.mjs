// Code Ledger TWO PATHS forecast run.
//
// Reads the official ETH / CLEDGER Uniswap v4 pool from public Ethereum RPC, computes the forecast
// and submits it to CodeLedgerVoting, but only when no vote and no 32-swap prediction is active.
// Voting, the 32-swap window, HIT/MISS and reward routing all happen onchain; this run never
// touches them.
//
// Exit codes:
//   0  forecast submitted, or nothing to do, or data not trustworthy this run (retry next run)
//   1  misconfiguration or a failed transaction: needs a human
//
// env: CODE_LEDGER_CONTRACT, REWARDS_CONTRACT, VOTING_CONTRACT, DEPLOY_BLOCK (repository variables)
//      FORECAST_SIGNER_PRIVATE_KEY (secret; optional when DRY_RUN=true)
//      DRY_RUN=true to compute and print without sending

import { appendFileSync } from 'node:fs';
import { codeLedgerAbi, readConfig, Stage, stageName, votingAbi } from './contracts.mjs';
import { connect, crossChecked, fetchRecentSwaps, RpcUnavailableError, withFallback } from './rpc.mjs';
import { classifySwap, computeForecast, pathName, SAMPLE_SWAPS, toPriceTick, validateForecast } from './algorithm.mjs';
import { loadSigner, submitForecast } from './submit.mjs';

/** Blocks behind the head the data is read at, so a shallow reorg cannot change it. */
const CONFIRMATIONS = 2n;

class ConfigError extends Error {}

/** Stops the run successfully without a transaction. */
class Skip extends Error {}

const eq = (a, b) => a.toLowerCase() === b.toLowerCase();

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  let config;
  let account = null;
  try {
    config = readConfig();
    if (!dryRun || process.env.FORECAST_SIGNER_PRIVATE_KEY) account = loadSigner();
  } catch (e) {
    throw new ConfigError(e.message);
  }
  if (dryRun) console.log('DRY RUN: nothing will be sent');

  const rpcs = await connect({ rotate: Number(process.env.GITHUB_RUN_NUMBER ?? 0) });
  if (rpcs.length < 2) throw new Skip('fewer than two public RPC endpoints reachable; cannot cross-check data');

  // ── 1. Pin one block. Everything below is read at exactly this block. ─────────────────────────
  const head = await withFallback(rpcs, 'block number', (c) => c.getBlockNumber());
  const blockNumber = head - CONFIRMATIONS;
  const blockHash = await crossChecked(rpcs, 'block hash', async (c) => (await c.getBlock({ blockNumber })).hash);
  console.log(`reading at block ${blockNumber} (${blockHash})`);

  const ledger = { address: config.codeLedger, abi: codeLedgerAbi };
  const board = { address: config.voting, abi: votingAbi };
  const read = (c, target, functionName, args = []) => c.readContract({ ...target, functionName, args, blockNumber });

  // ── 2. Wiring: the three repository variables must describe one deployment. ──────────────────
  const wiring = await crossChecked(rpcs, 'contract wiring', async (c) => {
    const [forecastBoard, rewardsLedger, poolManager, officialPool, poolLinked, votingLedger, signer, maxDrift] =
      await Promise.all([
        read(c, ledger, 'forecastBoard'),
        read(c, ledger, 'rewardsLedger'),
        read(c, ledger, 'poolManager'),
        read(c, ledger, 'officialPool'),
        read(c, ledger, 'isPoolLinked'),
        read(c, board, 'CODE_LEDGER'),
        read(c, board, 'FORECAST_SIGNER'),
        read(c, board, 'MAX_REFERENCE_DRIFT'),
      ]);
    return { forecastBoard, rewardsLedger, poolManager, officialPool, poolLinked, votingLedger, signer, maxDrift };
  });
  if (!eq(wiring.forecastBoard, config.voting)) throw new ConfigError('VOTING_CONTRACT is not the forecast board of CODE_LEDGER_CONTRACT');
  if (!eq(wiring.rewardsLedger, config.rewards)) throw new ConfigError('REWARDS_CONTRACT is not the rewards ledger of CODE_LEDGER_CONTRACT');
  if (!eq(wiring.votingLedger, config.codeLedger)) throw new ConfigError('VOTING_CONTRACT does not point back to CODE_LEDGER_CONTRACT');
  if (account && !eq(wiring.signer, account.address)) {
    throw new ConfigError(`FORECAST_SIGNER_PRIVATE_KEY is not the key of FORECAST_SIGNER ${wiring.signer}`);
  }
  if (!wiring.poolLinked) throw new Skip('the official pool is not initialized yet');

  // ── 3. Is a vote or a 32-swap prediction active? ─────────────────────────────────────────────
  const state = await crossChecked(rpcs, 'forecast state', async (c) => {
    const latestId = await read(c, board, 'latestForecastId');
    const [canPush, runLive, stage, priceTick] = await Promise.all([
      read(c, board, 'canPush'),
      read(c, ledger, 'isRunLive'),
      latestId === 0n ? Stage.NONE : read(c, board, 'stageOf', [latestId]),
      read(c, ledger, 'currentPriceTick'),
    ]);
    return { latestId, canPush, runLive, stage, priceTick };
  });
  console.log(`latest forecast #${state.latestId}: ${stageName(state.stage)}`);
  if (state.stage === Stage.VOTING) throw new Skip('a 10-minute vote is active');
  if (state.stage === Stage.AWAITING_MERGE) throw new Skip('voting ended; waiting for the swap that starts the 32-swap window');
  if (state.stage === Stage.RUNNING || state.runLive) throw new Skip('a 32-swap prediction is active');
  if (!state.canPush) throw new Skip('CodeLedgerVoting does not accept a new forecast yet');

  // ── 4. The last 32 swaps, plus the one before them for the starting price. ────────────────────
  const logs = await fetchRecentSwaps(rpcs, {
    poolManager: wiring.poolManager,
    poolId: wiring.officialPool,
    fromBlock: config.deployBlock,
    toBlock: blockNumber,
    needed: SAMPLE_SWAPS + 1,
  });
  if (logs.length < SAMPLE_SWAPS + 1) {
    throw new Skip(`only ${logs.length} swaps on the official pool so far; need ${SAMPLE_SWAPS + 1}`);
  }

  // Native ETH is address(0), so it always sorts first: CLEDGER is currency1.
  const cledgerIsCurrency0 = BigInt(config.codeLedger) < 0n;
  const [before, ...sample] = logs;
  const swaps = sample.map((l) => ({
    priceTick: toPriceTick(l.args.tick, cledgerIsCurrency0),
    ...classifySwap(l.args.amount0, l.args.amount1, cledgerIsCurrency0),
  }));

  // Only swaps move the pool tick, so the newest swap must leave exactly the tick the hook reports.
  // A mismatch means missing logs or a wrong orientation: do not trust this run.
  if (swaps.at(-1).priceTick !== state.priceTick) {
    throw new Skip(`newest swap tick ${swaps.at(-1).priceTick} != pool price tick ${state.priceTick}; logs incomplete`);
  }

  // ── 5. Forecast. ─────────────────────────────────────────────────────────────────────────────
  const forecast = computeForecast({
    startTick: toPriceTick(before.args.tick, cledgerIsCurrency0),
    swaps,
    currentPriceTick: state.priceTick,
    blockHash,
  });
  const d = forecast.details;
  console.log(
    [
      `sample: swaps in blocks ${sample[0].blockNumber}-${sample.at(-1).blockNumber}`,
      `long momentum  ${bps(d.longMomentum)}`,
      `buy/sell       ${bps(d.pressure)}  (buy ${eth(d.buyVolume)} ETH, sell ${eth(d.sellVolume)} ETH)`,
      `short momentum ${bps(d.shortMomentum)}`,
      `score          ${bps(d.score)}  -> ${pathName(forecast.codeChoice)} by ${d.decidedBy}`,
      `volatility     ${d.averageAbsTickMove.toFixed(2)} ticks/swap -> target distance ${d.targetDistance}`,
    ].join('\n'),
  );

  // ── 6. Validate against the LIVE tick, right before sending. ─────────────────────────────────
  const live = await withFallback(rpcs, 'live state', async (c) => {
    const [canPush, priceTick] = await Promise.all([
      c.readContract({ ...board, functionName: 'canPush' }),
      c.readContract({ ...ledger, functionName: 'currentPriceTick' }),
    ]);
    return { canPush, priceTick };
  });
  if (!live.canPush) throw new Skip('a forecast was opened meanwhile');
  const problems = validateForecast(forecast, { livePriceTick: live.priceTick, maxReferenceDrift: wiring.maxDrift });
  if (problems.length) throw new Skip(`forecast rejected: ${problems.join('; ')}`);

  printForecast('forecast', { id: state.latestId + 1n, ...forecast });
  if (dryRun) {
    summary(`Dry run at block ${blockNumber}: nothing sent.`, { id: state.latestId + 1n, ...forecast });
    return;
  }

  // ── 7. Submit and confirm. ───────────────────────────────────────────────────────────────────
  const result = await submitForecast(rpcs, { account, voting: config.voting, forecast });
  if (result.skipped) throw new Skip(result.skipped);

  const p = result.pushed;
  const submitted = {
    id: result.forecastId,
    referenceTick: p.referenceTick,
    upTargetTick: p.upTargetTick,
    downTargetTick: p.downTargetTick,
    codeChoice: p.codeChoice,
    hash: result.hash,
  };
  printForecast(`forecast submitted in block ${result.receipt.blockNumber}`, submitted);
  summary('Forecast submitted.', submitted);
}

const bps = (v) => `${v >= 0 ? '+' : ''}${(v / 10_000).toFixed(4)}`;
const eth = (wei) => (Number(wei / 10n ** 12n) / 1e6).toFixed(6);

function printForecast(title, f) {
  console.log(`\n${title}`);
  console.log(`  forecast ID    ${f.id}`);
  console.log(`  reference tick ${f.referenceTick}`);
  console.log(`  UP target      ${f.upTargetTick}`);
  console.log(`  DOWN target    ${f.downTargetTick}`);
  console.log(`  CODE CHOICE    ${pathName(f.codeChoice)}`);
  if (f.hash) console.log(`  transaction    ${f.hash}`);
}

/** GitHub job summary (public information only). */
function summary(headline, f) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = [
    ['Forecast ID', f.id],
    ['Reference tick', f.referenceTick],
    ['UP target', f.upTargetTick],
    ['DOWN target', f.downTargetTick],
    ['CODE CHOICE', pathName(f.codeChoice)],
  ];
  if (f.hash) rows.push(['Transaction', `[${f.hash}](https://etherscan.io/tx/${f.hash})`]);
  appendFileSync(file, `### ${headline}\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    if (e instanceof Skip || e instanceof RpcUnavailableError) {
      console.log(`\nno forecast this run: ${e.message}`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `No forecast this run: ${e.message}\n`);
      process.exit(0);
    }
    console.log(`::error::${e instanceof ConfigError ? 'configuration: ' : ''}${e.shortMessage ?? e.message}`);
    process.exit(1);
  },
);
