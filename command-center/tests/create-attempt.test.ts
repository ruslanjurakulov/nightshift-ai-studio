/**
 * The create flow's idempotency key (lib/create-attempt.ts): one key per
 * attempt, the same key on a retry of the same inputs, a new one when the
 * inputs change or the attempt is settled.
 */
import { describe, expect, it } from "vitest";
import { createAttempt, newAttemptKey } from "@/lib/create-attempt";

// The alphabet and length /api/agent/run accepts (IDEMPOTENCY_KEY_RE).
const ROUTE_KEY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;

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
});

describe("createAttempt", () => {
  const counter = () => {
    let n = 0;
    return () => `k${++n}`;
  };

  it("the same inputs give the same key: a retry after an error or a lost answer cannot hold twice", () => {
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

  it("a settled attempt (started, or failed after a hold) starts the next one fresh, even with the same inputs", () => {
    const a = createAttempt(counter());
    expect(a.keyFor("brief A")).toBe("k1");
    a.settle();
    expect(a.keyFor("brief A")).toBe("k2");
  });
});
