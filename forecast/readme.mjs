// Live stats for README.md.
//
// Reads Code Ledger state from public RPC (read-only, no key) and rewrites the block between the
// STATS markers in README.md. The workflow commits the file only when the text changed.
// Display only: nothing here influences forecasts, and a failed read leaves README untouched.
//
// env: CODE_LEDGER_CONTRACT, REWARDS_CONTRACT, VOTING_CONTRACT (repository variables)

import { readFileSync, writeFileSync } from 'node:fs';
import { codeLedgerAbi, readConfig, rewardsAbi, Stage, votingAbi } from './contracts.mjs';
import { connect, withFallback } from './rpc.mjs';
import { Path } from './algorithm.mjs';

const README = new URL('../README.md', import.meta.url);
const START = '<!-- STATS:START -->';
const END = '<!-- STATS:END -->';
const RECENT_ROUNDS = 10;
const BATCH = 200;
const WINDOW = 32;
/** Multicall3, deployed at the same address on every EVM chain. Batches the per-round reads. */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

async function readStats(rpcs, config) {
  const head = await withFallback(rpcs, 'block number', (c) => c.getBlockNumber());
  const blockNumber = head - 2n;
  const ledger = { address: config.codeLedger, abi: codeLedgerAbi };
  const board = { address: config.voting, abi: votingAbi };
  const rewards = { address: config.rewards, abi: rewardsAbi };

  return withFallback(rpcs, 'stats', async (c) => {
    const read = (target, functionName, args = []) => c.readContract({ ...target, functionName, args, blockNumber });
    const many = async (calls) => {
      const out = [];
      for (let i = 0; i < calls.length; i += BATCH) {
        const contracts = calls.slice(i, i + BATCH);
        out.push(...(await c.multicall({ contracts, allowFailure: false, blockNumber, multicallAddress: MULTICALL3 })));
      }
      return out;
    };

    const [poolLinked, latestId, toHolders, toDev, paidHolders, paidDev] = await Promise.all([
      read(ledger, 'isPoolLinked'),
      read(board, 'latestForecastId'),
      read(rewards, 'totalBookedForHolders'),
      read(rewards, 'totalBookedForDev'),
      read(rewards, 'totalPaidToHolders'),
      read(rewards, 'totalPaidToDev'),
    ]);
    const priceTick = poolLinked ? await read(ledger, 'currentPriceTick') : null;

    // Every round's final record, for the scoreboard. runRecord is all zero until a round closes.
    const ids = Array.from({ length: Number(latestId) }, (_, i) => BigInt(i + 1));
    const records = await many(ids.map((id) => ({ ...ledger, functionName: 'runRecord', args: [id] })));

    // Details of the newest rounds.
    const recentIds = ids.slice(-RECENT_ROUNDS).reverse();
    const forecasts = await many(recentIds.map((id) => ({ ...board, functionName: 'forecastOf', args: [id] })));
    const current = latestId === 0n
      ? null
      : {
          stage: await read(board, 'stageOf', [latestId]),
          run: await read(ledger, 'runStatus', [latestId]),
        };

    return {
      priceTick,
      latestId,
      current,
      records,
      recent: recentIds.map((id, i) => ({ id, forecast: forecasts[i], record: records[Number(id) - 1] })),
      rewards: { toHolders, toDev, paid: paidHolders + paidDev },
    };
  });
}

// ── formatting ─────────────────────────────────────────────────────────────────────────────────

const arrow = (p) => (p === Path.UP ? '⬆️ UP' : p === Path.DOWN ? '⬇️ DOWN' : '—');

/** Price of 1 CLEDGER in ETH at a price tick (both tokens have 18 decimals). */
const priceAt = (tick) => 1.0001 ** tick;

function fmtPrice(x) {
  if (x >= 1) return x.toFixed(4);
  const decimals = Math.min(18, -Math.floor(Math.log10(x)) + 3);
  return x.toFixed(decimals);
}

function fmtEth(wei) {
  const eth = Number(wei) / 1e18;
  return eth === 0 ? '0' : eth < 0.0001 ? '< 0.0001' : eth.toFixed(4);
}

const pct = (ticks) => `${ticks >= 0 ? '+' : ''}${((priceAt(ticks) - 1) * 100).toFixed(2)}%`;

function bar(done, total = WINDOW, cells = 16) {
  const filled = Math.round((done / total) * cells);
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

function communityLine(f, votingOpen) {
  const up = f.upWeight;
  const down = f.downWeight;
  const total = up + down;
  if (total === 0n) return votingOpen ? 'no votes yet' : 'no votes, the code pick was used';
  const upShare = Number((up * 1000n) / total) / 10;
  return `⬆️ UP ${upShare.toFixed(1)}% · ⬇️ DOWN ${(100 - upShare).toFixed(1)}%`;
}

function resultOf(record) {
  if (record.id === 0n) return '…';
  return record.hitAtSwap !== 0 ? `🎯 HIT on trade ${record.hitAtSwap}` : '❌ MISS';
}

function render(s) {
  const lines = [];

  if (s.priceTick !== null) lines.push(`**Price now:** 1 CLEDGER ≈ ${fmtPrice(priceAt(s.priceTick))} ETH`, '');

  // Current round
  if (!s.current) {
    lines.push('### 📒 No rounds yet', '', 'The first forecast is coming soon.');
  } else {
    const f = s.recent[0].forecast;
    const { stage, run } = s.current;
    const [, , swapsPassed, hitAtSwap] = run;
    const title = {
      [Stage.VOTING]: '🗳️ Voting is open',
      [Stage.AWAITING_MERGE]: '⏳ Voting closed, waiting for the first trade',
      [Stage.RUNNING]: '🏃 Prediction in play',
      [Stage.CLOSED]: '✅ Finished, next round coming soon',
    }[stage] ?? '';
    lines.push(`### 📒 Round #${s.latestId} — ${title}`, '', '| | |', '|---|---|');
    lines.push(`| 🐱 Code picked | ${arrow(f.codeChoice)} |`);
    lines.push(`| ⬆️ UP target | ${fmtPrice(priceAt(f.upTargetTick))} ETH (${pct(f.upTargetTick - f.referenceTick)}) |`);
    lines.push(`| ⬇️ DOWN target | ${fmtPrice(priceAt(f.downTargetTick))} ETH (${pct(f.downTargetTick - f.referenceTick)}) |`);
    lines.push(`| 🗳️ Community vote | ${communityLine(f, stage === Stage.VOTING)} |`);
    if (stage === Stage.VOTING) {
      const closes = new Date(Number(f.voteClosesAt) * 1000).toISOString().slice(11, 16);
      lines.push(`| ⏰ Voting closes | ${closes} UTC |`);
    }
    if (f.mergedPath !== Path.NONE) {
      lines.push(`| 🛤️ Path in play | ${arrow(f.mergedPath)} |`);
      const record = s.recent[0].record;
      const passed = stage === Stage.RUNNING ? swapsPassed : record.swapsPassed;
      const hit = stage === Stage.RUNNING ? hitAtSwap : record.hitAtSwap;
      lines.push(`| 📈 Progress | ${bar(passed)} ${passed} / ${WINDOW} trades |`);
      if (hit !== 0 && hit < WINDOW) {
        const verb = stage === Stage.CLOSED ? 'got' : 'get';
        lines.push(`| 🎯 Result | HIT on trade ${hit}! Holders ${verb} 100% of fees on trades ${hit + 1}–${WINDOW} |`);
      } else if (hit !== 0) {
        lines.push(`| 🎯 Result | HIT on the last trade! |`);
      } else if (stage === Stage.CLOSED) {
        lines.push('| ❌ Result | MISS: the target was not reached |');
      }
    }
  }

  // Scoreboard
  const finished = s.records.filter((r) => r.id !== 0n);
  const hits = finished.filter((r) => r.hitAtSwap !== 0).length;
  const rate = finished.length ? `${Math.round((hits / finished.length) * 100)}%` : '—';
  lines.push('', '### 🏆 Scoreboard', '', '| Rounds finished | 🎯 Hits | ❌ Misses | Hit rate |', '|:---:|:---:|:---:|:---:|');
  lines.push(`| ${finished.length} | ${hits} | ${finished.length - hits} | ${rate} |`);

  // Rewards
  lines.push('', '### 💸 Fees shared in ETH', '', '| 👥 To holders | 🛠️ To development | ✅ Already claimed |', '|:---:|:---:|:---:|');
  lines.push(`| ${fmtEth(s.rewards.toHolders)} ETH | ${fmtEth(s.rewards.toDev)} ETH | ${fmtEth(s.rewards.paid)} ETH |`);

  // Recent rounds
  if (s.recent.length) {
    lines.push('', '### 📜 Latest rounds', '', '| Round | 🐱 Code | 🗳️ Community | 🛤️ Played | Result |', '|:---:|:---:|:---:|:---:|:---:|');
    for (const { id, forecast: f, record } of s.recent) {
      const votes = f.upWeight === f.downWeight ? 'tie / no votes' : arrow(f.upWeight > f.downWeight ? Path.UP : Path.DOWN);
      lines.push(`| #${id} | ${arrow(f.codeChoice)} | ${votes} | ${arrow(f.mergedPath)} | ${resultOf(record)} |`);
    }
  }

  return lines.join('\n');
}

async function main() {
  const config = readConfig();
  const rpcs = await connect({ rotate: Number(process.env.GITHUB_RUN_NUMBER ?? 0) });
  if (!rpcs.length) return console.log('stats: no RPC endpoint reachable; README unchanged');

  const stats = await readStats(rpcs, config);
  const readme = readFileSync(README, 'utf8');
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) return console.log('stats: markers not found in README.md; unchanged');

  const next = `${readme.slice(0, a + START.length)}\n${render(stats)}\n${readme.slice(b)}`;
  if (next === readme) return console.log('stats: no change');
  writeFileSync(README, next);
  console.log('stats: README.md updated');
}

main().catch((e) => {
  // Display only: never fail the workflow because the stats could not be read.
  console.log(`stats: README unchanged (${e.shortMessage ?? e.message})`);
});
