import { beforeEach } from "vitest";

// A minimal in-memory localStorage so browser-side modules (wallet, mock chain, i18n) run under Node.
const store = new Map<string, string>();
const storage: Storage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

beforeEach(() => store.clear());
