// @vitest-environment jsdom
/**
 * The idempotency key of a make-a-video intent (lib/create-attempt.ts): one key
 * per intent, the same key on a retry of the same inputs, a new one when the
 * inputs change or the attempt is settled, an unanswered attempt remembered as
 * unsure, and nothing stored anywhere.
 */
import { describe, expect, it } from "vitest";
import { MAX_AGE_MS, createAttempt, newAttemptKey } from "@/lib/create-attempt";

// The alphabet and length /api/agent/run accepts (IDEMPOTENCY_KEY_RE).
const ROUTE_KEY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;

const counter = () => {
  let n = 0;
  return () => `k${++n}`;
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

describe("an attempt that ended without a usable answer", () => {
  it("is remembered as unsure under its key, and forgotten when the key changes or the attempt settles", () => {
    const a = createAttempt(counter());
    a.keyFor("brief A");
    expect(a.isUnsure()).toBe(false);
    a.markUnsure();
    expect(a.isUnsure()).toBe(true);
    // The same intent keeps the flag with its key (the price moving does not change the signature).
    a.keyFor("brief A");
    expect(a.isUnsure()).toBe(true);
    a.keyFor("brief B");
    expect(a.isUnsure()).toBe(false);
    a.markUnsure();
    a.settle();
    expect(a.isUnsure()).toBe(false);
    a.markUnsure();
    expect(a.isUnsure()).toBe(false);
  });
});

describe("nothing is stored", () => {
  it("a key is never written to web storage, so another account or another tab cannot find it", () => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    const a = createAttempt(counter());
    a.keyFor("brief A");
    a.markUnsure();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });

  it("each attempt object is its own: one channel's form never hands out another's key", () => {
    const a = createAttempt(() => "key-a");
    const b = createAttempt(() => "key-b");
    expect(a.keyFor("same inputs")).toBe("key-a");
    expect(b.keyFor("same inputs")).toBe("key-b");
  });
});
