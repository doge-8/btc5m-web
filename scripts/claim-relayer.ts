import 'dotenv/config';
import { ethers } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY!;
const PROXY = process.env.POLYMARKET_PROXY_ADDRESS!;
const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const RELAYER = 'https://relayer-v2.polymarket.com';
const MULTISEND = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';
const DRY_RUN = process.argv.includes('--dry-run');

if (!PRIVATE_KEY || !PROXY) { console.error('Missing env'); process.exit(1); }

const ZERO32 = '0x' + '0'.repeat(64);
const ctfIface = new ethers.Interface([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
]);
const safeIface = new ethers.Interface([
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
]);

// Pack redeemPositions into a single multiSend item: [op(1)][to(20)][value(32)][dataLen(32)][data]
function encodeMultiSendItem(to: string, data: string): string {
  const op = '00'; // CALL
  const toHex = to.toLowerCase().replace(/^0x/, '').padStart(40, '0');
  const valueHex = '0'.repeat(64);
  const dataBytes = ethers.getBytes(data);
  const lenHex = dataBytes.length.toString(16).padStart(64, '0');
  const dataHex = data.replace(/^0x/, '');
  return op + toHex + valueHex + lenHex + dataHex;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contracts = getContractConfig(137);
  const CTF = contracts.conditionalTokens;
  const COLLATERAL = contracts.collateral;

  console.log('EOA:', wallet.address);
  console.log('Proxy(Safe):', PROXY);
  console.log('CTF:', CTF, ' Collateral:', COLLATERAL);

  // 1. Query claimable
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${PROXY}&sizeThreshold=.01&redeemable=true&limit=100&offset=0`);
  const arr: any[] = await res.json();
  const claimable = arr.filter(p => p.curPrice === 1);
  console.log(`Claimable position count: ${claimable.length}`);
  claimable.forEach(p => console.log(`  - ${p.title} | $${p.currentValue.toFixed(4)}`));
  if (!claimable.length) { console.log('Nothing to claim, exiting'); return; }
  const total = claimable.reduce((s, p) => s + p.currentValue, 0);
  console.log(`Total: $${total.toFixed(4)}`);

  // 2. Single redeemPositions (per the official docs example, operation=0 CALL sent directly to CTF)
  const p = claimable[0];
  const data = ctfIface.encodeFunctionData('redeemPositions', [
    COLLATERAL, ZERO32, p.conditionId, [1, 2]
  ]);
  console.log('redeemPositions data length:', data.length / 2 - 1, 'bytes');

  // 3. Compute Safe txHash + signature
  const safe = new ethers.Contract(PROXY, safeIface, provider);
  const nonce: bigint = await safe.nonce();
  console.log('Safe nonce:', nonce.toString());
  const txHash: string = await safe.getTransactionHash(
    CTF, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
  );
  console.log('Safe txHash:', txHash);
  const sig = await wallet.signMessage(ethers.getBytes(txHash));
  const v = parseInt(sig.slice(-2), 16) + 4;
  const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, '0');

  // 4. Build the request body (per the official docs: operation=0 CALL, to=CTF, no metadata)
  const body = {
    from: wallet.address,
    to: CTF,
    proxyWallet: PROXY,
    data,
    nonce: nonce.toString(),
    signature: adjustedSig,
    signatureParams: {
      gasPrice: '0',
      operation: '0',
      safeTxnGas: '0',
      baseGas: '0',
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
    },
    type: 'SAFE',
  };

  if (DRY_RUN) {
    console.log('\n--- DRY_RUN body ---');
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  // 5. Submit
  const RELAYER_API_KEY = process.env.RELAYER_API_KEY!;
  const RELAYER_API_KEY_ADDRESS = process.env.RELAYER_API_KEY_ADDRESS!;
  if (!RELAYER_API_KEY || !RELAYER_API_KEY_ADDRESS) {
    console.error('Missing RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS env');
    process.exit(1);
  }
  console.log('\nSubmitting to relayer...');
  // Use undici fetch to explicitly preserve header case
  const { fetch: undiciFetch } = await import('undici');
  const submitRes: any = await undiciFetch(`${RELAYER}/submit`, {
    method: 'POST',
    headers: [
      ['Content-Type', 'application/json'],
      ['RELAYER_API_KEY', RELAYER_API_KEY],
      ['RELAYER_API_KEY_ADDRESS', RELAYER_API_KEY_ADDRESS],
    ],
    body: JSON.stringify(body),
  });
  const submitText = await submitRes.text();
  console.log('Status:', submitRes.status);
  console.log('Body:', submitText);
  if (submitRes.status === 401) {
    // Retry with curl to confirm whether the server really cannot see our headers
    console.log('\n[debug] Retrying with curl');
    const curlCmd = `curl -s -i -X POST '${RELAYER}/submit' -H 'Content-Type: application/json' -H 'RELAYER_API_KEY: ${RELAYER_API_KEY}' -H 'RELAYER_API_KEY_ADDRESS: ${RELAYER_API_KEY_ADDRESS}' -d '${JSON.stringify(body)}'`;
    const { execSync } = await import('child_process');
    try {
      const out = execSync(curlCmd, { encoding: 'utf8' });
      console.log(out);
    } catch (e: any) {
      console.error(e.message);
    }
    return;
  }
  if (!submitRes.ok) { process.exit(1); }
  const { transactionID, transactionHash, state } = JSON.parse(submitText);
  console.log(`✓ Submitted successfully id:${transactionID} txHash:${transactionHash} state:${state}`);

  // 6. Poll
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await fetch(`${RELAYER}/transaction?id=${transactionID}`);
    const j = await r.json();
    console.log(`[${i+1}] state:${j.state} txHash:${j.transactionHash}`);
    if (j.state && j.state !== 'STATE_NEW' && j.state !== 'STATE_PENDING') {
      console.log('Final state:', j);
      break;
    }
  }
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
