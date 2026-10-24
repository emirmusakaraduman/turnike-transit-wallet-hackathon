// EIP-712 request a rider signs so a relayer can pay the gas. Used by BOTH the browser and the API, and it must
// match `Turnike.REQ_TYPEHASH` / `domainSeparator()` in src/Turnike.sol (checked on-chain via `hashReq`).
export const REQ_TYPES = {
  Req: [
    { name: "rider", type: "address" },
    { name: "action", type: "uint8" },
    { name: "op", type: "uint32" },
    { name: "station", type: "uint32" },
    { name: "amount", type: "uint256" },
    { name: "to", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ACTION = { tapIn: 0, tapOut: 1, withdraw: 2 } as const;

export type ReqMessage = {
  rider: `0x${string}`;
  action: number;
  op: number;
  station: number;
  amount: bigint;
  to: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
};

export const domainFor = (chainId: number, verifyingContract: `0x${string}`) =>
  ({ name: "Turnike", version: "1", chainId, verifyingContract }) as const;

/** JSON-safe form (bigints as strings) used on the wire between the browser and /api/relay. */
export type WireReq = Record<keyof ReqMessage, string | number>;

export const toWire = (m: ReqMessage): WireReq => ({
  rider: m.rider,
  action: m.action,
  op: m.op,
  station: m.station,
  amount: m.amount.toString(),
  to: m.to,
  nonce: m.nonce.toString(),
  deadline: m.deadline.toString(),
});

const UINT = /^\d{1,40}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Validates untrusted JSON from the network and returns a typed message, or a reason it was rejected. */
export function fromWire(w: unknown): { ok: true; msg: ReqMessage } | { ok: false; error: string } {
  const o = (w ?? {}) as Record<string, unknown>;
  if (typeof o.rider !== "string" || !ADDR.test(o.rider)) return { ok: false, error: "bad rider" };
  if (typeof o.to !== "string" || !ADDR.test(o.to)) return { ok: false, error: "bad destination" };
  const action = Number(o.action);
  if (![0, 1, 2].includes(action)) return { ok: false, error: "bad action" };
  const op = Number(o.op);
  const station = Number(o.station);
  if (!Number.isInteger(op) || op < 0 || op > 0xffffffff) return { ok: false, error: "bad operator" };
  if (!Number.isInteger(station) || station < 0 || station > 0xffffffff) return { ok: false, error: "bad station" };
  for (const k of ["amount", "nonce", "deadline"] as const) {
    if (typeof o[k] !== "string" || !UINT.test(o[k] as string)) return { ok: false, error: `bad ${k}` };
  }
  return {
    ok: true,
    msg: {
      rider: o.rider as `0x${string}`,
      action,
      op,
      station,
      amount: BigInt(o.amount as string),
      to: o.to as `0x${string}`,
      nonce: BigInt(o.nonce as string),
      deadline: BigInt(o.deadline as string),
    },
  };
}
