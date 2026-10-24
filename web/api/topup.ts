import { isAddress, parseEther } from "viem";
import { turnikeAbi } from "../src/lib/abi.js";
import { ADDRESS, clientIp, limiter, pub, reason, sendOrdered, sponsor, type Req, type Res } from "./_relayer.js";

// POST /api/topup { rider, amount }: a SIMULATED card payment. No payment is collected; the sponsor wallet credits the
// rider's turnstile balance (depositFor) so a first-time rider needs no crypto at all. A real deployment would call
// this only after a payment provider confirms the charge.
const WINDOW_MS = 60 * 60_000;
const lim = limiter(WINDOW_MS);
const PER_RIDER = 8;
const PER_IP = 20;
const GLOBAL = 500;
const MIN = parseEther("0.01");
const MAX = parseEther("0.25");
let globalHits: number[] = [];

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const s = sponsor();
  if (!s || !ADDRESS || /^0x0*$/i.test(ADDRESS)) return res.status(503).json({ error: "top-up not configured" });

  let body: { rider?: unknown; amount?: unknown };
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as typeof body;
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const rider = body?.rider;
  if (typeof rider !== "string" || !isAddress(rider)) return res.status(400).json({ error: "bad address" });
  let amount: bigint;
  try {
    amount = parseEther(String(body?.amount ?? "0.1"));
  } catch {
    return res.status(400).json({ error: "bad amount" });
  }
  if (amount < MIN || amount > MAX) return res.status(400).json({ error: "amount must be between 0.01 and 0.25 MON" });

  const now = Date.now();
  const ip = clientIp(req);
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  if (globalHits.length >= GLOBAL) return res.status(429).json({ error: "demo budget reached, try later" });
  if (!lim.allow(`ip:${ip}`, PER_IP, now)) return res.status(429).json({ error: "too many top-ups from this network" });
  if (!lim.allow(`rider:${rider.toLowerCase()}`, PER_RIDER, now)) return res.status(429).json({ error: "too many top-ups for this wallet" });

  try {
    if ((await pub.getBalance({ address: s.account.address })) < amount + parseEther("0.05")) {
      return res.status(503).json({ error: "demo wallet is out of funds" });
    }
    const hash = await sendOrdered(s.account.address, (nonce) =>
      s.wallet.writeContract({ address: ADDRESS, abi: turnikeAbi, functionName: "depositFor", args: [rider], value: amount, nonce }),
    );
    const rc = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    if (rc.status !== "success") return res.status(500).json({ error: "top-up transaction failed" });
    lim.record(`ip:${ip}`, now);
    lim.record(`rider:${rider.toLowerCase()}`, now);
    globalHits.push(now);
    return res.status(200).json({ ok: true, hash, simulated: true });
  } catch (e) {
    return res.status(500).json({ error: reason(e) });
  }
}
