import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const SAFE = process.env.POLYMARKET_PROXY_ADDRESS!;
const COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });
const ctf = new ethers.Contract(CTF, [
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32, uint256) view returns (uint256)',
  'function getCollectionId(bytes32, bytes32, uint256) view returns (bytes32)',
  'function getPositionId(address, bytes32) view returns (uint256)',
  'function balanceOf(address, uint256) view returns (uint256)',
], provider);

async function main() {
  console.log('Safe:', SAFE);

  // data-api candidates
  const r = await fetch(`https://data-api.polymarket.com/positions?user=${SAFE}&sizeThreshold=.01&redeemable=true&limit=100`);
  const arr: any[] = await r.json();
  console.log(`data-api reports: ${arr.length} redeemable, of which curPrice=1: ${arr.filter(p=>p.curPrice===1).length}\n`);

  let realTotal = 0;
  let fakeCount = 0;
  for (const p of arr) {
    const denom = await ctf.payoutDenominator(p.conditionId);
    if (denom === 0n) {
      console.log(`✗ ${p.title} | market not resolved`);
      continue;
    }
    let realPayout = 0n;
    for (const idx of [1, 2]) {
      const collId = await ctf.getCollectionId(ethers.ZeroHash, p.conditionId, idx);
      const posId = await ctf.getPositionId(COLLATERAL, collId);
      const bal = await ctf.balanceOf(SAFE, posId);
      const num = await ctf.payoutNumerators(p.conditionId, idx - 1);
      realPayout += bal * num / denom;
    }
    const real = Number(ethers.formatUnits(realPayout, 6));
    if (real > 0) {
      console.log(`✓ Claimable $${real.toFixed(4)} | ${p.title} | data-api reports $${p.currentValue.toFixed(4)}`);
      realTotal += real;
    } else {
      console.log(`✗ Already claimed $0 | ${p.title} | data-api still reports $${p.currentValue.toFixed(4)} (index not refreshed)`);
      fakeCount++;
    }
  }
  console.log(`\n=== On-chain real claimable: $${realTotal.toFixed(4)} | data-api stale data: ${fakeCount} items ===`);
}

main().catch(e => console.error(e));
