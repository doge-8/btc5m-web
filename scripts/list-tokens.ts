import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const SAFE = process.env.POLYMARKET_PROXY_ADDRESS!;
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });

// Scan all tokens held by the Safe via TransferSingle/TransferBatch events
const ctfIface = new ethers.Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
]);
const ctf = new ethers.Contract(CTF, ctfIface, provider);

async function main() {
  console.log('Safe:', SAFE);
  const latest = await provider.getBlockNumber();
  console.log('Current block:', latest);

  // Scan the last 50000 blocks (~30 hours, polygon ~2.3s/block)
  const fromBlock = latest - 50000;
  console.log(`Scanning ${fromBlock} → ${latest}`);

  const safePadded = ethers.zeroPadValue(SAFE, 32);
  const TRANSFER_SINGLE = ctfIface.getEvent('TransferSingle')!.topicHash;

  // Scan in segments
  const tokenIds = new Set<string>();
  const STEP = 10000;
  for (let from = fromBlock; from <= latest; from += STEP) {
    const to = Math.min(from + STEP - 1, latest);
    // to = SAFE
    const logsIn = await provider.getLogs({
      address: CTF,
      topics: [TRANSFER_SINGLE, null, null, safePadded],
      fromBlock: from, toBlock: to,
    });
    for (const log of logsIn) {
      const parsed = ctfIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) tokenIds.add(parsed.args.id.toString());
    }
    process.stdout.write(`.`);
  }
  console.log(`\nFound ${tokenIds.size} distinct tokenIds (received within the last 30h)`);

  if (tokenIds.size === 0) return;

  // Batch query balances
  const ids = [...tokenIds];
  const accounts = ids.map(() => SAFE);
  const balances: bigint[] = await ctf.balanceOfBatch(accounts, ids);

  let nonZero = 0;
  for (let i = 0; i < ids.length; i++) {
    if (balances[i] > 0n) {
      nonZero++;
      console.log(`tokenId=${ids[i]} balance=${ethers.formatUnits(balances[i], 6)}`);
    }
  }
  console.log(`\n=== Total ${nonZero} tokens with balance > 0 ===`);
}

main().catch(e => console.error(e));
