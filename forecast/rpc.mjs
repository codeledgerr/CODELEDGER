// Ethereum Mainnet access over PUBLIC RPC endpoints only (no keys, no paid or private RPC).
//
// Every call rotates through the reachable endpoints until one answers. Critical reads are made
// against a pinned block number so that different endpoints can be compared exactly.

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { swapEvent } from './contracts.mjs';

/**
 * Keyless public endpoints. Not all of them serve eth_getLogs over wide ranges or historical
 * eth_call; a failing endpoint is simply moved to the back of the queue for the rest of the run.
 */
export const PUBLIC_RPC_URLS = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.mevblocker.io',
  'https://mainnet.gateway.tenderly.co',
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
  'https://1rpc.io/eth',
  'https://eth.blockrazor.xyz',
  'https://eth-mainnet.public.blastapi.io',
];

const REQUEST_TIMEOUT_MS = 20_000;
/** eth_getLogs block span: start here, halve down to MIN when an endpoint rejects the range. */
const LOG_SPAN_START = 5_000n;
const LOG_SPAN_MIN = 100n;

/** Every reachable endpoint failed: the run cannot trust its data and should stop quietly. */
export class RpcUnavailableError extends Error {}

export const hostOf = (url) => new URL(url).host;
const brief = (e) => (e?.shortMessage ?? e?.message ?? String(e)).split('\n')[0].slice(0, 200);

/**
 * Probes all endpoints in parallel and returns the ones that answer as Ethereum Mainnet.
 * `rotate` shifts the starting endpoint so consecutive runs spread their load.
 */
export async function connect({ urls = PUBLIC_RPC_URLS, rotate = 0 } = {}) {
  const ordered = urls.map((_, i) => urls[(i + rotate) % urls.length]);
  const probes = await Promise.allSettled(
    ordered.map(async (url) => {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }),
      });
      const chainId = await client.getChainId();
      if (chainId !== mainnet.id) throw new Error(`wrong chain id ${chainId}`);
      return { url, host: hostOf(url), client };
    }),
  );
  const rpcs = [];
  probes.forEach((p, i) => {
    if (p.status === 'fulfilled') rpcs.push(p.value);
    else console.log(`rpc ${hostOf(ordered[i])}: unavailable (${brief(p.reason)})`);
  });
  console.log(`rpc: ${rpcs.length}/${urls.length} endpoints reachable: ${rpcs.map((r) => r.host).join(', ')}`);
  return rpcs;
}

/** Moves a failing endpoint to the back of the queue so later calls try the healthy ones first. */
function demote(rpcs, rpc) {
  const i = rpcs.indexOf(rpc);
  if (i !== -1) rpcs.push(...rpcs.splice(i, 1));
}

/** Runs `fn(client, rpc)` on each endpoint in turn until one succeeds. */
export async function withFallback(rpcs, label, fn) {
  for (const rpc of [...rpcs]) {
    try {
      return await fn(rpc.client, rpc);
    } catch (e) {
      console.log(`rpc ${rpc.host}: ${label} failed (${brief(e)})`);
      demote(rpcs, rpc);
    }
  }
  throw new RpcUnavailableError(`${label}: no public RPC endpoint answered`);
}

/**
 * Runs `fn` on two DIFFERENT endpoints and requires identical answers. Used for the state the
 * forecast is built on, so one faulty or lagging endpoint cannot cause a submission.
 */
export async function crossChecked(rpcs, label, fn) {
  const answers = [];
  for (const rpc of [...rpcs]) {
    try {
      answers.push({ host: rpc.host, value: await fn(rpc.client) });
    } catch (e) {
      console.log(`rpc ${rpc.host}: ${label} failed (${brief(e)})`);
      demote(rpcs, rpc);
    }
    if (answers.length === 2) break;
  }
  if (answers.length < 2) throw new RpcUnavailableError(`${label}: fewer than two endpoints answered`);
  const [a, b] = answers;
  if (stableJson(a.value) !== stableJson(b.value)) {
    throw new RpcUnavailableError(`${label}: ${a.host} and ${b.host} disagree`);
  }
  return a.value;
}

const stableJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

/**
 * Returns the newest `needed` Swap events of `poolId`, oldest first, scanning backwards from
 * `toBlock` but never below `fromBlock`. Fewer are returned only if the pool has fewer swaps.
 */
export async function fetchRecentSwaps(rpcs, { poolManager, poolId, fromBlock, toBlock, needed }) {
  const found = [];
  let hi = toBlock;
  let span = LOG_SPAN_START;
  while (hi >= fromBlock && found.length < needed) {
    const lo = hi - span + 1n > fromBlock ? hi - span + 1n : fromBlock;
    let logs;
    try {
      logs = await withFallback(rpcs, `getLogs ${lo}-${hi}`, (c) =>
        c.getLogs({ address: poolManager, event: swapEvent, args: { id: poolId }, fromBlock: lo, toBlock: hi, strict: true }),
      );
    } catch (e) {
      if (e instanceof RpcUnavailableError && span > LOG_SPAN_MIN) {
        span /= 2n;
        continue;
      }
      throw e;
    }
    for (const log of logs) {
      // Defence against a faulty endpoint: only exact, canonical logs of the official pool.
      if (
        log.removed ||
        log.address.toLowerCase() !== poolManager.toLowerCase() ||
        log.args.id.toLowerCase() !== poolId.toLowerCase() ||
        log.blockNumber < lo ||
        log.blockNumber > hi
      ) {
        throw new RpcUnavailableError(`getLogs ${lo}-${hi}: endpoint returned a log outside the query`);
      }
    }
    logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
    found.unshift(...logs);
    hi = lo - 1n;
  }
  return found.slice(-needed);
}
