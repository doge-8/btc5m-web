import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const SAFE = '0xeCbD41A018cAD2BdD3Fd560b40b472f6ff54c336';
const COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CONDITION_ID = '0x104f27e82a923cf3832854ae080bd8838ad288ee719e5cb1ac140e3b982d8f3d';

const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });

const erc20 = new ethers.Contract(COLLATERAL, [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
], provider);

const ctfIface = new ethers.Interface([
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);
const ctf = new ethers.Contract(CTF, ctfIface, provider);

async function main() {
  const sym = await erc20.symbol();
  const dec = await erc20.decimals();
  const bal = await erc20.balanceOf(SAFE);
  console.log(`Safe ${SAFE}`);
  console.log(`${sym} balance: ${ethers.formatUnits(bal, dec)} (decimals=${dec})`);

  // Query the token balance on each outcome (real on-chain data)
  for (const indexSet of [1, 2]) {
    const collId = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, indexSet);
    const posId = await ctf.getPositionId(COLLATERAL, collId);
    const tokBal = await ctf.balanceOf(SAFE, posId);
    const human = ethers.formatUnits(tokBal, 6);
    console.log(`indexSet=${indexSet} (${indexSet === 1 ? 'No' : 'Yes/Down?'}) tokenBalance=${human}`);
  }

  // payouts
  const denom = await ctf.payoutDenominator(CONDITION_ID);
  console.log(`payoutDenominator: ${denom}`);
  for (let i = 0; i < 2; i++) {
    const num = await ctf.payoutNumerators(CONDITION_ID, i);
    console.log(`payoutNumerators[${i}]: ${num} (${num > 0n ? 'win' : 'lose'})`);
  }

  // Check whether data-api still lists it as redeemable
  console.log('\n--- data-api positions ---');
  const r1 = await fetch(`https://data-api.polymarket.com/positions?user=${SAFE}&sizeThreshold=.01&redeemable=true&limit=100`);
  const a1: any[] = await r1.json();
  console.log('redeemable=true returned:', a1.length, 'items');
  a1.forEach(p => console.log(`  curPrice=${p.curPrice} size=${p.size} value=${p.currentValue} outcome=${p.outcome} title=${p.title}`));

  console.log('\n--- Recent activity ---');
  const r2 = await fetch(`https://data-api.polymarket.com/activity?user=${SAFE}&limit=10`);
  const a2: any[] = await r2.json();
  a2.forEach(a => console.log(`  ${a.type} ${a.title || ''} size=${a.size || ''} ts=${a.timestamp}`));
}

main().catch(e => console.error(e));
