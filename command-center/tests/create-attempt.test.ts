/**
 * The idempotency key of a make-a-video intent (lib/create-attempt.ts): one key
 * per intent, the same key on a retry of the same inputs, a new one when the
 * inputs change or the attempt is settled, nothing shared between channels.
 */
import { describe, expect, it } from "vitest";
import { MAX_AGE_MS, createAttempt, newAttemptKey, type AttemptStore } from "@/lib/create-attempt";

// The alphabet and length /api/agent/run accepts (IDEMPOTENCY_KEY_RE).
const ROUTE_KEY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;

const counter = () => {
  let n = 0;
  return () => `k${++n}`;
};
const memoryStore = (): AttemptStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe("newAttemptKey", () => {
  it("is a key the run route accepts, and never the same twice", () => {
    const keys = new Set(Array.from({ length: 50 }, newAttemptKey));
    expect(keys.size).toBe(50);
    for (const k of keys) expect(k).toMatch(ROUTE_KEY_RE);
  });

  it("still makes one where crypto.randomUUID does not exist (an insecure origin)", () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true });
    try {
      expect(newAttemptKey()).toMatch(ROUTE_KEY_RE);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });

  it("falls back to Math.random where there is no crypto at all", () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(newAttemptKey()).toMatch(ROUTE_KEY_RE);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
});

describe("createAttempt", () => {
  it("the same inputs give the same key: a double click, a retry or a lost answer cannot hold twice", () => {
    const a = createAttempt(counter());
    expect(a.keyFor("brief A")).toBe("k1");
    expect(a.keyFor("brief A")).toBe("k1");
    expect(a.keyFor("brief A")).toBe("k1");
  });

  it("changed inputs are a different video: a new key, because the hold reference does not look at the body", () => {
    const a = createAttempt(counter());
    expect(a.keyFor("brief A")).toBe("k1");
    expect(a.keyFor("brief B")).toBe("k2");
    expect(a.keyFor("brief B")).toBe("k2");
  });

  it("a settled attempt (started, replayed, or failed after a hold) starts the next one fresh, even with the same inputs", () => {
    const a = createAttempt(counter());
    expect(a.keyFor("brief A")).toBe("k1");
    a.settle();
    expect(a.keyFor("brief A")).toBe("k2");
  });

  it("a key older than the limit is dropped: the server remembers the reference long after the hold is gone", () => {
    let now = 1_000;
    const a = createAttempt(counter(), { now: () => now });
    expect(a.keyFor("brief A")).toBe("k1");
    now += MAX_AGE_MS;
    expect(a.keyFor("brief A")).toBe("k1");
    now += 1;
    expect(a.keyFor("brief A")).toBe("k2");
  });
});

describe("createAttempt with a store (a reload of the tab)", () => {
  it("a new page load after an error finds the same pending key for the same inputs", () => {
    const store = memoryStore();
    const first = createAttempt(counter(), { store, storeKey: "ns.create-attempt.chan-a" });
    expect(first.keyFor("brief A")).toBe("k1");
    const afterReload = createAttempt(counter(), { store, storeKey: "ns.create-attempt.chan-a" });
    expect(afterReload.keyFor("brief A")).toBe("k1");
  });

  it("changed inputs after a reload are a new video, and settling clears the store", () => {
    const store = memoryStore();
    const key = "ns.create-attempt.chan-a";
    createAttempt(counter(), { store, storeKey: key }).keyFor("brief A");
    const b = createAttempt(counter(), { store, storeKey: key });
    expect(b.keyFor("brief B")).toBe("k1");
    b.settle();
    expect(store.data.has(key)).toBe(false);
    expect(createAttempt(counter(), { store, storeKey: key }).keyFor("brief B")).toBe("k1");
  });

  it("another channel's store key never hands out this channel's key", () => {
    const store = memoryStore();
    const a = createAttempt(() => "key-a", { store, storeKey: "ns.create-attempt.chan-a" });
    const b = createAttempt(() => "key-b", { store, storeKey: "ns.create-attempt.chan-b" });
    expect(a.keyFor("same inputs")).toBe("key-a");
    expect(b.keyFor("same inputs")).toBe("key-b");
  });

  it("a stale stored key is not reused after the limit", () => {
    const store = memoryStore();
    let now = 5_000;
    createAttempt(counter(), { store, storeKey: "s", now: () => now }).keyFor("brief A");
    now += MAX_AGE_MS + 1;
    expect(createAttempt(counter(), { store, storeKey: "s", now: () => now }).keyFor("brief A")).toBe("k1");
    // k1 above is the NEW counter's first key: the stored one (also "k1") was dropped, so the store holds the new time.
    expect(JSON.parse(store.data.get("s") ?? "{}").at).toBe(now);
  });

  it("a store that throws or holds garbage only costs the reload: the in-page key still works", () => {
    const broken: AttemptStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const a = createAttempt(counter(), { store: broken });
    expect(a.keyFor("brief A")).toBe("k1");
    expect(a.keyFor("brief A")).toBe("k1");
    a.settle();
    expect(a.keyFor("brief A")).toBe("k2");

    const garbage = memoryStore();
    garbage.setItem("ns.create-attempt", "{not json");
    expect(createAttempt(counter(), { store: garbage }).keyFor("brief A")).toBe("k1");
    garbage.setItem("ns.create-attempt", JSON.stringify({ key: 5, sig: "brief A", at: 1 }));
    expect(createAttempt(counter(), { store: garbage }).keyFor("brief A")).toBe("k1");
  });
});
