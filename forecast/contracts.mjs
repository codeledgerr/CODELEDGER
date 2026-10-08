// Contract ABIs and addresses.
//
// abi/*.json are the full ABIs of the deployed Code Ledger contracts (compiler output, no source).
// The only other contract read is the Uniswap v4 PoolManager, and only for its Swap event; its
// address is read from CodeLedger.poolManager(), so no extra configuration is needed.

import { getAddress, isAddress, parseAbiItem } from 'viem';
import codeLedgerAbi from '../abi/CodeLedger.json' with { type: 'json' };
import votingAbi from '../abi/CodeLedgerVoting.json' with { type: 'json' };
import rewardsAbi from '../abi/CodeLedgerRewards.json' with { type: 'json' };

export { codeLedgerAbi, votingAbi, rewardsAbi };

/** Uniswap v4 IPoolManager.Swap. amount0/amount1 are the swapper's deltas (negative = paid in). */
export const swapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);

/** CodeLedgerVoting.Stage */
export const Stage = Object.freeze({ NONE: 0, VOTING: 1, AWAITING_MERGE: 2, RUNNING: 3, CLOSED: 4 });
export const stageName = (s) => Object.keys(Stage).find((k) => Stage[k] === s) ?? `UNKNOWN(${s})`;

/** Reads the repository variables. Throws on anything missing or malformed. */
export function readConfig(env = process.env) {
  const address = (name) => {
    const v = (env[name] ?? '').trim();
    if (!isAddress(v)) throw new Error(`repository variable ${name} is missing or not an address`);
    return getAddress(v);
  };
  const deployBlockRaw = (env.DEPLOY_BLOCK ?? '').trim();
  if (!/^\d+$/.test(deployBlockRaw)) throw new Error('repository variable DEPLOY_BLOCK is missing or not a block number');
  return {
    codeLedger: address('CODE_LEDGER_CONTRACT'),
    rewards: address('REWARDS_CONTRACT'),
    voting: address('VOTING_CONTRACT'),
    deployBlock: BigInt(deployBlockRaw),
  };
}
