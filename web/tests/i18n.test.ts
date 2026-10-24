import { describe, expect, it } from "vitest";
import { dictionaries, translate } from "../src/lib/i18n";

const en = dictionaries.en as Record<string, string>;
const tr = dictionaries.tr as Record<string, string>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  it("define the same keys in English and Turkish", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it("never leave a string empty", () => {
    for (const lang of [en, tr]) for (const [k, v] of Object.entries(lang)) expect(v.trim().length, k).toBeGreaterThan(0);
  });

  it("use the same {placeholders} in both languages", () => {
    for (const k of Object.keys(en)) expect(placeholders(tr[k]), k).toEqual(placeholders(en[k]));
  });

  it("stay in sentence case (no ALL-CAPS strings except stamps and symbols)", () => {
    const allowed = new Set(["mon", "stampIn", "stampOut"]);
    for (const lang of [en, tr]) {
      for (const [k, v] of Object.entries(lang)) {
        if (allowed.has(k)) continue;
        const letters = v.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, "");
        if (letters.length > 3) expect(letters, k).not.toBe(letters.toUpperCase());
      }
    }
  });

  it("fills placeholders", () => {
    expect(translate("zone", { z: 3 }, "en")).toBe("Zone 3");
    expect(translate("zone", { z: 3 }, "tr")).toBe("Bölge 3");
    expect(translate("lowBalance", { x: "0.050", city: "Ankara" }, "en")).toContain("0.050");
  });
});
