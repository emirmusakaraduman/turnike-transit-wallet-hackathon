import { describe, expect, it } from "vitest";
import { MOCK, mockDeposit, mockRead, mockTap, mockWithdraw } from "../src/lib/mock";

const A = "0x00000000000000000000000000000000000000a1";

describe("demo chain", () => {
  it("is active when no contract address is configured", () => {
    expect(MOCK).toBe(true);
  });

  it("charges the distance fare on tap out and keeps history", async () => {
    mockDeposit(A, 0.1);
    expect((await mockTap(A, 1, 1)).kind).toBe("tapIn");
    const out = await mockTap(A, 1, 3); // Kizilay -> Cayyolu
    expect(out.kind).toBe("tapOut");
    expect(out.fare).toBeCloseTo(0.025, 10);
    const s = mockRead(A);
    expect(s.deposit).toBeCloseTo(0.075, 10);
    expect(s.open).toBe(false);
    expect(s.hist[0]).toMatchObject({ kind: "trip", op: 1, from: 1, to: 3 });
  });

  it("refuses a trip when the balance is below the operator maximum", async () => {
    mockDeposit(A, 0.04); // Ankara needs 0.05
    await expect(mockTap(A, 1, 1)).rejects.toThrow("balance < max fare");
    expect(mockRead(A).open).toBe(false);
  });

  it("charges the maximum fare as a penalty when a new trip starts over an open one", async () => {
    mockDeposit(A, 0.2);
    await mockTap(A, 1, 1);
    const r = await mockTap(A, 2, 1, true); // forgot to tap out in Ankara, tap in at Istanbul
    expect(r.kind).toBe("penalty");
    expect(r.fare).toBeCloseTo(0.05, 10);
    const s = mockRead(A);
    expect(s.deposit).toBeCloseTo(0.15, 10);
    expect(s.trip?.op).toBe(2);
    expect(s.hist[0].kind).toBe("penalty");
  });

  it("will not tap out in another operator's network", async () => {
    mockDeposit(A, 0.2);
    await mockTap(A, 1, 1);
    await expect(mockTap(A, 2, 2)).rejects.toThrow("other operator");
  });

  it("skips the base fare when tapping in again at the same operator within the transfer window", async () => {
    mockDeposit(A, 0.3);
    await mockTap(A, 1, 1);
    const first = await mockTap(A, 1, 2); // 10.00 + 5.00
    expect(first.fare).toBeCloseTo(0.015, 10);
    await mockTap(A, 1, 1);
    const second = await mockTap(A, 1, 2); // transfer: 5.00 only
    expect(second.fare).toBeCloseTo(0.005, 10);
    expect(mockRead(A).last?.op).toBe(1);
  });

  it("does not give a transfer discount at a different operator", async () => {
    mockDeposit(A, 0.3);
    await mockTap(A, 1, 1);
    await mockTap(A, 1, 2);
    await mockTap(A, 2, 1);
    const out = await mockTap(A, 2, 2); // Istanbul: 20.00 + 2 x 10.00
    expect(out.fare).toBeCloseTo(0.04, 10);
  });

  it("only lets a rider withdraw when no trip is open", async () => {
    mockDeposit(A, 0.2);
    await mockTap(A, 1, 1);
    expect(() => mockWithdraw(A)).toThrow("trip open");
    await mockTap(A, 1, 2);
    mockWithdraw(A);
    expect(mockRead(A).deposit).toBe(0);
  });
});
