import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOW_MS, mintToken, verifyToken } from "../src/lib/qr";

afterEach(() => vi.useRealTimers());

describe("rotating QR token (demo mode)", () => {
  it("accepts a fresh token and rejects the wrong station", async () => {
    const tk = await mintToken(1, 2);
    expect(tk).not.toBeNull();
    expect(await verifyToken(1, 2, tk!.t)).toEqual({ ok: true });
    expect((await verifyToken(1, 3, tk!.t)).ok).toBe(false);
    expect((await verifyToken(2, 2, tk!.t)).ok).toBe(false);
  });

  it("lets a code live for its window and the next one, then expires it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:05Z"));
    const tk = (await mintToken(1, 1))!;
    vi.setSystemTime(Date.now() + WINDOW_MS); // next window: still accepted
    expect((await verifyToken(1, 1, tk.t)).ok).toBe(true);
    vi.setSystemTime(Date.now() + 2 * WINDOW_MS); // two windows later: gone
    const late = await verifyToken(1, 1, tk.t);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe("expired");
  });

  it("lets a link without a token through (static QR) unless enforcement is on", async () => {
    expect((await verifyToken(1, 1, null)).ok).toBe(true);
  });
});
