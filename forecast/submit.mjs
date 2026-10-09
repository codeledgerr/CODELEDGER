// Transaction submission: CodeLedgerVoting.pushForecast, signed locally by the forecast signer.
//
// The private key only ever lives in this process (from the FORECAST_SIGNER_PRIVATE_KEY secret).
// It is never logged, and only the signed raw transaction is sent to the RPC endpoints.

import { BaseError, ContractFunctionRevertedError, encodeFunctionData, keccak256, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prepareTransactionRequest } from 'viem/actions';
import { mainnet } from 'viem/chains';
import { votingAbi } from './contracts.mjs';
import { withFallback } from './rpc.mjs';

/** Extra gas on top of the estimate, in percent. */
const GAS_BUFFER_PERCENT = 20n;
const RECEIPT_TIMEOUT_MS = 10 * 60_000;

/** Loads the signer from the secret. The error message never contains the key. */
export function loadSigner(env = process.env) {
  let key = (env.FORECAST_SIGNER_PRIVATE_KEY ?? '').trim();
  if (key && !key.startsWith('0x')) key = `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('secret FORECAST_SIGNER_PRIVATE_KEY is missing or malformed');
  }
  return privateKeyToAccount(key);
}

/** The Voting custom error name if `e` is a contract revert, otherwise null. */
function revertName(e) {
  if (!(e instanceof BaseError)) return null;
  const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return revert ? (revert.data?.errorName ?? revert.reason ?? 'unknown revert') : null;
}

/**
 * Simulates, signs, broadcasts and confirms pushForecast.
 * Returns { skipped: reason } when nothing was sent, { reverted: hash, receipt } when the
 * transaction was mined but reverted, otherwise { hash, receipt, forecastId, pushed }.
 */
export async function submitForecast(rpcs, { account, voting, forecast }) {
  const args = [forecast.referenceTick, forecast.upTargetTick, forecast.downTargetTick, forecast.codeChoice];

  // A transaction from an earlier run that is still pending would make this one revert.
  const [confirmedNonce, pendingNonce] = await withFallback(rpcs, 'nonce', (c) =>
    Promise.all([
      c.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      c.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ]),
  );
  if (pendingNonce > confirmedNonce) return { skipped: 'a previous forecast transaction is still pending' };

  // Dry-run against the live chain. A revert means the state changed since it was read.
  let revert = null;
  await withFallback(rpcs, 'simulate pushForecast', async (c) => {
    try {
      await c.simulateContract({ account, address: voting, abi: votingAbi, functionName: 'pushForecast', args });
    } catch (e) {
      revert = revertName(e);
      if (!revert) throw e; // network problem: try the next endpoint
    }
  });
  if (revert) return { skipped: `pushForecast would revert with ${revert}` };

  const request = await withFallback(rpcs, 'prepare transaction', async (c) => {
    const req = await prepareTransactionRequest(c, {
      account,
      chain: mainnet,
      to: voting,
      data: encodeFunctionData({ abi: votingAbi, functionName: 'pushForecast', args }),
      nonce: confirmedNonce,
    });
    return { ...req, gas: (req.gas * (100n + GAS_BUFFER_PERCENT)) / 100n };
  });
  const serializedTransaction = await account.signTransaction(request);
  const hash = keccak256(serializedTransaction);

  // Broadcasting the same signed transaction twice is harmless, so fallback is safe here.
  await withFallback(rpcs, 'broadcast', async (c) => {
    try {
      await c.sendRawTransaction({ serializedTransaction });
    } catch (e) {
      if (!/already known|known transaction/i.test(e?.message ?? '')) throw e;
    }
  });
  console.log(`transaction sent: ${hash}`);

  const receipt = await withFallback(rpcs, 'wait for receipt', (c) =>
    c.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
  );
  if (receipt.status !== 'success') return { reverted: hash, receipt };

  const votingLogs = receipt.logs.filter((l) => l.address.toLowerCase() === voting.toLowerCase());
  const [pushed] = parseEventLogs({ abi: votingAbi, eventName: 'ForecastPushed', logs: votingLogs });
  if (!pushed) throw new Error(`transaction ${hash} confirmed without a ForecastPushed event`);
  return { hash, receipt, forecastId: pushed.args.id, pushed: pushed.args };
}
