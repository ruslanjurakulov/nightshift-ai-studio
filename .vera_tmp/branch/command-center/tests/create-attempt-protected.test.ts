// @vitest-environment jsdom
/**
 * Unsure and blocked intents are PROTECTED (lib/create-attempt.ts): kept for the hold's life (3 h, not the
 * 30 minutes of an ordinary key), never pushed out by newer intents, pruning or a cap. Ordinary entries are the
 * only ones capped and evicted. When the protected ones fill the scope, a NEW intent is refused (fail-closed: no
 * key, no request) while every earlier protected intent stays replayable with its own key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttemptsFullError,
  HOLD_MAX_AGE_MS,
  MAX_AGE_MS,
  MAX_ENTRIES_PER_SCOPE,
  MAX_PROTECTED_PER_SCOPE,
  createAttempt,
  type AttemptScope,
} from "@/lib/create-attempt";
import { ATTEMPT_PREFIX, clearAllCreateAttempts } from "@/lib/create-attempt-store";

const counter = (prefix = "k") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const scope = (over: Partial<AttemptScope> = {}): AttemptScope => ({ userId: USER, orgId: "org-7f3a", channelId: "chan-a", ...over });
const sig = (topic: string) => JSON.stringify({ channel_id: "chan-a", topic });
const names = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string).filter((k) => k.startsWith(ATTEMPT_PREFIX));
const MIN = 60 * 1000;

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearAllCreateAttempts();
});

describe("an unsure intent lives as long as the hold can, not 30 minutes", () => {
  it("31 minutes later the same key is still sent and it is still unsure; past 3 hours it is a new key", () => {
    let now = 10_000_000;
    const a = createAttempt(counter("a"), { now: () => now });
    const key = a.keyFor(sig("A"), scope());
    now += 2 * MIN;
    a.markUnsure(key);
    const markedAt = now;
    now = markedAt + 31 * MIN;
    expect(a.status(sig("A"), scope()).unsure).toBe(true);
    expect(a.keyFor(sig("A"), scope())).toBe(key);
    // After a reload too.
    const reload = createAttempt(counter("b"), { now: () => now });
    expect(reload.status(sig("A"), scope()).unsure).toBe(true);
    expect(reload.keyFor(sig("A"), scope())).toBe(key);
    expect(reload.isUnsure()).toBe(true);
    now = markedAt + HOLD_MAX_AGE_MS - 1000;
    expect(createAttempt(counter("c"), { now: () => now }).keyFor(sig("A"), scope())).toBe(key);
    now = markedAt + HOLD_MAX_AGE_MS + MIN;
    expect(createAttempt(counter("d"), { now: () => now }).keyFor(sig("A"), scope())).toBe("d1");
  });

  it("the hold's three hours run from when it became unsure, not from when the key was made", () => {
    let now = 10_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const key = a.keyFor(sig("A"), scope());
    now += 25 * MIN;
    a.markUnsure(key);
    now += HOLD_MAX_AGE_MS - MIN;
    expect(a.keyFor(sig("A"), scope())).toBe(key);
  });

  it("memory only (no scope) behaves the same", () => {
    let now = 10_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const key = a.keyFor(sig("A"));
    a.markUnsure(key);
    now += 31 * MIN;
    expect(a.keyFor(sig("A"))).toBe(key);
    now += HOLD_MAX_AGE_MS;
    expect(a.keyFor(sig("A"))).not.toBe(key);
  });

  it("an ordinary key still lasts 30 minutes", () => {
    let now = 10_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const key = a.keyFor(sig("A"), scope());
    now += MAX_AGE_MS + 1000;
    expect(a.keyFor(sig("A"), scope())).not.toBe(key);
  });
});

describe("newer intents never push a protected one out", () => {
  for (const [label, mark] of [
    ["blocked", (a: ReturnType<typeof createAttempt>, k: string) => a.markBlocked(12, k)],
    ["unsure", (a: ReturnType<typeof createAttempt>, k: string) => a.markUnsure(k)],
  ] as const) {
    it(`${label} A + ${MAX_ENTRIES_PER_SCOPE + 4} other ordinary intents: A keeps its key and its state, in storage, after a reload, and in memory`, () => {
      let now = 10_000_000;
      const a = createAttempt(counter("a"), { now: () => now });
      const key = a.keyFor(sig("A"), scope());
      mark(a, key);
      for (let i = 0; i < MAX_ENTRIES_PER_SCOPE + 4; i++) {
        now += 1000;
        a.keyFor(sig(`other ${i}`), scope());
      }
      const state = (x: ReturnType<typeof createAttempt>) => x.status(sig("A"), scope());
      expect(state(a)).toMatchObject(label === "blocked" ? { blocked: 12 } : { unsure: true });
      expect(a.keyFor(sig("A"), scope())).toBe(key);
      const reload = createAttempt(counter("b"), { now: () => now });
      expect(state(reload)).toMatchObject(label === "blocked" ? { blocked: 12 } : { unsure: true });
      expect(reload.keyFor(sig("A"), scope())).toBe(key);
      // Only the ordinary ones were capped.
      expect(names()).toHaveLength(MAX_ENTRIES_PER_SCOPE + 1);
      // Memory only.
      const m = createAttempt(counter("m"), { now: () => now });
      const mk = m.keyFor(sig("A"));
      mark(m, mk);
      for (let i = 0; i < MAX_ENTRIES_PER_SCOPE + 4; i++) m.keyFor(sig(`other ${i}`));
      expect(m.keyFor(sig("A"))).toBe(mk);
    });
  }

  it("ordinary intents are still evicted (the newest 8 stay), and pruning an expired ordinary one leaves a live protected one", () => {
    let now = 10_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const held = a.keyFor(sig("held"), scope());
    a.markBlocked(12, held);
    for (let i = 0; i < MAX_ENTRIES_PER_SCOPE + 5; i++) {
      now += 1000;
      a.keyFor(sig(`o${i}`), scope());
    }
    expect(names()).toHaveLength(MAX_ENTRIES_PER_SCOPE + 1);
    now += 2 * 60 * MIN; // two hours: every ordinary key is long expired, the hold is not
    a.keyFor(sig("fresh"), scope());
    expect(names()).toHaveLength(2);
    expect(a.status(sig("held"), scope()).blocked).toBe(12);
  });
});

describe("fail-closed when the scope is full of protected intents", () => {
  function fill(a: ReturnType<typeof createAttempt>, sc: AttemptScope | undefined, n = MAX_PROTECTED_PER_SCOPE) {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const k = a.keyFor(sig(`held ${i}`), sc);
      if (i % 2) a.markBlocked(5, k);
      else a.markUnsure(k);
      keys.push(k);
    }
    return keys;
  }

  it("the 33rd new intent gets no key and nothing is evicted: all 32 stay stored and replayable, also after a reload", () => {
    const a = createAttempt(counter("a"));
    const keys = fill(a, scope());
    expect(names()).toHaveLength(MAX_PROTECTED_PER_SCOPE);
    expect(a.status(sig("one more"), scope()).full).toBe(true);
    expect(() => a.keyFor(sig("one more"), scope())).toThrow(AttemptsFullError);
    expect(names()).toHaveLength(MAX_PROTECTED_PER_SCOPE);
    for (const [i, k] of keys.entries()) {
      expect(a.keyFor(sig(`held ${i}`), scope()), String(i)).toBe(k);
      expect(a.status(sig(`held ${i}`), scope()).full).toBe(false);
    }
    const reload = createAttempt(counter("b"));
    expect(reload.status(sig("one more"), scope()).full).toBe(true);
    expect(() => reload.keyFor(sig("one more"), scope())).toThrow(AttemptsFullError);
    for (const [i, k] of keys.entries()) expect(reload.keyFor(sig(`held ${i}`), scope()), String(i)).toBe(k);
    expect(reload.status(sig("held 1"), scope()).blocked).toBe(5);
    expect(reload.status(sig("held 0"), scope()).unsure).toBe(true);
  });

  it("another user, organization or channel is not affected by a full scope", () => {
    const a = createAttempt(counter());
    fill(a, scope());
    for (const other of [scope({ userId: "second-user" }), scope({ orgId: "org-2" }), scope({ channelId: "chan-b" })]) {
      expect(a.status(sig("x"), other).full, JSON.stringify(other)).toBe(false);
      expect(() => createAttempt(counter("o")).keyFor(sig("x"), other)).not.toThrow();
    }
  });

  it("memory only (no scope) and storage denied fail closed the same way", () => {
    const m = createAttempt(counter());
    const keys = fill(m, undefined);
    expect(() => m.keyFor(sig("one more"))).toThrow(AttemptsFullError);
    expect(m.status(sig("one more")).full).toBe(true);
    for (const [i, k] of keys.entries()) expect(m.keyFor(sig(`held ${i}`))).toBe(k);
    for (const fn of ["getItem", "setItem", "removeItem", "key"] as const)
      vi.spyOn(Storage.prototype, fn).mockImplementation(() => {
        throw new Error("denied");
      });
    const d = createAttempt(counter());
    const dk = fill(d, scope());
    expect(() => d.keyFor(sig("one more"), scope())).toThrow(AttemptsFullError);
    expect(d.status(sig("one more"), scope()).full).toBe(true);
    for (const [i, k] of dk.entries()) expect(d.keyFor(sig(`held ${i}`), scope())).toBe(k);
  });

  it("a slot frees when a protected entry expires (past three hours), and when one is settled", () => {
    let now = 10_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const keys = fill(a, scope());
    expect(a.status(sig("x"), scope()).full).toBe(true);
    a.settle(keys[5]);
    expect(a.status(sig("x"), scope()).full).toBe(false);
    expect(() => a.keyFor(sig("x"), scope())).not.toThrow();
    a.markUnsure(a.keyFor(sig("x"), scope())); // full again
    expect(a.status(sig("y"), scope()).full).toBe(true);
    now += HOLD_MAX_AGE_MS + MIN;
    expect(createAttempt(counter("n"), { now: () => now }).status(sig("y"), scope()).full).toBe(false);
    expect(a.status(sig("y"), scope()).full).toBe(false);
    expect(() => createAttempt(counter("n"), { now: () => now }).keyFor(sig("y"), scope())).not.toThrow();
  });

  it("ordinary entries do not count toward the limit", () => {
    const a = createAttempt(counter());
    fill(a, scope(), MAX_PROTECTED_PER_SCOPE - 1);
    for (let i = 0; i < 5; i++) a.keyFor(sig(`ordinary ${i}`), scope());
    expect(a.status(sig("one more"), scope()).full).toBe(false);
    expect(() => a.keyFor(sig("one more"), scope())).not.toThrow();
  });

  it("sign-out clears every one of them", () => {
    const a = createAttempt(counter());
    fill(a, scope());
    clearAllCreateAttempts();
    expect(names()).toHaveLength(0);
  });
});
