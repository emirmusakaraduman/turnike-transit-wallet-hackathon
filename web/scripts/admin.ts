// Owner and operator-admin actions from the command line (the browser admin panel needs a wallet extension).
//   npm run admin -- status
//   npm run admin -- pause | unpause
//   npm run admin -- rate <wei per lira cent>        e.g. 10000000000000  (1 lira = 0.001 MON)
//   npm run admin -- refund <operator id> <rider address> <amount in MON>
// The key comes from PRIVATE_KEY (see ../.deployer.env) and is never printed.
import { createPublicClient, createWalletClient, formatEther, isAddress, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { turnikeAbi } from "../src/lib/abi";
import { monadTestnet } from "../src/lib/chain";
import { transport } from "../src/lib/clients"; // several public RPCs with automatic fallback (one alone rate-limits)

const address = process.env.VITE_TURNIKE_ADDRESS!.trim() as Hex;
const pub = createPublicClient({ chain: monadTestnet, transport });
const [cmd, ...args] = process.argv.slice(2);

const key = process.env.PRIVATE_KEY?.trim() as Hex | undefined;
const account = key ? privateKeyToAccount(key) : undefined;
const wallet = account ? createWalletClient({ account, chain: monadTestnet, transport }) : undefined;

const read = <T extends "owner" | "paused" | "weiPerCent" | "operatorCount">(functionName: T) =>
  pub.readContract({ address, abi: turnikeAbi, functionName });

async function send(functionName: "pause" | "unpause" | "setRate" | "refund", fnArgs: unknown[]) {
  if (!wallet || !account) throw new Error("set PRIVATE_KEY (the owner / operator admin key)");
  const hash = await wallet.writeContract({ address, abi: turnikeAbi, functionName, args: fnArgs } as never);
  await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  console.log(`${functionName}: done (${hash})`);
}

switch (cmd) {
  case "status": {
    const owner = await read("owner");
    const paused = await read("paused");
    const rate = await read("weiPerCent");
    const ops = await read("operatorCount");
    console.log({ contract: address, owner, paused, weiPerCent: rate.toString(), onelira_in_MON: formatEther(rate * 100n), operators: ops });
    break;
  }
  case "pause":
  case "unpause":
    await send(cmd, []);
    break;
  case "rate": {
    if (!/^\d+$/.test(args[0] ?? "")) throw new Error("usage: rate <wei per lira cent>");
    await send("setRate", [BigInt(args[0])]);
    break;
  }
  case "refund": {
    const [op, rider, amount] = args;
    if (!/^\d+$/.test(op ?? "") || !isAddress(rider ?? "") || !(Number(amount) > 0)) throw new Error("usage: refund <operator id> <rider address> <amount in MON>");
    await send("refund", [Number(op), rider, parseEther(amount)]);
    break;
  }
  default:
    console.log("commands: status | pause | unpause | rate <wei> | refund <op> <rider> <MON>");
}
