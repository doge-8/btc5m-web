/**
 * On-chain fill size calibration
 *
 * Parses the CTF TransferSingle events in a Polygon transaction receipt
 * to obtain the real buy/sell fill size (on-chain truth).
 *
 * Purpose: correct the size deviation pushed by Polymarket UserWS (on buy, the
 * size reported by WS differs from the real on-chain size by about 1%).
 *
 * Measured latency: 300-700ms (dRPC), about 5 seconds faster than REST API polling.
 */

import { ethers } from "ethers";

// ERC-1155 TransferSingle event topic
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

// Public Polygon RPCs (sorted by measured latency)
const RPCS = [
  "https://polygon.drpc.org",                    // fastest ~200ms
  "https://polygon-bor-rpc.publicnode.com",      // fallback 1
  "https://1rpc.io/matic",                       // fallback 2
];

const QUERY_TIMEOUT_MS = 3000;
// Use a full Network object + staticNetwork object version to avoid ethers v6 still triggering eth_chainId detection during construction
const POLYGON_NETWORK = new ethers.Network("polygon", 137);

// Reuse provider instances to avoid triggering network detection on each creation
const providerCache = new Map<string, ethers.JsonRpcProvider>();

function getProvider(url: string): ethers.JsonRpcProvider {
  let p = providerCache.get(url);
  if (!p) {
    // Pass the Network object to staticNetwork so ethers skips the eth_chainId detection at startup
    p = new ethers.JsonRpcProvider(url, POLYGON_NETWORK, { staticNetwork: POLYGON_NETWORK });
    // Silence the error event (ethers v6 throws by default; we handle it ourselves with catch)
    p.on("error", () => { /* ignore, handled by the caller */ });
    providerCache.set(url, p);
  }
  return p;
}

/**
 * Query the tx receipt from one RPC (with timeout)
 */
async function queryReceipt(url: string, txHash: string): Promise<ethers.TransactionReceipt | null> {
  try {
    const rpc = getProvider(url);
    return await Promise.race([
      rpc.getTransactionReceipt(txHash),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return null;
  }
}

/**
 * Parse the CTF TransferSingle events in a tx that involve the Proxy
 * @returns net fill size (positive = buy/inflow, negative = sell/outflow);
 *          null means all RPCs failed to query, should fall back to REST
 */
export async function getRealFillFromTx(
  txHash: string,
  proxy: string,
): Promise<number | null> {
  if (!txHash || !proxy) return null;

  const proxyPadded = ethers.zeroPadValue(proxy.toLowerCase(), 32);

  for (const url of RPCS) {
    const receipt = await queryReceipt(url, txHash);
    if (!receipt) continue;

    // tx failed (in theory a UserWS MINED won't fail, but handle defensively)
    if (receipt.status !== 1) return 0;

    let totalIn = 0n;
    let totalOut = 0n;

    for (const log of receipt.logs) {
      if (log.topics[0] !== TRANSFER_SINGLE) continue;
      // TransferSingle(operator, from, to, id, value)
      //   topics[0] = event sig
      //   topics[1] = operator
      //   topics[2] = from
      //   topics[3] = to
      //   data      = id (32 bytes) + value (32 bytes)
      if (log.topics.length < 4) continue;
      const value = BigInt("0x" + log.data.slice(66));
      const isIn = log.topics[3].toLowerCase() === proxyPadded.toLowerCase();
      const isOut = log.topics[2].toLowerCase() === proxyPadded.toLowerCase();
      if (isIn) totalIn += value;
      else if (isOut) totalOut += value;
    }

    // CTF size has 6 decimals (same as USDC)
    return Number(totalIn - totalOut) / 1e6;
  }

  return null;  // all RPCs failed
}
