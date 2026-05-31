/**
 * Polymarket Proxy Wallet withdraw test script
 *
 * Uses Gnosis Safe execTransaction: EOA signs SafeTx EIP-712 hash -> call Proxy to transfer out USDC
 * Does not depend on the official Polymarket API, interacts directly with the on-chain Safe + USDC contracts
 *
 * Usage:
 *   1. Fill in CONFIG below (private key / Proxy / target address / withdraw amount)
 *   2. tsx scripts/test-withdraw.ts
 *
 * Safety: DRY_RUN=true by default, only prints, does not send transactions. Change to false after confirming the params are correct.
 */

import { ethers } from "ethers";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Simple .env loader (no third-party package)
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dirname, "..", ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// ── Config ──────────────────────────────────────────────────
// Private key and Proxy are read from .env (POLYMARKET_PRIVATE_KEY / POLYMARKET_PROXY_ADDRESS)
// This test script only tests one wallet; for production batch withdraws write a separate script that reads multi-wallet config
const CONFIG = {
  // Withdraw target wallet (required)
  TO_ADDRESS:      "0x__TARGET_ADDRESS__",
  // Withdraw amount (USDC, 6 decimals). Use 0.01 for testing
  AMOUNT_USDC:     "0.01",
  // true = only print, do not send on-chain; false = actually send the transaction
  DRY_RUN:         true,
} as const;

const EOA_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY || "";
const PROXY_ADDRESS   = process.env.POLYMARKET_PROXY_ADDRESS || "";
if (!EOA_PRIVATE_KEY || !PROXY_ADDRESS) {
  console.error("✗ .env is missing POLYMARKET_PRIVATE_KEY or POLYMARKET_PROXY_ADDRESS");
  process.exit(1);
}

// ── Constants ────────────────────────────────────────────────────
const POLYGON_RPC      = "https://polygon-bor-rpc.publicnode.com";
const POLYGON_CHAIN_ID = 137;
// Polymarket uses USDC.e (PoS bridge USDC), not native USDC
const USDC_ADDRESS     = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS    = 6;

// Gnosis Safe ABI (only the parts used)
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function VERSION() view returns (string)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256)",
  "function decimals() view returns (uint8)",
];

// SafeTx EIP-712 type
const EIP712_SAFE_TX_TYPE = {
  SafeTx: [
    { type: "address", name: "to" },
    { type: "uint256", name: "value" },
    { type: "bytes",   name: "data" },
    { type: "uint8",   name: "operation" },
    { type: "uint256", name: "safeTxGas" },
    { type: "uint256", name: "baseGas" },
    { type: "uint256", name: "gasPrice" },
    { type: "address", name: "gasToken" },
    { type: "address", name: "refundReceiver" },
    { type: "uint256", name: "nonce" },
  ],
};

async function main() {
  console.log("─── Polymarket Proxy withdraw test ───");
  console.log(`DRY_RUN: ${CONFIG.DRY_RUN}`);

  const provider = new ethers.JsonRpcProvider(POLYGON_RPC, POLYGON_CHAIN_ID);
  const eoa = new ethers.Wallet(EOA_PRIVATE_KEY, provider);
  console.log(`EOA:    ${eoa.address}`);
  console.log(`Proxy:  ${PROXY_ADDRESS}`);
  console.log(`To:     ${CONFIG.TO_ADDRESS}`);

  // 1. Check Safe status
  const safe = new ethers.Contract(PROXY_ADDRESS, SAFE_ABI, provider);
  const [owners, threshold, safeNonce] = await Promise.all([
    safe.getOwners() as Promise<string[]>,
    safe.getThreshold() as Promise<bigint>,
    safe.nonce() as Promise<bigint>,
  ]);
  console.log(`Owners: ${owners.join(", ")}`);
  console.log(`Threshold: ${threshold}  Nonce: ${safeNonce}`);
  if (!owners.map(o => o.toLowerCase()).includes(eoa.address.toLowerCase())) {
    throw new Error("EOA is not an owner of the Proxy, misconfigured");
  }
  if (threshold !== 1n) {
    throw new Error(`Proxy threshold=${threshold}, this script only supports 1/1 Safe`);
  }

  // 2. Check USDC balance
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(PROXY_ADDRESS) as bigint;
  const balanceHuman = ethers.formatUnits(balance, USDC_DECIMALS);
  console.log(`Proxy USDC balance: ${balanceHuman}`);

  const amountWei = ethers.parseUnits(CONFIG.AMOUNT_USDC, USDC_DECIMALS);
  if (amountWei > balance) {
    throw new Error(`Insufficient balance: trying to withdraw ${CONFIG.AMOUNT_USDC}, only have ${balanceHuman}`);
  }
  console.log(`Withdraw amount: ${CONFIG.AMOUNT_USDC} USDC (${amountWei} wei)`);

  // 3. Check EOA MATIC (pays gas)
  const maticBalance = await provider.getBalance(eoa.address);
  console.log(`EOA MATIC: ${ethers.formatEther(maticBalance)}`);
  if (maticBalance < ethers.parseEther("0.01")) {
    console.warn("⚠ EOA MATIC < 0.01, may not have enough gas");
  }

  // 4. Build the callData for USDC.transfer(to, amount)
  const usdcIface = new ethers.Interface(ERC20_ABI);
  const transferData = usdcIface.encodeFunctionData("transfer", [CONFIG.TO_ADDRESS, amountWei]);
  console.log(`transferData: ${transferData}`);

  // 5. Assemble SafeTx
  const safeTx = {
    to: USDC_ADDRESS,
    value: 0n,
    data: transferData,
    operation: 0,         // CALL
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: safeNonce,
  };

  // 6. EIP-712 signature
  const domain = {
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: PROXY_ADDRESS,
  };
  const signature = await eoa.signTypedData(domain, EIP712_SAFE_TX_TYPE, safeTx);
  console.log(`SafeTx signature: ${signature}`);

  if (CONFIG.DRY_RUN) {
    console.log("\n✓ DRY_RUN: all params OK, no transaction sent");
    console.log("  Set CONFIG.DRY_RUN = false and run again to actually withdraw");
    return;
  }

  // 7. Send on-chain: call Proxy.execTransaction(...)
  const safeWithSigner = safe.connect(eoa) as ethers.Contract;
  console.log("\nSending execTransaction…");
  const tx = await safeWithSigner.execTransaction(
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    signature
  );
  console.log(`tx hash: ${tx.hash}`);
  console.log("Waiting for confirmation…");
  const rec = await tx.wait();
  if (rec?.status === 1) {
    console.log(`✓ Success block=${rec.blockNumber} gas=${rec.gasUsed}`);
    const newBal = await usdc.balanceOf(PROXY_ADDRESS) as bigint;
    console.log(`Proxy new balance: ${ethers.formatUnits(newBal, USDC_DECIMALS)} USDC`);
  } else {
    console.log("✗ tx mined but status=0 (execTransaction reverted internally)");
  }
}

main().catch(err => {
  console.error("✗ Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
