import { createHmac, timingSafeEqual } from "node:crypto";

type Req = { method?: string; query?: Record<string, string | string[] | undefined>; body?: unknown };
type Res = { status: (c: number) => Res; json: (b: unknown) => void };

// Rotating station QR: token = HMAC(secret, "op.st.window"), window = 20 s. A token verifies for its own
// window and the previous one (20-40 s), so a photographed QR is useless a minute later.
// GET  /api/qr?op&st&key  -> mint a token (only for the gate screen: `key` must equal GATE_KEY)
// POST /api/qr {op,st,t}  -> verify; a missing token passes unless QR_REQUIRED=1
const WINDOW_MS = 20_000;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const sign = (secret: string, op: number, st: number, w: number) =>
  createHmac("sha256", secret).update(`${op}.${st}.${w}`).digest("hex").slice(0, 16);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export default function handler(req: Req, res: Res) {
  const secret = process.env.QR_SECRET?.trim();
  const required = process.env.QR_REQUIRED === "1";
  const w = Math.floor(Date.now() / WINDOW_MS);

  if (req.method === "GET") {
    const gateKey = process.env.GATE_KEY?.trim();
    if (!secret) return res.status(501).json({ error: "rotating QR not configured" });
    if (!gateKey || !same(one(req.query?.key), gateKey)) return res.status(403).json({ error: "forbidden" });
    const op = Number(one(req.query?.op));
    const st = Number(one(req.query?.st));
    if (!Number.isInteger(op) || !Number.isInteger(st)) return res.status(400).json({ error: "bad station" });
    return res.status(200).json({ t: sign(secret, op, st, w), exp: (w + 1) * WINDOW_MS });
  }

  if (req.method === "POST") {
    const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as { op?: number; st?: number; t?: string | null } | undefined;
    const op = Number(b?.op);
    const st = Number(b?.st);
    if (!b?.t) return res.status(200).json(required ? { ok: false, reason: "missing" } : { ok: true, reason: "missing" });
    if (!secret) return res.status(200).json({ ok: true });
    const t = String(b.t);
    const ok = same(t, sign(secret, op, st, w)) || same(t, sign(secret, op, st, w - 1));
    return res.status(200).json(ok ? { ok: true } : { ok: false, reason: "expired" });
  }

  return res.status(405).json({ error: "method not allowed" });
}
