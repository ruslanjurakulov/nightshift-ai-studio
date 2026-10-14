// @vitest-environment jsdom
/**
 * The two states kept with the key (lib/create-attempt.ts): unsure, and blocked (a start that
 * definitely failed while its credits are still held). Persisted in the same hashed entry as the key,
 * validated on read, bound to the key they were learned under, and gone when the intent changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_MAX_AGE_MS, MAX_AGE_MS, createAttempt, type AttemptScope } from "@/lib/create-attempt";
import { ATTEMPT_PREFIX, clearAllCreateAttempts } from "@/lib/create-attempt-store";

const counter = (prefix = "k") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const scope = (over: Partial<AttemptScope> = {}): AttemptScope => ({ userId: USER, orgId: "org-7f3a", channelId: "chan-a", ...over });
const TOPIC = "Secret Documentary About Ancient Khiva";
const sig = (over: Record<string, unknown> = {}) => JSON.stringify({ channel_id: "chan-a", topic: TOPIC, duration: 300, ...over });
const names = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string).filter((k) => k.startsWith(ATTEMPT_PREFIX));
const entry = () => JSON.parse(window.sessionStorage.getItem(names()[0]) ?? "null");

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(() => clearAllCreateAttempts());

describe("blocked: the start failed and the credits are still held", () => {
  it("status says so for this intent only, without making a key or touching the stored entry of another intent", () => {
    const a = createAttempt(counter());
    const key = a.keyFor(sig(), scope());
    a.markBlocked(120, key);
    expect(a.status(sig(), scope())).toEqual({ unsure: false, blocked: 120, full: false });
    // Another topic / option / channel / user: nothing in the way.
    expect(a.status(sig({ topic: "Another" }), scope()).blocked).toBeNull();
    expect(a.status(sig({ duration: 60 }), scope()).blocked).toBeNull();
    expect(a.status(sig(), scope({ channelId: "chan-b" })).blocked).toBeNull();
    expect(a.status(sig(), scope({ userId: "someone-else" })).blocked).toBeNull();
    // Asking about another intent did not remove this one's entry, and made no key.
    expect(names()).toHaveLength(1);
    expect(a.status(sig(), scope()).blocked).toBe(120);
  });

  it("is kept across a reload (a new attempt over the same storage), for the same key", () => {
    const first = createAttempt(counter("a"));
    const key = first.keyFor(sig(), scope());
    first.markBlocked(120, key);
    const after = createAttempt(counter("b"));
    expect(after.status(sig(), scope())).toEqual({ unsure: false, blocked: 120, full: false });
    expect(after.keyFor(sig(), scope())).toBe(key);
  });

  it("stores only a number, never what was typed", () => {
    const a = createAttempt(counter());
    a.markBlocked(120, a.keyFor(sig(), scope()));
    const raw = window.sessionStorage.getItem(names()[0]) ?? "";
    expect(entry()).toMatchObject({ v: 1, b: 120, u: false });
    expect(raw).not.toContain("Khiva");
    expect(raw).not.toContain(USER);
  });

  it("an unknown amount (0) is still blocked; a bad amount is not trusted from storage", () => {
    const a = createAttempt(counter());
    a.markBlocked(0, a.keyFor(sig(), scope()));
    expect(a.status(sig(), scope()).blocked).toBe(0);
    const good = window.sessionStorage.getItem(names()[0]) as string;
    const name = names()[0];
    for (const bad of [-1, "120", null, 1e12, true, {}]) {
      window.sessionStorage.setItem(name, JSON.stringify({ ...JSON.parse(good), b: bad }));
      expect(createAttempt(counter()).status(sig(), scope()).blocked, JSON.stringify(bad)).toBeNull();
    }
    // A bad entry is not used for a key either, and is removed when a key is asked for.
    window.sessionStorage.setItem(name, JSON.stringify({ ...JSON.parse(good), b: -1 }));
    createAttempt(counter("n")).keyFor(sig(), scope());
    expect(entry().k).toBe("n1");
    expect(entry().b).toBeUndefined();
  });

  it("is dropped when the intent changes: a changed topic is a new key and nothing is blocked", () => {
    const a = createAttempt(counter());
    const key = a.keyFor(sig(), scope());
    a.markBlocked(120, key);
    const next = a.keyFor(sig({ topic: "Another" }), scope());
    expect(next).not.toBe(key);
    expect(a.status(sig({ topic: "Another" }), scope()).blocked).toBeNull();
  });

  it("lasts about three hours (the hold's life), measured from when it was learned, not the thirty minutes of a key", () => {
    let now = 1_000_000;
    const a = createAttempt(counter(), { now: () => now });
    const key = a.keyFor(sig(), scope());
    now += MAX_AGE_MS - 1000;
    a.markBlocked(120, key);
    now += MAX_AGE_MS + 5000; // well past a key's life
    expect(a.status(sig(), scope()).blocked).toBe(120);
    expect(a.keyFor(sig(), scope())).toBe(key);
    now += BLOCKED_MAX_AGE_MS; // past the hold's
    expect(createAttempt(counter("z"), { now: () => now }).status(sig(), scope()).blocked).toBeNull();
    expect(a.status(sig(), scope()).blocked).toBeNull();
    expect(a.keyFor(sig(), scope())).not.toBe(key);
  });

  it("is memory only without a scope, and without working storage", () => {
    const a = createAttempt(counter());
    const key = a.keyFor(sig());
    a.markBlocked(120, key);
    expect(a.status(sig())).toEqual({ unsure: false, blocked: 120, full: false });
    expect(names()).toHaveLength(0);
    expect(createAttempt(counter()).status(sig()).blocked).toBeNull();
  });
});

describe("answers about a key apply to that key only (a late answer of an earlier attempt)", () => {
  it("settle, markUnsure and markBlocked for an old key do nothing to the current attempt", () => {
    const a = createAttempt(counter());
    const old = a.keyFor(sig(), scope());
    const fresh = a.keyFor(sig({ topic: "Another" }), scope());
    expect(fresh).not.toBe(old);
    a.settle(old);
    a.markUnsure(old);
    a.markBlocked(120, old);
    expect(a.keyFor(sig({ topic: "Another" }), scope())).toBe(fresh);
    expect(a.isUnsure()).toBe(false);
    expect(a.status(sig({ topic: "Another" }), scope()).blocked).toBeNull();
    // And the right key still works.
    a.markUnsure(fresh);
    expect(a.isUnsure()).toBe(true);
    a.settle(fresh);
    expect(a.keyFor(sig({ topic: "Another" }), scope())).not.toBe(fresh);
  });

  it("without a key argument they act on the current attempt, as before", () => {
    const a = createAttempt(counter());
    const key = a.keyFor(sig(), scope());
    a.markUnsure();
    expect(a.isUnsure()).toBe(true);
    a.settle();
    expect(a.keyFor(sig(), scope())).not.toBe(key);
  });
});
