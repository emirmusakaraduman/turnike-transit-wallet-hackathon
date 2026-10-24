// Real load test on Monad Testnet: N fresh wallets (default 30) deposit, then ALL tap in at the same moment,
// then ALL tap out at the same moment. Funded from FAUCET_PRIVATE_KEY and swept back at the end.
// Wallet keys are written to .stress-wallets.json (gitignored) BEFORE funding, so an interrupted run is
// recovered automatically on the next start. Writes public/stress.json, which the Gate screen shows.
// Run: npm run stress
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { turnikeAbi } from "../src/lib/abi";
import { monadTestnet } from "../src/lib/chain";
import { transport } from "../src/lib/clients";

const N = Number(process.env.STRESS_N ?? 30);
const address = process.env.VITE_TURNIKE_ADDRESS!.trim() as Hex;
const faucet = privateKeyToAccount(process.env.FAUCET_PRIVATE_KEY!.trim() as Hex);
const KEYFILE = new URL("../.stress-wallets.json", import.meta.url);

const pub = createPublicClient({ chain: monadTestnet, transport });
const clientFor = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ account: a, chain: monadTestnet, transport });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OP = 1; // Ankara: max fare 0.05, so a 0.06 deposit is enough
const DEPOSIT = parseEther("0.06");
const FUND = parseEther("0.1");
const insufficient = (e: unknown) => /insufficient balance/i.test(String((e as Error)?.message ?? e));

type Account = ReturnType<typeof privateKeyToAccount>;
type Rec = { block: bigint; ms: number; ok: boolean };

/**
 * Withdraw any deposit and sweep native MON back to the faucet, one wallet at a time (the public RPC allows ~20
 * requests per second). A wallet only counts as recovered after the chain shows it empty; anything else keeps its key.
 */
async function recover(keys: Hex[]): Promise<Hex[]> {
  const stuck: Hex[] = [];
  for (const key of keys) {
    const w = privateKeyToAccount(key);
    const c = clientFor(w);
    let clean = false;
    for (let i = 0; i < 3 && !clean; i++) {
      try {
        const trip = await pub.readContract({ address, abi: turnikeAbi, functionName: "trips", args: [w.address] });
        if (trip[4]) await pub.waitForTransactionReceipt({ hash: await c.writeContract({ address, abi: turnikeAbi, functionName: "tapOut", args: [trip[0], trip[1]] }) });
        const bal = await pub.readContract({ address, abi: turnikeAbi, functionName: "balances", args: [w.address] });
        // the node estimates ~1M gas for withdraw and Monad charges the gas LIMIT, so give it a tight one
        if (bal > 0n) await pub.waitForTransactionReceipt({ hash: await c.writeContract({ address, abi: turnikeAbi, functionName: "withdraw", args: [bal], gas: 100_000n }) });
        const [native, fees] = await Promise.all([pub.getBalance({ address: w.address }), pub.estimateFeesPerGas()]);
        const reserve = 21_000n * (fees.maxFeePerGas ?? 0n) * 2n;
        if (native > reserve) await c.sendTransaction({ to: faucet.address, value: native - reserve, gas: 21_000n });
        const [left, nativeLeft] = await Promise.all([
          pub.readContract({ address, abi: turnikeAbi, functionName: "balances", args: [w.address] }),
          pub.getBalance({ address: w.address }),
        ]);
        clean = left === 0n && nativeLeft <= reserve * 2n;
      } catch (e) {
        const why = String((e as { details?: string }).details ?? (e as Error).message ?? e);
        console.log(`  ${w.address.slice(0, 8)}: ${why.slice(0, 90).replace(/\s+/g, " ")}`);
      }
      if (!clean) await sleep(4000);
    }
    if (!clean) stuck.push(key);
  }
  return stuck;
}

const saveKeys = (keys: Hex[]) => {
  if (existsSync(KEYFILE)) writeFileSync(new URL("../.stress-wallets.bak.json", import.meta.url), readFileSync(KEYFILE));
  if (keys.length) writeFileSync(KEYFILE, JSON.stringify(keys));
  else if (existsSync(KEYFILE)) unlinkSync(KEYFILE);
};

async function main() {
  let leftovers: Hex[] = [];
  if (existsSync(KEYFILE)) {
    console.log("recovering funds from a previous interrupted run…");
    leftovers = await recover(JSON.parse(readFileSync(KEYFILE, "utf8")) as Hex[]);
    if (leftovers.length) console.log(`${leftovers.length} wallet(s) still locked by the RPC; their keys stay in .stress-wallets.json`);
  }

  console.log(`stress: ${N} wallets`);
  const keys = Array.from({ length: N }, () => generatePrivateKey());
  saveKeys([...leftovers, ...keys]); // persist BEFORE any funding
  const wallets = keys.map((k) => privateKeyToAccount(k));

  try {
    // 1. fund sequentially from the faucet (one nonce stream), wait once at the end
    const f = clientFor(faucet);
    // one at a time, each confirmed: pipelined funding leaves some wallets unable to send for minutes
    for (const w of wallets) {
      const hash = await f.sendTransaction({ to: w.address, value: FUND });
      await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
      await sleep(1_500);
    }
    console.log("funded; letting the network see the new balances before the first send…");
    await sleep(8_000); // let the funding settle before the first send from a brand-new account

    // 2. deposit one wallet at a time (gentle on the public RPC). A wallet the RPC still rejects is skipped;
    //    its key stays in .stress-wallets.json so the funds can be recovered later.
    const active: Account[] = [];
    for (const w of wallets) {
      let ok = false;
      for (let i = 0; i < 2 && !ok; i++) {
        try {
          const hash = await clientFor(w).writeContract({ address, abi: turnikeAbi, functionName: "deposit", value: DEPOSIT });
          await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
          ok = true;
        } catch {
          await sleep(4_000);
        }
      }
      if (ok) active.push(w);
    }
    console.log(`deposited: ${active.length}/${N} wallets ready`);
    if (active.length < 5) throw new Error("too few wallets could send; try again in a few minutes");

    // 3. the load: everyone taps at once
    const fire = async (fn: "tapIn" | "tapOut", st: number): Promise<Rec[]> =>
      Promise.all(
        active.map(async (w): Promise<Rec> => {
          const t0 = Date.now();
          try {
            const hash = await clientFor(w).writeContract({ address, abi: turnikeAbi, functionName: fn, args: [OP, st] });
            const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
            return { block: rc.blockNumber, ms: Date.now() - t0, ok: rc.status === "success" };
          } catch {
            await sleep(500);
            try {
              const hash = await clientFor(w).writeContract({ address, abi: turnikeAbi, functionName: fn, args: [OP, st] });
              const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
              return { block: rc.blockNumber, ms: Date.now() - t0, ok: rc.status === "success" };
            } catch {
              return { block: 0n, ms: Date.now() - t0, ok: false };
            }
          }
        }),
      );

    const t0 = Date.now();
    const ins = await fire("tapIn", 1);
    console.log(`tapIn: ${ins.filter((r) => r.ok).length}/${active.length} ok`);
    const outs = await fire("tapOut", 3);
    console.log(`tapOut: ${outs.filter((r) => r.ok).length}/${active.length} ok`);
    const seconds = Math.round((Date.now() - t0) / 100) / 10;

    const ok = [...ins, ...outs].filter((r) => r.ok);
    const perBlock = new Map<bigint, number>();
    for (const r of ok) perBlock.set(r.block, (perBlock.get(r.block) ?? 0) + 1);
    const result = {
      n: active.length,
      taps: ok.length,
      blocks: perBlock.size,
      peak: Math.max(0, ...perBlock.values()),
      seconds,
      avgMs: Math.round(ok.reduce((s, r) => s + r.ms, 0) / Math.max(1, ok.length)),
      at: new Date().toISOString(),
    };
    console.log("RESULT", JSON.stringify(result));
    writeFileSync(new URL("../public/stress.json", import.meta.url), JSON.stringify(result));
  } finally {
    // 4. recover funds no matter what happened above
    const stuck = await recover(keys);
    saveKeys([...leftovers, ...stuck]);
    console.log(stuck.length ? `${stuck.length} wallet(s) could not be swept yet; rerun later to recover them` : "funds swept back to faucet");
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e).split("\n")[0].slice(0, 300));
  process.exit(1);
});
