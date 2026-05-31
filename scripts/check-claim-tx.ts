import 'dotenv/config';
import { ethers } from 'ethers';

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const TX = '0x098206326325e231fc5068c46fb7fabd5930b3789f0ed3a99cf2e0415a97a4ef';
const SAFE = '0xeCbD41A018cAD2BdD3Fd560b40b472f6ff54c336';
const COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CONDITION_ID = '0x104f27e82a923cf3832854ae080bd8838ad288ee719e5cb1ac140e3b982d8f3d';

const provider = new ethers.JsonRpcProvider(RPC, 137, { staticNetwork: true });

const ctfIface = new ethers.Interface([
  'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
  'function getPositionId(address collateralToken, bytes32 collectionId) view returns (uint256)',
  'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
]);
const safeIface = new ethers.Interface([
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
]);
const erc20Iface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

async function main() {
  const receipt = await provider.getTransactionReceipt(TX);
  if (!receipt) { console.error('Could not fetch receipt'); return; }
  console.log('Block:', receipt.blockNumber, 'Status:', receipt.status, 'Logs count:', receipt.logs.length);

  // Parse all logs
  for (const log of receipt.logs) {
    console.log('\n---');
    console.log('addr:', log.address);
    // Try to parse PayoutRedemption
    try {
      const parsed = ctfIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) { console.log('CTF event:', parsed.name, parsed.args); continue; }
    } catch {}
    try {
      const parsed = safeIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) { console.log('Safe event:', parsed.name, parsed.args); continue; }
    } catch {}
    try {
      const parsed = erc20Iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) {
        console.log('ERC20 Transfer:', parsed.args.from, '→', parsed.args.to, ethers.formatUnits(parsed.args.value, 6), '(assuming 6 decimals)');
        continue;
      }
    } catch {}
    console.log('Unknown event topics[0]:', log.topics[0]);
  }

  // Query condition status on-chain
  console.log('\n--- Condition status ---');
  const ctf = new ethers.Contract(CTF, ctfIface, provider);
  const denom = await ctf.payoutDenominator(CONDITION_ID);
  console.log('payoutDenominator:', denom.toString());
  if (denom > 0n) {
    const slot = await ctf.getOutcomeSlotCount(CONDITION_ID);
    console.log('outcomeSlotCount:', slot.toString());
    for (let i = 0; i < Number(slot); i++) {
      const num = await ctf.payoutNumerators(CONDITION_ID, i);
      console.log(`  slot[${i}] payout:`, num.toString());
    }
  } else {
    console.log('⚠️ payoutDenominator=0 means the market has not resolved / has not reportPayouts yet');
  }

  // Query the Safe's previous token balances on both outcomes (after redeem they should theoretically both be 0)
  console.log('\n--- Safe current token balances ---');
  for (const indexSet of [1, 2]) {
    const collId = await ctf.getCollectionId(ethers.ZeroHash, CONDITION_ID, indexSet);
    const posId = await ctf.getPositionId(COLLATERAL, collId);
    const bal = await ctf.balanceOf(SAFE, posId);
    console.log(`indexSet=${indexSet} positionId=${posId.toString().slice(0,20)}... balance=${bal}`);
  }
}

main().catch(e => console.error(e));
