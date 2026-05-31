import 'dotenv/config';
import { ethers } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';

const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY!;
const PROXY = process.env.POLYMARKET_PROXY_ADDRESS!;
const DRY_RUN = process.argv.includes('--dry-run');

if (!PRIVATE_KEY || !PROXY) { console.error('Missing env'); process.exit(1); }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contracts = getContractConfig(137);
  const CTF = contracts.conditionalTokens;
  const COLLATERAL = contracts.collateral;
  // V2: redeem goes through CtfCollateralAdapter, which internally redeems CTF + auto-wraps pUSD
  const ADAPTER = '0xADa100874d00e3331D00F2007a9c336a65009718';
  const ZERO_BYTES32 = '0x' + '0'.repeat(64);

  console.log('EOA:', wallet.address);
  console.log('Safe:', PROXY);
  console.log('CTF:', CTF);
  console.log('Adapter:', ADAPTER);
  console.log('Collateral:', COLLATERAL);
  console.log('RPC:', RPC);
  console.log('DRY_RUN:', DRY_RUN);

  const ctfIface = new ethers.Interface([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
  ]);
  const safeIface = new ethers.Interface([
    'function nonce() view returns (uint256)',
    'function getOwners() view returns (address[])',
    'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
    'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool)',
  ]);
  const safe = new ethers.Contract(PROXY, safeIface, wallet);

  const owners: string[] = await safe.getOwners();
  console.log('Safe owners:', owners);
  const isOwner = owners.map(o => o.toLowerCase()).includes(wallet.address.toLowerCase());
  console.log('EOA is owner?:', isOwner);
  if (!isOwner) { console.error('❌ EOA is not a Safe owner'); process.exit(1); }

  const bal = await provider.getBalance(wallet.address);
  console.log('EOA POL balance:', ethers.formatEther(bal));

  // Query claimable positions
  const res = await fetch(`https://data-api.polymarket.com/positions?user=${PROXY}&sizeThreshold=.01&redeemable=true&limit=100&offset=0`);
  const arr: any[] = await res.json();
  const claimable = arr.filter(p => p.curPrice === 1);
  console.log(`\nClaimable position count: ${claimable.length}`);
  claimable.forEach(p => console.log(`  - ${p.title} | $${p.currentValue.toFixed(4)} | ${p.conditionId}`));
  if (!claimable.length) { console.log('Nothing to claim, exiting'); return; }

  for (let i = 0; i < claimable.length; i++) {
    const p = claimable[i];
    console.log(`\n[${i+1}/${claimable.length}] ${p.title}`);
    try {
      const calldata = ctfIface.encodeFunctionData('redeemPositions', [
        COLLATERAL, ZERO_BYTES32, p.conditionId, [1, 2]
      ]);
      const nonce: bigint = await safe.nonce();
      console.log(`  nonce: ${nonce}`);
      const txHash: string = await safe.getTransactionHash(
        ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
      );
      const sig = await wallet.signMessage(ethers.getBytes(txHash));
      const v = parseInt(sig.slice(-2), 16) + 4;
      const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, '0');

      // First verify with estimateGas / staticCall
      try {
        await safe.execTransaction.staticCall(
          ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig
        );
        console.log('  ✓ staticCall passed');
      } catch (e: any) {
        console.error(`  ✗ staticCall failed: ${e.shortMessage || e.message}`);
        continue;
      }

      const gasEst = await safe.execTransaction.estimateGas(
        ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig
      );
      console.log(`  estimateGas: ${gasEst}`);

      if (DRY_RUN) {
        console.log('  (DRY_RUN, skipping send)');
        continue;
      }

      const tx = await safe.execTransaction(
        ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig
      );
      console.log(`  Sent txHash: ${tx.hash}`);
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('On-chain timeout 60s')), 60000))
      ]) as any;
      console.log(`  ✓ Success block:${receipt.blockNumber} gasUsed:${receipt.gasUsed}`);
    } catch (e: any) {
      console.error(`  ✗ Failed: ${e.shortMessage || e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
