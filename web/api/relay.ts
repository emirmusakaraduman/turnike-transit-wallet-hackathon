import { parseEther, recoverTypedDataAddress, type Hex } from "viem";
import { turnikeAbi } from "../src/lib/abi.js";
import { REQ_TYPES, domainFor, fromWire } from "../shared/typed.js";
import { ADDRESS, chain, clientIp, limiter, pub, reason, sendOrdered, sponsor, type Req, type Res } from "./_relayer.js";

// POST /api/relay { req, signature }: submits a rider-signed tap or withdraw and pays its gas.
// The rider's signature (EIP-712) is checked here first, so nothing unsigned ever costs the sponsor wallet gas.
const WINDOW_MS = 60 * 60_000;
const lim = limiter(WINDOW_MS);
const PER_RIDER = 240;
const PER_IP = 600;
const GLOBAL = 6000;
let globalHits: number[] = [];

// Monad charges for the gas LIMIT, so the limit is kept tight. `withdraw` sends MON out and is estimated at ~1M gas
// by the node, so it gets a fixed limit that was verified to be enough.
const WITHDRAW_GAS = 150_000n;

export default async function handler(req: Req, res: Res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const s = sponsor();
  if (!s || !ADDRESS || /^0x0*$/i.test(ADDRESS)) return res.status(503).json({ error: "sponsorship not configured" });

  let body: { req?: unknown; signature?: unknown };
  try {
    body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as typeof body;
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const parsed = fromWire(body?.req);
  const signature = body?.signature;
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return res.status(400).json({ error: "bad signature" });
  const m = parsed.msg;

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (m.deadline < nowSec) return res.status(400).json({ error: "expired" });
  if (m.deadline > nowSec + 600n) return res.status(400).json({ error: "deadline too far" });

  const signer = await recoverTypedDataAddress({
    domain: domainFor(chain.id, ADDRESS),
    types: REQ_TYPES,
    primaryType: "Req",
    message: m,
    signature: signature as Hex,
  }).catch(() => null);
  if (!signer || signer.toLowerCase() !== m.rider.toLowerCase()) return res.status(400).json({ error: "bad signature" });

  const now = Date.now();
  const ip = clientIp(req);
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  if (globalHits.length >= GLOBAL) return res.status(429).json({ error: "sponsor budget reached, try later" });
  if (!lim.allow(`ip:${ip}`, PER_IP, now) || !lim.allow(`rider:${m.rider.toLowerCase()}`, PER_RIDER, now)) {
    return res.status(429).json({ error: "too many requests" });
  }

  try {
    const args = [m, signature as Hex] as const;
    // the sponsor-budget check and the dry run go out together (a would-be revert such as "balance < max fare" or
    // "paused" is then reported without spending gas)
    const [sponsorBalance, est] = await Promise.all([
      pub.getBalance({ address: s.account.address }),
      m.action === 2 ? Promise.resolve(0n) : pub.estimateContractGas({ address: ADDRESS, abi: turnikeAbi, functionName: "relay", args, account: s.account }),
    ]);
    if (sponsorBalance < parseEther("0.02")) return res.status(503).json({ error: "sponsor wallet is out of funds" });
    const gas = m.action === 2 ? WITHDRAW_GAS : (est * 125n) / 100n;
    const hash = await sendOrdered(s.account.address, (nonce) =>
      s.wallet.writeContract({ address: ADDRESS, abi: turnikeAbi, functionName: "relay", args, gas, nonce }),
    );
    lim.record(`ip:${ip}`, now);
    lim.record(`rider:${m.rider.toLowerCase()}`, now);
    globalHits.push(now);
    return res.status(200).json({ ok: true, hash });
  } catch (e) {
    // a contract revert is a real answer (400); anything else is an outage the client may work around (502)
    const revert = /revert|reason:/i.test(String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? ""));
    return res.status(revert ? 400 : 502).json({ error: reason(e) });
  }
}

