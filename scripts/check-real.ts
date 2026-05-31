import 'dotenv/config';
import { ethers } from 'ethers';

const SAFE = process.env.POLYMARKET_PROXY_ADDRESS!;
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com', 137, { staticNetwork: true });
const ctf = new ethers.Contract(CTF, [
  'function balanceOfBatch(address[], uint256[]) view returns (uint256[])',
], provider);

async function main() {
  console.log('Safe:', SAFE);
  const r = await fetch(`https://data-api.polymarket.com/positions?user=${SAFE}&sizeThreshold=.01&redeemable=true&limit=100`);
  const arr: any[] = await r.json();

  const allTokens = new Set<string>();
  for (const p of arr) {
    if (p.asset) allTokens.add(p.asset);
    if (p.oppositeAsset) allTokens.add(p.oppositeAsset);
  }
  const ids = [...allTokens].map(s => BigInt(s));
  console.log(`Checking ${ids.length} tokenIds (from data-api asset/oppositeAsset fields)\n`);

  const accounts = ids.map(() => SAFE);
  const balances: bigint[] = await ctf.balanceOfBatch(accounts, ids);

  let nonZero = 0;
  let totalRedeemable = 0;
  for (let i = 0; i < ids.length; i++) {
    if (balances[i] > 0n) {
      nonZero++;
      const p = arr.find(x => BigInt(x.asset) === ids[i] || (x.oppositeAsset && BigInt(x.oppositeAsset) === ids[i]));
      const isMain = p && BigInt(p.asset) === ids[i];
      const outcome = isMain ? p?.outcome : p?.oppositeOutcome;
      const bal = Number(ethers.formatUnits(balances[i], 6));
      console.log(`✓ balance=${bal.toFixed(4)} | ${p?.title} | ${outcome} | conditionId=${p?.conditionId.slice(0,12)}...`);
      // Is this outcome the winner? data-api does not give payout directly, infer from curPrice
      if (isMain && p.curPrice === 1) totalRedeemable += bal;
      if (!isMain && p.curPrice === 0) totalRedeemable += bal; // opposite is the winner
    }
  }
  console.log(`\n=== Safe holds ${nonZero} non-zero tokens, total winning shares $${totalRedeemable.toFixed(4)} ===`);
}

main().catch(e => console.error(e));
