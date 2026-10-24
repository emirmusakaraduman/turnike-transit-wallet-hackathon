import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { getBackup, importBackup, loadPk, parseBackup } from "../src/lib/wallet";

// the well-known Hardhat/Anvil test phrase and its first account
const PHRASE = "test test test test test test test test test test test junk";
const PHRASE_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("wallet recovery", () => {
  it("creates a 12-word wallet once and then keeps it", () => {
    const a = loadPk();
    const b = loadPk();
    expect(a).toBe(b);
    const backup = getBackup();
    expect(backup.kind).toBe("phrase");
    expect(backup.value.split(" ")).toHaveLength(12);
  });

  it("restores the same account from the phrase", () => {
    expect(importBackup(PHRASE)).toBe(true);
    expect(privateKeyToAccount(loadPk()).address).toBe(PHRASE_ADDRESS);
    expect(getBackup()).toEqual({ kind: "phrase", value: PHRASE });
  });

  it("is forgiving about spacing and case in a pasted phrase", () => {
    expect(importBackup(`  ${PHRASE.toUpperCase().replace(/ /g, "\n ")}  `)).toBe(true);
    expect(privateKeyToAccount(loadPk()).address).toBe(PHRASE_ADDRESS);
  });

  it("restores from a raw private key (older wallets)", () => {
    expect(importBackup(KEY)).toBe(true);
    expect(loadPk()).toBe(KEY);
    expect(getBackup()).toEqual({ kind: "key", value: KEY });
  });

  it("keeps working with an older wallet that was stored as a bare key", () => {
    localStorage.setItem("turnike.pk", KEY);
    expect(loadPk()).toBe(KEY);
  });

  it("rejects text that is not a phrase or key and leaves the wallet untouched", () => {
    const before = loadPk();
    for (const bad of ["", "hello world", "test test test", `${PHRASE} extra`, PHRASE.replace("junk", "zzzz"), "0x1234", KEY.slice(0, 40)]) {
      expect(parseBackup(bad), bad).toBeNull();
      expect(importBackup(bad), bad).toBe(false);
    }
    expect(loadPk()).toBe(before);
  });

  it("replaces a phrase wallet with a key wallet and back without leaving both behind", () => {
    importBackup(PHRASE);
    importBackup(KEY);
    expect(localStorage.getItem("turnike.mnemonic")).toBeNull();
    importBackup(PHRASE);
    expect(localStorage.getItem("turnike.pk")).toBeNull();
  });
});
