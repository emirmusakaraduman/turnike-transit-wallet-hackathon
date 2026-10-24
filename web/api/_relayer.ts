// Shared server helpers for /api/relay and /api/topup (a file starting with "_" is not exposed as an endpoint).
import { createPublicClient, createWalletClient, defineChain, fallback, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Req = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};
export type Res = { status: (c: number) => Res; json: (b: unknown) => void };

export const ADDRESS = (process.env.VITE_TURNIKE_ADDRESS ?? "").trim() as Address;

const urls = [
  ...new Set([
    process.env.VITE_RPC_URL?.trim() || "https://rpc-testnet.monadinfra.com",
    "https://rpc-testnet.monadinfra.com",
    "https://testnet-rpc.monad.xyz",
  ]),
];
export const transport = fallback(urls.map((u) => http(u, { timeout: 8_000 })), { retryCount: 1, shouldThrow: () => false });
export const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [urls[0]] } },
});
export const pub = createPublicClient({ chain, transport });

/** The sponsor wallet that pays gas and funds demo top-ups. */
export function sponsor() {
  const key = (process.env.RELAYER_PRIVATE_KEY || process.env.FAUCET_PRIVATE_KEY)?.trim() as Hex | undefined;
  if (!key) return null;
  const account = privateKeyToAccount(key);
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

export const clientIp = (req: Req) => {
  const fwd = req.headers?.["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || "unknown";
};

/** Sliding-window counters kept per warm serverless instance: a best-effort guard, not a hard guarantee. */
export function limiter(windowMs: number) {
  const hits = new Map<string, number[]>();
  const fresh = (k: string, now: number) => (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  return {
    allow: (k: string, max: number, now = Date.now()) => fresh(k, now).length < max,
    record: (k: string, now = Date.now()) => hits.set(k, [...fresh(k, now), now]),
  };
}

// Sponsored transactions come from ONE wallet, so they are sent strictly in nonce order. Sending is fast (receipts are
// awaited by the caller, outside the queue), but this wallet is a throughput ceiling; a pool of relayers removes it.
let queue: Promise<unknown> = Promise.resolve();
let nextNonce: number | null = null;
let nextNonceAt = 0;

export function sendOrdered(address: Address, send: (nonce: number) => Promise<Hex>): Promise<Hex> {
  const job = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      // a warm instance that sent a moment ago already knows the next nonce; otherwise ask the chain
      const known = nextNonce !== null && Date.now() - nextNonceAt < 20_000;
      const nonce = known ? nextNonce! : Math.max(await pub.getTransactionCount({ address, blockTag: "pending" }), nextNonce ?? 0);
      try {
        const hash = await send(nonce);
        nextNonce = nonce + 1;
        nextNonceAt = Date.now();
        return hash;
      } catch (e) {
        nextNonce = null;
        if (attempt >= 3 || !/nonce|already known|replacement/i.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

/** The revert reason out of a viem error, e.g. "balance < max fare". */
export function reason(e: unknown): string {
  const m = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  const r = m.match(/reverted with the following reason:\s*([^\n]+)/i) ?? m.match(/reason:\s*([^\n]+)/i);
  return (r?.[1] ?? m.split("\n")[0]).trim().slice(0, 120);
}
