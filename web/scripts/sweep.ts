// Moves the MON out of the two project wallets (sponsor + deployer) to an address YOU choose.
// Nothing is sent unless you pass --yes; without it the script only shows what it would do.
//
//   npm run sweep -- 0xYourAddress           (dry run: prints the plan)
//   npm run sweep -- 0xYourAddress --yes     (sends)
//
// Keys are read from web/.env.local (FAUCET_PRIVATE_KEY) and ../.deployer.env (PRIVATE_KEY) and are never printed.
// Afterwards the app can no longer pay riders' gas and the owner commands (pause, rate, refund) have no gas.
import { createPublicClient, createWalletClient, formatEther, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "../src/lib/chain";
import { transport } from "../src/lib/clients";

const [dest, flag] = process.argv.slice(2);
if (!dest || !isAddress(dest)) {
  console.error("usage: npm run sweep -- 0xYourAddress [--yes]\nThe address must be a valid 0x… address you control.");
  process.exit(1);
}
const send = flag === "--yes";

const pub = createPublicClient({ chain: monadTestnet, transport });
const wallets: { name: string; key: Hex }[] = [
  { name: "sponsor wallet (FAUCET_PRIVATE_KEY)", key: process.env.FAUCET_PRIVATE_KEY?.trim() as Hex },
  { name: "deployer wallet (PRIVATE_KEY)", key: process.env.PRIVATE_KEY?.trim() as Hex },
].filter((w) => w.key);

const fees = await pub.estimateFeesPerGas();
const reserve = 21_000n * (fees.maxFeePerGas ?? 0n) * 2n; // gas for the transfer itself, with headroom

console.log(`destination: ${dest as Address}\n${send ? "SENDING" : "dry run (add --yes to send)"}\n`);
for (const w of wallets) {
  const account = privateKeyToAccount(w.key);
  if (account.address.toLowerCase() === dest.toLowerCase()) {
    console.log(`${w.name}: skipped (it is the destination)`);
    continue;
  }
  const balance = await pub.getBalance({ address: account.address });
  const amount = balance - reserve;
  console.log(`${w.name} ${account.address}: balance ${formatEther(balance)} MON -> would send ${amount > 0n ? formatEther(amount) : "0"} MON`);
  if (!send || amount <= 0n) continue;
  const client = createWalletClient({ account, chain: monadTestnet, transport });
  const hash = await client.sendTransaction({ to: dest as Address, value: amount, gas: 21_000n });
  const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
  console.log(`  ${rc.status === "success" ? "sent" : "FAILED"} (${hash})`);
}
