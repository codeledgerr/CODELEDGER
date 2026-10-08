# Code Ledger — technical notes

A GitHub Actions workflow that reads the official **CLEDGER / native ETH Uniswap v4 pool** on
Ethereum Mainnet, computes a deterministic TWO PATHS forecast, and submits it to
`CodeLedgerVoting.pushForecast`.

The workflow **only submits forecasts**. Voting, finalizing the vote, the 32-swap window,
HIT/MISS and reward routing all happen onchain. This repository has no contract source code,
only the ABIs in [`abi/`](../abi).

## Setup

1. **Repository variables** (Settings → Secrets and variables → Actions → Variables):

   | Variable | Value |
   | --- | --- |
   | `CODE_LEDGER_CONTRACT` | CodeLedger (CLEDGER token + Uniswap v4 hook) |
   | `REWARDS_CONTRACT` | CodeLedgerRewards |
   | `VOTING_CONTRACT` | CodeLedgerVoting |
   | `DEPLOY_BLOCK` | Block number of the CodeLedger deployment. Logs are never read before it. |

   No other address is needed. The Uniswap v4 PoolManager address and the official pool ID are
   read from `CodeLedger.poolManager()` and `CodeLedger.officialPool()`. Each run checks that the
   three variables describe a single deployment: Voting and Rewards must be the ones CodeLedger
   points to, and Voting must point back to CodeLedger.

2. **Repository secret**: `FORECAST_SIGNER_PRIVATE_KEY`. This is the key of the
   `FORECAST_SIGNER` set at deployment, and it can only call `pushForecast`. Fund this wallet with
   a little ETH for gas. The key is used only to sign locally and is never printed. Only the
   signed transaction is sent to the RPC.

3. **Enable Actions.** The workflow runs every 5 minutes and can also be started by hand from the
   Actions tab ("Run workflow"). Set `dry_run` to compute and print a forecast without sending it.

4. **Allow the workflow to push** (Settings → Actions → General → Workflow permissions → "Read and
   write permissions"). It needs this only to commit the live stats in `README.md`. The push uses
   git with the built-in `GITHUB_TOKEN`, not the GitHub API and not an extra secret.

> GitHub disables scheduled workflows in repositories with no activity for 60 days. The stats
> commits normally keep the repository active. If the workflow is disabled anyway, re-enable it in
> the Actions tab.

## Live stats in README

After each forecast step, [`forecast/readme.mjs`](../forecast/readme.mjs) reads the contracts
(read-only, public RPC, no key) and rewrites the block between `<!-- STATS:START -->` and
`<!-- STATS:END -->` in `README.md`:

- the current round
- the scoreboard: finished rounds, HITs, MISSes and hit rate, from `runRecord` of every round
- ETH booked for holders and development, and the amount already claimed
- the last 10 rounds

The workflow commits `README.md` only when the text changed, with `[skip ci]` in the message.
Dry runs never commit.

The stats are for display only. Forecasts never read them, and if the stats can't be read, the
README is left unchanged and the run still succeeds.

Local run (Node 22+):

```sh
npm ci
npm test
CODE_LEDGER_CONTRACT=0x... REWARDS_CONTRACT=0x... VOTING_CONTRACT=0x... DEPLOY_BLOCK=... \
  DRY_RUN=true node forecast/main.mjs
```

## What a run does

1. Connects to the public Mainnet RPC endpoints listed in [`forecast/rpc.mjs`](../forecast/rpc.mjs)
   (no keys, nothing paid or private). It keeps the ones that answer with chain ID 1 and falls
   back to the next endpoint when a call fails.
2. Pins a block 2 blocks behind the head and reads everything at that block.
3. Reads `CodeLedgerVoting`. If a 10-minute vote is active, if voting has ended but the swap that
   starts the window hasn't happened yet, or if a 32-swap prediction is running, the run **stops
   successfully** without a transaction.
4. Reads the last 33 `Swap` events of the official pool from PoolManager logs, from
   `DEPLOY_BLOCK` onwards. That is the 32-swap sample plus the swap before it, which gives the
   starting price.
5. Computes the forecast (see below), validates it, simulates `pushForecast`, then signs, sends and
   waits for confirmation.
6. Prints only public information: forecast ID, reference tick, UP target, DOWN target,
   CODE CHOICE, transaction hash, and the algorithm inputs.

Because each run decides from onchain state alone, the exact cron timing doesn't matter. Runs
never overlap (`concurrency`). If a transaction from an earlier run is still pending, the run
waits for the next tick instead of sending a second one.

## Forecast algorithm

Everything is in [`forecast/algorithm.mjs`](../forecast/algorithm.mjs). It uses pure integer math in
basis points (±10000 = ±1.0), so anyone can re-run it on the same block and get the same result.

**Ticks.** All ticks are *price ticks of CLEDGER in ETH*, the convention `CodeLedgerVoting` uses.
A higher tick means CLEDGER is more expensive (UP). Native ETH (`address(0)`) is always
`currency0`, so CLEDGER is `currency1` and the price tick is the pool tick negated. The direction
is derived from the currency order. The run also checks it: the tick of the newest swap must equal
`CodeLedger.currentPriceTick()`.

**Sample.** The last 32 swaps of the official pool, plus the price right before them, give 32 tick
moves.

| Input | Definition |
| --- | --- |
| **A. Long momentum** | net tick move ÷ total absolute tick move, over all 32 swaps. +1 = every move up, −1 = every move down. |
| **B. Buy / sell pressure** | `(buyVolume − sellVolume) ÷ (buyVolume + sellVolume)` in ETH. A swap is a buy when ETH goes into the pool. |
| **C. Short momentum** | same as A, over the last 8 swaps only. |
| **D. Volatility** | average absolute tick move per swap. Sets target distance only, never direction. |

**CODE CHOICE.**

```
SCORE = 0.40 × LongMomentum + 0.40 × Pressure + 0.20 × ShortMomentum

SCORE >  +0.05                 → UP
SCORE <  −0.05                 → DOWN
otherwise ShortMomentum > +0.05 → UP
otherwise ShortMomentum < −0.05 → DOWN
otherwise                       → lowest bit of the pinned block's hash: even → UP, odd → DOWN
```

**Targets.** Both paths are always produced, symmetric around the reference tick (the live pool
price tick):

```
distance  = clamp(ceil(averageAbsTickMove × 6), 30, 1500)
UP target = reference + distance
DOWN target = reference − distance
```

Example: reference 201500, distance 60 → UP 201560, DOWN 201440.

The constants (`TARGET_MULTIPLIER`, `MIN_TARGET_DISTANCE`, `MAX_TARGET_DISTANCE`, weights and
neutral thresholds) are fixed at the top of `algorithm.mjs`. Changing them is a code change.

## Safety checks

A forecast is sent only if **all** of these hold. Otherwise the run stops successfully and tries
again on the next schedule:

- at least two RPC endpoints are reachable, and they return identical results for the pinned
  block hash, the contract wiring and the forecast state
- no active vote, no vote waiting for its first swap, no running 32-swap prediction
- the pool is initialized, and the pool has at least 33 swaps since `DEPLOY_BLOCK`
- every returned log belongs to the PoolManager and the official pool ID, is not removed, and lies
  in the queried range
- the tick of the newest swap equals the pool's current price tick, which proves no recent swap
  was missed
- DOWN < reference < UP, both distances are within [30, 1500], both targets are inside the
  Uniswap v4 tick range, and neither target is reached at the live tick
- the reference tick is within `MAX_REFERENCE_DRIFT` of the live tick
- simulating `pushForecast` against the live chain succeeds
- no earlier forecast transaction is still pending

A run **fails** (red, needs attention) only on misconfiguration or a failed transaction. Examples:
a missing variable or secret, variables from different deployments, a key that is not
`FORECAST_SIGNER`, or a transaction that reverted onchain.

## Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/forecast.yml` | schedule, manual dispatch, variables and secret |
| `forecast/main.mjs` | one run: read state, check, compute, submit |
| `forecast/algorithm.mjs` | the forecast algorithm and its validation (pure) |
| `forecast/algorithm.test.mjs` | unit tests, `npm test` |
| `forecast/rpc.mjs` | public RPC list, fallback, cross-checks, swap log scan |
| `forecast/contracts.mjs` | ABIs, Swap event, repository variable parsing |
| `forecast/submit.mjs` | signing, simulation, broadcast, confirmation |
| `forecast/readme.mjs` | live stats block in `README.md` (display only) |
| `abi/` | ABIs of CodeLedger, CodeLedgerVoting, CodeLedgerRewards |

The only dependency is [`viem`](https://viem.sh), pinned to an exact version. It handles ABI
encoding, transaction signing and JSON-RPC.
