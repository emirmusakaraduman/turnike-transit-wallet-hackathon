import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CITIES, TARIFFS, centsFromMon, centsOf, estimateFare, lira, maxFareMon, monFromCents, zoneOf } from "../src/lib/config";

describe("fares", () => {
  it("charges base + zones x per-zone, in lira cents", () => {
    expect(centsOf(1, 1, 3)).toBe(1000 + 3 * 500); // Kizilay -> Cayyolu
    expect(centsOf(1, 1, 2)).toBe(1500); // Kizilay -> Ulus
    expect(centsOf(2, 1, 3)).toBe(2000 + 4 * 1000); // Taksim -> Levent
  });

  it("charges only the base for the same station and is symmetric", () => {
    expect(centsOf(1, 2, 2)).toBe(TARIFFS[1].base);
    expect(centsOf(1, 1, 3)).toBe(centsOf(1, 3, 1));
  });

  it("skips the base fare for a transfer", () => {
    expect(centsOf(1, 1, 3, true)).toBe(3 * 500);
    expect(centsOf(1, 2, 2, true)).toBe(0);
  });

  it("never exceeds the operator maximum", () => {
    for (const c of CITIES) {
      for (const a of c.stations) {
        for (const b of c.stations) expect(centsOf(c.id, a.id, b.id)).toBeLessThanOrEqual(TARIFFS[c.id].max);
      }
    }
  });
});

describe("lira <-> MON", () => {
  it("converts at the default rate (1 cent = 0.00001 MON)", () => {
    expect(monFromCents(1000)).toBeCloseTo(0.01, 12);
    expect(monFromCents(2500)).toBeCloseTo(0.025, 12);
    expect(centsFromMon(0.025)).toBe(2500);
  });

  it("moves with the rate: the same ticket costs more MON when MON is worth less", () => {
    expect(monFromCents(1000, 20_000_000_000_000n)).toBeCloseTo(0.02, 12);
    expect(estimateFare(1, 1, 3, { rate: 20_000_000_000_000n })).toBeCloseTo(0.05, 12);
  });

  it("knows the highest fare a rider needs as balance", () => {
    expect(maxFareMon(1)).toBeCloseTo(0.05, 12);
    expect(maxFareMon(2)).toBeCloseTo(0.08, 12);
  });

  it("formats lira in both languages", () => {
    expect(lira(2500, "en")).toContain("25.00");
    expect(lira(2500, "tr")).toContain("25,00");
  });
});

describe("matches the deployed contract setup", () => {
  const deploy = readFileSync(new URL("../../script/Deploy.s.sol", import.meta.url), "utf8");

  it("has the same tariffs as script/Deploy.s.sol", () => {
    const regs = [...deploy.matchAll(/registerOperator\("(\w+)", me, (\d+), (\d+), (\d+), (\d+), (\d+)\)/g)];
    expect(regs).toHaveLength(Object.keys(TARIFFS).length);
    regs.forEach((m, i) => {
      const t = TARIFFS[i + 1];
      expect(CITIES[i].nameEn).toBe(m[1]);
      expect([t.base, t.per, t.max, t.cap, t.transferSec]).toEqual(m.slice(2).map(Number));
    });
  });

  it("has the same stations and zones as script/Deploy.s.sol", () => {
    const zones = [...deploy.matchAll(/addStation\((\w), (\d+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
    const mine = CITIES.flatMap((c) => c.stations.map((s) => [c.id === 1 ? "a" : "i", s.zone] as const));
    expect(zones).toEqual(mine);
    expect(zoneOf(1, 3)).toBe(3);
  });
});
