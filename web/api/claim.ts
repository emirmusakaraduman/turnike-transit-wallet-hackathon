import { parseEther } from "viem";
import { turnikeAbi } from "../src/lib/abi.js";
import { ADDRESS, clientIp, limiter, pub, reason, sendOrdered, sponsor, type Req, type Res } from "./_relayer.js";

// POST /api/claim { op }: pays out an operator's earnings. `claim` is permissionless and the money always goes to the
// operator's own payout address, so the sponsor wallet can safely pay the gas for it.
const lim = limiter(60_000);

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const s = sponsor();
  if (!s || !ADDRESS || /^0x0*$/i.test(ADDRESS)) return res.status(503).json({ error: "not configured" });

  let body: { op?: unknown };
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as typeof body;
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const op = Number(body?.op);
  if (!Number.isInteger(op) || op < 1 || op > 1000) return res.status(400).json({ error: "bad operator" });

  const now = Date.now();
  if (!lim.allow(`op:${op}`, 1, now) || !lim.allow(`ip:${clientIp(req)}`, 6, now)) return res.status(429).json({ error: "too many requests" });
  lim.record(`op:${op}`, now);
  lim.record(`ip:${clientIp(req)}`, now);

  try {
    const [balance, pending] = await Promise.all([
      pub.getBalance({ address: s.account.address }),
      pub.readContract({ address: ADDRESS, abi: turnikeAbi, functionName: "pending", args: [op] }),
    ]);
    if (pending === 0n) return res.status(400).json({ error: "nothing to claim" });
    if (balance < parseEther("0.02")) return res.status(503).json({ error: "sponsor wallet is out of funds" });
    // the 16-shard sum plus the payout transfer needs far less than this, and Monad charges the gas limit
    const hash = await sendOrdered(s.account.address, (nonce) =>
      s.wallet.writeContract({ address: ADDRESS, abi: turnikeAbi, functionName: "claim", args: [op], gas: 250_000n, nonce }),
    );
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    if (rc.status !== "success") return res.status(500).json({ error: "claim failed" });
    return res.status(200).json({ ok: true, hash });
  } catch (e) {
    return res.status(500).json({ error: reason(e) });
  }
}
