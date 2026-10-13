// @vitest-environment jsdom
/**
 * One entry per INTENT (lib/create-attempt.ts): what is known about topic A (its key, unsure, blocked)
 * is not lost when the person sends topic B and types A back. Entries touch only their own intent, are
 * pruned when expired and capped per user/org/channel, are cleared together on sign-out, are validated
 * on read, and are isolated per user, organization and channel. Hash only: no topic text anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AGE_MS, BLOCKED_MAX_AGE_MS, MAX_ENTRIES_PER_SCOPE, createAttempt, type AttemptScope } from "@/lib/create-attempt";
import { ATTEMPT_PREFIX, clearAllCreateAttempts } from "@/lib/create-attempt-store";

const counter = (prefix = "k") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const scope = (over: Partial<AttemptScope> = {}): AttemptScope => ({ userId: USER, orgId: "org-7f3a", channelId: "chan-a", ...over });
const sig = (topic: string, over: Record<string, unknown> = {}) => JSON.stringify({ channel_id: "chan-a", topic, duration: 300, ...over });
const names = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string).filter((k) => k.startsWith(ATTEMPT_PREFIX));
const dump = () => JSON.stringify(Object.fromEntries(Array.from({ length: window.sessionStorage.length }, (_, i) => { const k = window.sessionStorage.key(i) as string; return [k, window.sessionStorage.getItem(k)]; })));

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("unrelated", "keep me");
});
afterEach(() => {
  vi.restoreAllMocks();
  clearAllCreateAttempts();
});

describe("blocked survives sending another intent", () => {
  it("block A -> send B (any answer) -> A is still blocked and keeps its key", () => {
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"), scope());
    a.markBlocked(12, keyA);
    const keyB = a.keyFor(sig("B"), scope());
    expect(keyB).not.toBe(keyA);
    a.settle(keyB); // B started
    expect(a.status(sig("A"), scope())).toEqual({ unsure: false, blocked: 12 });
    expect(a.keyFor(sig("A"), scope())).toBe(keyA);
    expect(a.status(sig("B"), scope()).blocked).toBeNull();
  });

  it("the same after a reload (a new attempt over the same storage), and when B was sent from the reloaded page", () => {
    const first = createAttempt(counter("a"));
    const keyA = first.keyFor(sig("A"), scope());
    first.markBlocked(12, keyA);
    const second = createAttempt(counter("b"));
    const keyB = second.keyFor(sig("B"), scope());
    second.markUnsure(keyB);
    second.settle(keyB);
    const third = createAttempt(counter("c"));
    expect(third.status(sig("A"), scope())).toEqual({ unsure: false, blocked: 12 });
    expect(third.keyFor(sig("A"), scope())).toBe(keyA);
  });

  it("memory only (no scope) remembers each intent too", () => {
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"));
    a.markBlocked(12, keyA);
    a.settle(a.keyFor(sig("B")));
    expect(a.status(sig("A")).blocked).toBe(12);
    expect(a.keyFor(sig("A"))).toBe(keyA);
  });
});

describe("unsure survives sending another intent", () => {
  it("keyFor(A); markUnsure; keyFor(B); settle; keyFor(A) is the same key, still unsure", () => {
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"), scope());
    a.markUnsure(keyA);
    const keyB = a.keyFor(sig("B"), scope());
    a.settle(keyB);
    expect(a.keyFor(sig("A"), scope())).toBe(keyA);
    expect(a.isUnsure()).toBe(true);
    expect(a.status(sig("A"), scope()).unsure).toBe(true);
  });

  it("also after a reload, and in memory", () => {
    const first = createAttempt(counter("a"));
    const keyA = first.keyFor(sig("A"), scope());
    first.markUnsure(keyA);
    const mid = createAttempt(counter("b"));
    mid.settle(mid.keyFor(sig("B"), scope()));
    const after = createAttempt(counter("c"));
    expect(after.keyFor(sig("A"), scope())).toBe(keyA);
    expect(after.isUnsure()).toBe(true);
    const mem = createAttempt(counter());
    const k = mem.keyFor(sig("A"));
    mem.markUnsure(k);
    mem.settle(mem.keyFor(sig("B")));
    expect(mem.keyFor(sig("A"))).toBe(k);
    expect(mem.isUnsure()).toBe(true);
  });
});

describe("each intent touches only its own entry", () => {
  it("settle, markUnsure and markBlocked by key change one entry and leave the others as they were", () => {
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"), scope());
    const keyB = a.keyFor(sig("B"), scope());
    const keyC = a.keyFor(sig("C"), scope());
    expect(names()).toHaveLength(3);
    const before = Object.fromEntries(names().map((n) => [n, window.sessionStorage.getItem(n)]));
    a.markBlocked(5, keyB);
    a.settle(keyC);
    expect(names()).toHaveLength(2);
    // A's entry is byte for byte what it was.
    expect(names().filter((n) => window.sessionStorage.getItem(n) === before[n])).toHaveLength(1);
    expect(a.status(sig("A"), scope())).toEqual({ unsure: false, blocked: null });
    expect(a.status(sig("B"), scope())).toEqual({ unsure: false, blocked: 5 });
    expect(a.status(sig("C"), scope())).toEqual({ unsure: false, blocked: null });
    expect(a.keyFor(sig("A"), scope())).toBe(keyA);
    expect(a.keyFor(sig("C"), scope())).not.toBe(keyC);
  });

  it("stores no topic text: the names and entries are hashes", () => {
    const a = createAttempt(counter());
    a.markBlocked(12, a.keyFor(sig("Secret Khiva documentary"), scope()));
    a.markUnsure(a.keyFor(sig("Another secret"), scope()));
    const all = dump();
    for (const secret of ["Khiva", "Secret", "secret", USER, "org-7f3a", "chan-a", "topic"]) expect(all).not.toContain(secret);
    for (const n of names()) expect(n.slice(ATTEMPT_PREFIX.length)).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
  });
});

describe("storage cannot grow", () => {
  it("keeps the newest MAX_ENTRIES_PER_SCOPE intents per scope and drops the oldest", () => {
    let now = 1_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const keys: string[] = [];
    for (let i = 0; i < MAX_ENTRIES_PER_SCOPE + 4; i++) {
      keys.push(a.keyFor(sig(`topic ${i}`), scope()));
      now += 1000;
    }
    expect(names()).toHaveLength(MAX_ENTRIES_PER_SCOPE);
    // The newest are there, the oldest are gone (a new attempt over the same storage sees it).
    const fresh = createAttempt(counter("n"), { now: () => now });
    expect(fresh.keyFor(sig(`topic ${MAX_ENTRIES_PER_SCOPE + 3}`), scope())).toBe(keys[MAX_ENTRIES_PER_SCOPE + 3]);
    expect(fresh.keyFor(sig("topic 0"), scope())).not.toBe(keys[0]);
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep me");
  });

  it("another scope's entries are not counted or removed", () => {
    let now = 1_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const other = a.keyFor(sig("A"), scope({ userId: "second-user" }));
    for (let i = 0; i < MAX_ENTRIES_PER_SCOPE + 2; i++) {
      a.keyFor(sig(`topic ${i}`), scope());
      now += 1000;
    }
    expect(names()).toHaveLength(MAX_ENTRIES_PER_SCOPE + 1);
    expect(createAttempt(counter("n"), { now: () => now }).keyFor(sig("A"), scope({ userId: "second-user" }))).toBe(other);
  });

  it("an expired entry is pruned the next time one is made; a blocked one is kept for its three hours", () => {
    let now = 5_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const plain = a.keyFor(sig("plain"), scope());
    const held = a.keyFor(sig("held"), scope());
    a.markBlocked(12, held);
    now += MAX_AGE_MS + 1000;
    a.keyFor(sig("new one"), scope());
    expect(names()).toHaveLength(2);
    const reload = createAttempt(counter("r"), { now: () => now });
    expect(reload.keyFor(sig("plain"), scope())).not.toBe(plain);
    expect(reload.status(sig("held"), scope()).blocked).toBe(12);
    now += BLOCKED_MAX_AGE_MS + 1000;
    createAttempt(counter("s"), { now: () => now }).keyFor(sig("later"), scope());
    expect(names()).toHaveLength(1);
  });

  it("malformed entries and the old one-slot entry of the same scope are removed when one is made", () => {
    const a = createAttempt(counter());
    a.keyFor(sig("A"), scope());
    const nameA = names()[0];
    const tag = nameA.slice(ATTEMPT_PREFIX.length).split(":")[0];
    window.sessionStorage.setItem(ATTEMPT_PREFIX + tag, JSON.stringify({ v: 1, k: "old", h: "0".repeat(64), t: Date.now(), u: false }));
    window.sessionStorage.setItem(`${ATTEMPT_PREFIX}${tag}:${"1".repeat(64)}`, "{not json");
    window.sessionStorage.setItem(`${ATTEMPT_PREFIX}${tag}:${"2".repeat(64)}`, JSON.stringify({ v: 1, k: "k", h: "3".repeat(64), t: Date.now(), u: false }));
    a.keyFor(sig("B"), scope());
    expect(names()).toContain(nameA);
    expect(names()).toHaveLength(2);
    expect(window.sessionStorage.getItem(ATTEMPT_PREFIX + tag)).toBeNull();
  });
});

describe("sign-out clears every entry", () => {
  it("removes all of them by prefix, in every scope, and nothing else", () => {
    const a = createAttempt(counter());
    for (const t of ["A", "B", "C"]) a.markBlocked(1, a.keyFor(sig(t), scope()));
    a.keyFor(sig("A"), scope({ userId: "second-user" }));
    a.keyFor(sig("A"), scope({ channelId: "chan-b" }));
    expect(names().length).toBeGreaterThanOrEqual(5);
    clearAllCreateAttempts();
    expect(names()).toHaveLength(0);
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep me");
    // A request still in flight cannot write one back.
    a.markBlocked(1, "whatever");
    a.keyFor(sig("D"), scope());
    expect(names()).toHaveLength(0);
  });
});

describe("tampered entries", () => {
  const first = () => {
    const a = createAttempt(counter("a"));
    const key = a.keyFor(sig("A"), scope());
    a.markBlocked(12, key);
    return { key, name: names()[0], good: JSON.parse(window.sessionStorage.getItem(names()[0]) as string) };
  };

  it.each([
    ["not json", () => "{nope"],
    ["wrong version", (g: Record<string, unknown>) => JSON.stringify({ ...g, v: 2 })],
    ["a key with bad characters", (g: Record<string, unknown>) => JSON.stringify({ ...g, k: "a b<script>" })],
    ["a hash that is not this intent's", (g: Record<string, unknown>) => JSON.stringify({ ...g, h: "f".repeat(64) })],
    ["a negative amount", (g: Record<string, unknown>) => JSON.stringify({ ...g, b: -5 })],
    ["a time in the future", (g: Record<string, unknown>) => JSON.stringify({ ...g, t: Date.now() + 10 * 60 * 1000 })],
    ["unsure that is not a boolean", (g: Record<string, unknown>) => JSON.stringify({ ...g, u: "yes" })],
  ])("%s is not trusted and is replaced by a new key", (_label, make) => {
    const { key, name, good } = first();
    window.sessionStorage.setItem(name, (make as (g: Record<string, unknown>) => string)(good));
    const after = createAttempt(counter("b"));
    expect(after.status(sig("A"), scope())).toEqual({ unsure: false, blocked: null });
    expect(after.keyFor(sig("A"), scope())).toBe("b1");
    expect(after.keyFor(sig("A"), scope())).not.toBe(key);
  });
});

describe("isolation", () => {
  it("another user, organization or channel never sees A's key, unsure or blocked state, however many intents are stored", () => {
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"), scope());
    a.markBlocked(12, keyA);
    a.settle(a.keyFor(sig("B"), scope()));
    for (const other of [scope({ userId: "second-user" }), scope({ orgId: "org-2" }), scope({ orgId: null }), scope({ channelId: "chan-b" })]) {
      const o = createAttempt(counter("o"));
      expect(o.status(sig("A"), other).blocked, JSON.stringify(other)).toBeNull();
      expect(o.keyFor(sig("A"), other)).toBe("o1");
    }
    expect(createAttempt(counter("z")).keyFor(sig("A"), scope())).toBe(keyA);
  });
});

describe("storage denied", () => {
  it("behaves as memory only, per intent", () => {
    for (const m of ["getItem", "setItem", "removeItem", "key"] as const)
      vi.spyOn(Storage.prototype, m).mockImplementation(() => {
        throw new Error("blocked");
      });
    const a = createAttempt(counter());
    const keyA = a.keyFor(sig("A"), scope());
    a.markBlocked(12, keyA);
    a.settle(a.keyFor(sig("B"), scope()));
    expect(a.status(sig("A"), scope()).blocked).toBe(12);
    expect(a.keyFor(sig("A"), scope())).toBe(keyA);
    expect(createAttempt(counter("n")).status(sig("A"), scope()).blocked).toBeNull();
    expect(() => clearAllCreateAttempts()).not.toThrow();
  });
});
