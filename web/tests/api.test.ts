import { createHmac } from "node:crypto";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { ACTION, REQ_TYPES, domainFor, fromWire, toWire, type ReqMessage } from "../shared/typed";

const CONTRACT = "0xfc51584b18de3235b117c0ed6ade4b94c4f9e62b" as const;

function fakeRes() {
  const out: { code: number; body: unknown } = { code: 0, body: undefined };
  const res = {
    status(c: number) {
      out.code = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
    },
  };
  return { res, out };
}

let qr: typeof import("../api/qr").default;
let relay: typeof import("../api/relay").default;
let helpers: typeof import("../api/_relayer");

beforeAll(async () => {
  process.env.QR_SECRET = "test-secret";
  process.env.GATE_KEY = "gate-key";
  process.env.VITE_TURNIKE_ADDRESS = CONTRACT;
  process.env.FAUCET_PRIVATE_KEY = generatePrivateKey();
  qr = (await import("../api/qr")).default;
  relay = (await import("../api/relay")).default;
  helpers = await import("../api/_relayer");
});

describe("/api/qr", () => {
  const call = (req: Parameters<typeof qr>[0]) => {
    const { res, out } = fakeRes();
    qr(req, res);
    return out;
  };

  it("mints tokens only for the gate screen", () => {
    expect(call({ method: "GET", query: { op: "1", st: "1", key: "nope" } }).code).toBe(403);
    expect(call({ method: "GET", query: { op: "1", st: "1" } }).code).toBe(403);
    const ok = call({ method: "GET", query: { op: "1", st: "2", key: "gate-key" } });
    expect(ok.code).toBe(200);
    expect((ok.body as { t: string }).t).toMatch(/^[0-9a-f]{16}$/);
  });

  it("verifies a token for its station only", () => {
    const { t } = call({ method: "GET", query: { op: "1", st: "2", key: "gate-key" } }).body as { t: string };
    expect(call({ method: "POST", body: { op: 1, st: 2, t } }).body).toEqual({ ok: true });
    expect(call({ method: "POST", body: { op: 1, st: 3, t } }).body).toMatchObject({ ok: false, reason: "expired" });
    expect(call({ method: "POST", body: { op: 1, st: 2, t: "0000000000000000" } }).body).toMatchObject({ ok: false });
  });

  it("matches the documented HMAC scheme and accepts the previous window", () => {
    const w = Math.floor(Date.now() / 20_000);
    const prev = createHmac("sha256", "test-secret").update(`1.2.${w - 1}`).digest("hex").slice(0, 16);
    expect(call({ method: "POST", body: { op: 1, st: 2, t: prev } }).body).toEqual({ ok: true });
    const old = createHmac("sha256", "test-secret").update(`1.2.${w - 5}`).digest("hex").slice(0, 16);
    expect(call({ method: "POST", body: { op: 1, st: 2, t: old } }).body).toMatchObject({ ok: false });
  });

  it("lets a static (token-less) QR through unless QR_REQUIRED=1", () => {
    expect(call({ method: "POST", body: { op: 1, st: 1, t: null } }).body).toMatchObject({ ok: true });
    process.env.QR_REQUIRED = "1";
    expect(call({ method: "POST", body: { op: 1, st: 1, t: null } }).body).toMatchObject({ ok: false, reason: "missing" });
    delete process.env.QR_REQUIRED;
  });

  it("rejects other methods", () => {
    expect(call({ method: "DELETE" }).code).toBe(405);
  });
});

describe("signed request format", () => {
  const rider = privateKeyToAccount(generatePrivateKey());
  const msg: ReqMessage = {
    rider: rider.address,
    action: ACTION.tapIn,
    op: 1,
    station: 2,
    amount: 0n,
    to: rider.address,
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
  };

  it("recovers the rider from the signature (what the server checks)", async () => {
    const signature = await rider.signTypedData({ domain: domainFor(10143, CONTRACT), types: REQ_TYPES, primaryType: "Req", message: msg });
    const who = await recoverTypedDataAddress({ domain: domainFor(10143, CONTRACT), types: REQ_TYPES, primaryType: "Req", message: msg, signature });
    expect(who).toBe(rider.address);
  });

  it("round-trips through the wire format and rejects malformed input", () => {
    const back = fromWire(JSON.parse(JSON.stringify(toWire(msg))));
    expect(back).toEqual({ ok: true, msg });
    const w = toWire(msg);
    for (const bad of [
      { ...w, rider: "0x123" },
      { ...w, action: 7 },
      { ...w, op: -1 },
      { ...w, amount: "-5" },
      { ...w, nonce: "1.5" },
      { ...w, deadline: undefined },
      null,
    ]) {
      expect(fromWire(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("hashes differently for different chains and contracts (replay protection)", () => {
    const h = (c: number, a: `0x${string}`) => hashTypedData({ domain: domainFor(c, a), types: REQ_TYPES, primaryType: "Req", message: msg });
    expect(h(10143, CONTRACT)).not.toBe(h(1, CONTRACT));
    expect(h(10143, CONTRACT)).not.toBe(h(10143, "0x0000000000000000000000000000000000000001"));
  });
});

describe("/api/relay input checks (nothing here reaches the network)", () => {
  const rider = privateKeyToAccount(generatePrivateKey());
  const base = (over: Partial<ReqMessage> = {}): ReqMessage => ({
    rider: rider.address,
    action: ACTION.tapIn,
    op: 1,
    station: 1,
    amount: 0n,
    to: rider.address,
    nonce: 0n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
    ...over,
  });
  const sign = (m: ReqMessage, who = rider) =>
    who.signTypedData({ domain: domainFor(10143, CONTRACT), types: REQ_TYPES, primaryType: "Req", message: m });
  const post = async (body: unknown, method = "POST") => {
    const { res, out } = fakeRes();
    await relay({ method, body, headers: {} }, res);
    return out;
  };

  it("only takes POST", async () => {
    expect((await post({}, "GET")).code).toBe(405);
  });

  it("rejects malformed bodies", async () => {
    expect((await post("{not json")).code).toBe(400);
    expect((await post({ req: {}, signature: "0x00" })).code).toBe(400);
    const m = base();
    expect((await post({ req: toWire(m), signature: "0x1234" })).body).toMatchObject({ error: "bad signature" });
  });

  it("rejects expired and far-future deadlines", async () => {
    const old = base({ deadline: BigInt(Math.floor(Date.now() / 1000) - 5) });
    expect((await post({ req: toWire(old), signature: await sign(old) })).body).toMatchObject({ error: "expired" });
    const far = base({ deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
    expect((await post({ req: toWire(far), signature: await sign(far) })).body).toMatchObject({ error: "deadline too far" });
  });

  it("rejects a signature from somebody else and a tampered request", async () => {
    const m = base();
    const other = privateKeyToAccount(generatePrivateKey());
    expect((await post({ req: toWire(m), signature: await sign(m, other) })).body).toMatchObject({ error: "bad signature" });
    const sig = await sign(m);
    const tampered = { ...toWire(m), station: 3 };
    expect((await post({ req: tampered, signature: sig })).body).toMatchObject({ error: "bad signature" });
  });
});

describe("server helpers", () => {
  it("limits requests per key inside the window", () => {
    const lim = helpers.limiter(1000);
    expect(lim.allow("a", 2, 0)).toBe(true);
    lim.record("a", 0);
    lim.record("a", 10);
    expect(lim.allow("a", 2, 20)).toBe(false);
    expect(lim.allow("b", 2, 20)).toBe(true);
    expect(lim.allow("a", 2, 5000)).toBe(true); // the window slid past both hits
  });

  it("extracts the revert reason from a viem error", () => {
    const e = { shortMessage: 'The contract function "relay" reverted with the following reason:\nbalance < max fare\n\nContract Call:' };
    expect(helpers.reason(e)).toBe("balance < max fare");
    expect(helpers.reason(new Error("HTTP request failed."))).toBe("HTTP request failed.");
  });

  it("reads the client IP from the forwarded header", () => {
    expect(helpers.clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } })).toBe("1.2.3.4");
    expect(helpers.clientIp({})).toBe("unknown");
  });
});
