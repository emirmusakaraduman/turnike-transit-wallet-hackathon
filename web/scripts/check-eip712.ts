// Checks that the typed data the browser signs hashes EXACTLY like the contract's `hashReq` (so signatures verify).
// Run after every deploy: npm run check:eip712
import { createPublicClient, hashTypedData, http, type Hex } from "viem";
import { turnikeAbi } from "../src/lib/abi";
import { monadTestnet, RPC_URL } from "../src/lib/chain";
import { ACTION, REQ_TYPES, domainFor, type ReqMessage } from "../shared/typed";

const address = process.env.VITE_TURNIKE_ADDRESS!.trim() as Hex;
const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC_URL) });

const samples: ReqMessage[] = [
  { rider: "0x1111111111111111111111111111111111111111", action: ACTION.tapIn, op: 1, station: 2, amount: 0n, to: "0x1111111111111111111111111111111111111111", nonce: 0n, deadline: 1_900_000_000n },
  { rider: "0xa0ee7a142d267c1f36714e4a8f75612f20a79720", action: ACTION.tapOut, op: 2, station: 3, amount: 0n, to: "0x0000000000000000000000000000000000000000", nonce: 7n, deadline: 2_000_000_000n },
  { rider: "0xdd2fd4581271e230360230f9337d5c0430bf44c0", action: ACTION.withdraw, op: 0, station: 0, amount: 123_456_789_000_000_000n, to: "0x2c4de655e3a89af1d2b6c6d5a656f60f8db867d8", nonce: 99n, deadline: 2_100_000_000n },
];

let bad = 0;
for (const m of samples) {
  const mine = hashTypedData({ domain: domainFor(monadTestnet.id, address), types: REQ_TYPES, primaryType: "Req", message: m });
  const theirs = await pub.readContract({ address, abi: turnikeAbi, functionName: "hashReq", args: [m] });
  const same = mine === theirs;
  if (!same) bad++;
  console.log(same ? "match   " : "MISMATCH", ["tapIn", "tapOut", "withdraw"][m.action], mine.slice(0, 18));
}
if (bad) process.exit(1);
console.log("EIP-712 hashes agree with the contract.");
