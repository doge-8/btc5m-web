import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const SAFE = process.env.POLYMARKET_PROXY_ADDRESS!;
const ADAPTER = '0xADa100874d00e3331D00F2007a9c336a65009718';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });

const ctfRO = new ethers.Contract(CTF, [
  'function getCollectionId(bytes32, bytes32, uint256) view returns (bytes32)',
  'function getPositionId(address, bytes32) view returns (uint256)',
  'function balanceOf(address, uint256) view returns (uint256)',
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32, uint256) view returns (uint256)',
], provider);

async function main() {
  console.log('Safe:', SAFE);
  console.log('CtfCollateralAdapter:', ADAPTER);

  // Fetch all claimable (do not filter curPrice, see the full set)
  const r = await fetch(`https://data-api.polymarket.com/positions?user=${SAFE}&sizeThreshold=.01&redeemable=true&limit=100`);
  const arr: any[] = await r.json();
  console.log(`data-api reports: ${arr.length} candidates\n`);

  // For each conditionId, test both collateralToken types: CTF direct PUSD vs adapter
  // But actually the V2 token uses adapter as the collateralToken to create the positionId, so:
  // Old positions (V1, pre-migration) use PUSD as collateralToken
  // New positions (V2 post-migration) use adapter as collateralToken
  for (const p of arr.slice(0, 5)) {
    console.log(`\n=== ${p.title} (cond=${p.conditionId.slice(0,12)}...) ===`);
    const denom = await ctfRO.payoutDenominator(p.conditionId);
    if (denom === 0n) { console.log('Not resolved'); continue; }
    const num0 = await ctfRO.payoutNumerators(p.conditionId, 0);
    const num1 = await ctfRO.payoutNumerators(p.conditionId, 1);
    console.log(`payout: [${num0}, ${num1}] denom=${denom}`);

    // Compute positionId using PUSD as collateralToken
    for (const collat of [PUSD, ADAPTER]) {
      console.log(`  collateral=${collat === PUSD ? 'PUSD' : 'ADAPTER'}`);
      for (const idx of [1, 2]) {
        const collId = await ctfRO.getCollectionId(ethers.ZeroHash, p.conditionId, idx);
        const posId = await ctfRO.getPositionId(collat, collId);
        const bal = await ctfRO.balanceOf(SAFE, posId);
        console.log(`    indexSet=${idx} balance=${ethers.formatUnits(bal, 6)}`);
      }
    }
  }
}

main().catch(e => console.error(e));
