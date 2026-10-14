// @vitest-environment jsdom
/**
 * The create attempt's idempotency key survives a reload of the tab (lib/create-attempt.ts +
 * lib/create-attempt-store.ts), and only that: sessionStorage, a hash of the intent, scoped to the
 * signed-in user, the organization and the channel, thirty minutes, gone on settle and on sign-out.
 * A "reload" here is a NEW createAttempt() over the same sessionStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_AGE_MS, createAttempt, newAttemptKey, type AttemptScope } from "@/lib/create-attempt";
import { ATTEMPT_PREFIX, attemptStorageBlocked, clearAllCreateAttempts } from "@/lib/create-attempt-store";

const counter = (prefix = "k") => {
  let n = 0;
  return () => `${prefix}${++n}`;
};
const USER = "5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11";
const ORG = "org-7f3a";
const CHAN = "UCabcdefghijklmnopqrstuv";
const scope = (over: Partial<AttemptScope> = {}): AttemptScope => ({ userId: USER, orgId: ORG, channelId: CHAN, ...over });
const TOPIC = "Secret Documentary About Ancient Khiva";
const sig = (over: Record<string, unknown> = {}) => JSON.stringify({ channel_id: CHAN, topic: TOPIC, duration: 300, ...over });

const names = () => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i) as string);
const dump = () => JSON.stringify(names().map((k) => [k, window.sessionStorage.getItem(k)]));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearAllCreateAttempts();
});

describe("a reload (a new attempt over the same tab storage)", () => {
  it("reuses the key and the unsure flag, so a second press after a lost answer cannot hold twice", () => {
    const before = createAttempt(counter("a"));
    const key = before.keyFor(sig(), scope());
    before.markUnsure();
    const after = createAttempt(counter("b"));
    expect(after.keyFor(sig(), scope())).toBe(key);
    expect(after.isUnsure()).toBe(true);
    // And a second press on the reloaded page is still that same key.
    expect(after.keyFor(sig(), scope())).toBe(key);
  });

  it("an attempt that was not unsure comes back as not unsure", () => {
    const key = createAttempt(counter("a")).keyFor(sig(), scope());
    const after = createAttempt(counter("b"));
    expect(after.keyFor(sig(), scope())).toBe(key);
    expect(after.isUnsure()).toBe(false);
  });

  it("keeps the real key shape: the one the route accepts", () => {
    const key = createAttempt().keyFor(sig(), scope());
    expect(key).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
    expect(createAttempt().keyFor(sig(), scope())).toBe(key);
    expect(newAttemptKey()).not.toBe(key);
  });
});

describe("another user, organization, channel, topic or option never gets the key", () => {
  const base = () => {
    const key = createAttempt(counter("a")).keyFor(sig(), scope());
    return key;
  };
  const cases: [string, string, AttemptScope][] = [
    ["another user on the same browser", sig(), scope({ userId: "9d1f6b0a-0000-4000-8000-000000000001" })],
    ["another organization", sig(), scope({ orgId: "org-other" })],
    ["no organization where there was one", sig(), scope({ orgId: null })],
    ["another channel", sig({ channel_id: "UCother" }), scope({ channelId: "UCother" })],
    ["a changed topic", sig({ topic: TOPIC + "!" }), scope()],
    ["a changed option", sig({ duration: 600 }), scope()],
    ["an added option", sig({ language: "Russian" }), scope()],
  ];
  for (const [name, signature, sc] of cases) {
    it(`${name} gets a new key`, () => {
      const key = base();
      const other = createAttempt(counter("b")).keyFor(signature, sc);
      expect(other).not.toBe(key);
      expect(other).toMatch(/^b\d+$/);
    });
  }

  it("a signature that matches but a different scope (same channel in the signature) is still not reused", () => {
    const key = base();
    expect(createAttempt(counter("b")).keyFor(sig(), scope({ userId: "someone-else" }))).not.toBe(key);
  });

  it("the first user's entry is still there for the first user afterwards", () => {
    const key = base();
    createAttempt(counter("b")).keyFor(sig(), scope({ userId: "someone-else" }));
    expect(createAttempt(counter("c")).keyFor(sig(), scope())).toBe(key);
  });

  it("one mounted form moved to another channel and back keeps each channel's key", () => {
    const a = createAttempt(counter("k"));
    const chanA = a.keyFor(sig(), scope());
    a.markUnsure();
    const chanB = a.keyFor(sig({ channel_id: "UCb" }), scope({ channelId: "UCb" }));
    expect(chanB).not.toBe(chanA);
    expect(createAttempt(counter("z")).keyFor(sig(), scope())).toBe(chanA);
  });
});

describe("nothing a person typed is stored", () => {
  it("stores only {v, k, h, t, u} under a hashed name, with no topic, id or option text anywhere", () => {
    const a = createAttempt(counter("k"), { now: () => 1_700_000_000_000 });
    a.keyFor(sig({ visual_style: "noir cinematic", voice_id: "voice-xyz" }), scope());
    a.markUnsure();
    expect(names()).toHaveLength(1);
    const [name] = names();
    expect(name.startsWith(ATTEMPT_PREFIX)).toBe(true);
    // One entry per intent: a hash of whose it is, then the intent's own hash.
    expect(name.slice(ATTEMPT_PREFIX.length)).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
    const entry = JSON.parse(window.sessionStorage.getItem(name) as string);
    expect(Object.keys(entry).sort()).toEqual(["h", "k", "t", "u", "v"]);
    expect(entry).toMatchObject({ v: 1, k: "k1", t: 1_700_000_000_000, u: true });
    expect(entry.h).toMatch(/^[0-9a-f]{64}$/);
    expect(name.endsWith(`:${entry.h}`)).toBe(true);
    const all = dump();
    for (const secret of [TOPIC, "Khiva", "Secret", "noir", "voice-xyz", USER, ORG, CHAN, "channel_id", "topic", "duration"]) {
      expect(all).not.toContain(secret);
    }
    expect(window.localStorage.length).toBe(0);
  });

  it("the stored hash depends on the user, so the hash of a short topic cannot be guessed without the user id", () => {
    createAttempt(counter("k")).keyFor(sig(), scope());
    const one = JSON.parse(window.sessionStorage.getItem(names()[0]) as string).h;
    window.sessionStorage.clear();
    createAttempt(counter("k")).keyFor(sig(), scope({ userId: "other" }));
    const two = JSON.parse(window.sessionStorage.getItem(names()[0]) as string).h;
    expect(one).not.toBe(two);
  });

  it("without a user id, nothing is stored at all and it is memory only, as before", () => {
    const a = createAttempt(counter("k"));
    expect(a.keyFor(sig(), scope({ userId: "" }))).toBe("k1");
    a.markUnsure();
    expect(a.keyFor(sig(), scope({ userId: "" }))).toBe("k1");
    expect(a.keyFor(sig())).toBe("k1");
    expect(a.keyFor(sig({ topic: "another" }))).toBe("k2");
    a.markUnsure();
    expect(window.sessionStorage.length).toBe(0);
    expect(createAttempt(counter("n")).keyFor(sig(), scope({ userId: "" }))).toBe("n1");
  });

  it("no channel, no storage", () => {
    createAttempt(counter("k")).keyFor(sig(), scope({ channelId: "" }));
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("thirty minutes", () => {
  it("an entry older than that is not reused, and is removed when it is found stale", () => {
    let t = 1_000_000;
    createAttempt(counter("a"), { now: () => t }).keyFor(sig(), scope());
    t += MAX_AGE_MS;
    expect(createAttempt(counter("b"), { now: () => t }).keyFor(sig(), scope())).toBe("a1");
    t += 1;
    const late = createAttempt(counter("c"), { now: () => t });
    expect(late.keyFor(sig(), scope())).toBe("c1");
    // The stale entry was replaced by the new attempt's, not kept beside it.
    expect(names()).toHaveLength(1);
    expect(JSON.parse(window.sessionStorage.getItem(names()[0]) as string).k).toBe("c1");
  });

  it("is re-checked on every read, even inside one mounted form", () => {
    let t = 5_000;
    const a = createAttempt(counter("k"), { now: () => t });
    expect(a.keyFor(sig(), scope())).toBe("k1");
    t += MAX_AGE_MS + 1;
    expect(a.keyFor(sig(), scope())).toBe("k2");
    expect(a.isUnsure()).toBe(false);
  });

  it("an entry dated in the future (a clock that moved back, or a forged one) is not trusted", () => {
    const t = 10_000_000;
    createAttempt(counter("a"), { now: () => t + 3_600_000 }).keyFor(sig(), scope());
    expect(createAttempt(counter("b"), { now: () => t }).keyFor(sig(), scope())).toBe("b1");
  });
});

describe("settle", () => {
  it("removes the entry: the next intent, even with the same inputs, is a new video with a new key", () => {
    const a = createAttempt(counter("k"));
    a.keyFor(sig(), scope());
    a.markUnsure();
    expect(window.sessionStorage.length).toBe(1);
    a.settle();
    expect(window.sessionStorage.length).toBe(0);
    expect(createAttempt(counter("n")).keyFor(sig(), scope())).toBe("n1");
  });

  it("settling after a reload removes the entry that reload adopted", () => {
    createAttempt(counter("a")).keyFor(sig(), scope());
    const after = createAttempt(counter("b"));
    after.keyFor(sig(), scope());
    after.settle();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("sign-out", () => {
  it("clears every create attempt of every user and channel, and nothing else", () => {
    createAttempt(counter("a")).keyFor(sig(), scope());
    createAttempt(counter("b")).keyFor(sig({ channel_id: "UCb" }), scope({ channelId: "UCb" }));
    createAttempt(counter("c")).keyFor(sig(), scope({ userId: "second-user" }));
    window.sessionStorage.setItem("unrelated", "keep");
    expect(names()).toHaveLength(4);
    clearAllCreateAttempts();
    expect(names()).toEqual(["unrelated"]);
  });

  it("a request that was in flight at sign-out cannot write its entry back; the next form switches storing on again", () => {
    const inFlight = createAttempt(counter("a"));
    inFlight.keyFor(sig(), scope());
    clearAllCreateAttempts();
    expect(attemptStorageBlocked()).toBe(true);
    inFlight.markUnsure();
    inFlight.keyFor(sig({ topic: "again" }), scope());
    expect(window.sessionStorage.length).toBe(0);
    createAttempt(counter("n")).keyFor(sig(), scope());
    expect(attemptStorageBlocked()).toBe(false);
    expect(window.sessionStorage.length).toBe(1);
  });

  it("the signed-out user's key is not found by the next user, nor by the same user's next sign-in", () => {
    const key = createAttempt(counter("a")).keyFor(sig(), scope());
    clearAllCreateAttempts();
    expect(createAttempt(counter("b")).keyFor(sig(), scope())).not.toBe(key);
  });
});

describe("storage that fails", () => {
  it("storage that throws on every call behaves exactly like memory only", () => {
    for (const m of ["getItem", "setItem", "removeItem", "key"] as const) vi.spyOn(Storage.prototype, m).mockImplementation(() => {
      throw new Error("blocked");
    });
    const a = createAttempt(counter("k"));
    expect(a.keyFor(sig(), scope())).toBe("k1");
    a.markUnsure();
    expect(a.isUnsure()).toBe(true);
    expect(a.keyFor(sig(), scope())).toBe("k1");
    expect(a.keyFor(sig({ topic: "x" }), scope())).toBe("k2");
    expect(a.isUnsure()).toBe(false);
    a.settle();
    // Each intent has its own memory: settling the second one leaves the first one's key (and unsure flag) alone.
    expect(a.keyFor(sig(), scope())).toBe("k1");
    expect(a.isUnsure()).toBe(true);
    expect(a.keyFor(sig({ topic: "x" }), scope())).toBe("k3");
    expect(() => clearAllCreateAttempts()).not.toThrow();
  });

  it("a store that cannot even be reached (window.sessionStorage throws) is memory only", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage") as PropertyDescriptor;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    try {
      const a = createAttempt(counter("k"));
      expect(a.keyFor(sig(), scope())).toBe("k1");
      a.markUnsure();
      expect(a.keyFor(sig(), scope())).toBe("k1");
      a.settle();
      expect(a.keyFor(sig(), scope())).toBe("k2");
      expect(() => clearAllCreateAttempts()).not.toThrow();
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }
  });

  it("a full store (setItem throws) still gives a stable key within the page", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const a = createAttempt(counter("k"));
    expect(a.keyFor(sig(), scope())).toBe("k1");
    a.markUnsure();
    expect(a.keyFor(sig(), scope())).toBe("k1");
    expect(a.isUnsure()).toBe(true);
  });
});

describe("a tampered or foreign entry is ignored", () => {
  const good = () => {
    createAttempt(counter("a")).keyFor(sig(), scope());
    const name = names()[0];
    return { name, entry: JSON.parse(window.sessionStorage.getItem(name) as string) as Record<string, unknown> };
  };
  const tamper = (mutate: (e: Record<string, unknown>) => unknown) => {
    const { name, entry } = good();
    const v = mutate(entry);
    window.sessionStorage.setItem(name, typeof v === "string" ? v : JSON.stringify(entry));
    return name;
  };
  const bad: [string, (e: Record<string, unknown>) => unknown][] = [
    ["not JSON", () => "{not json"],
    ["JSON null", () => "null"],
    ["a JSON array", () => "[1,2]"],
    ["a string", () => '"create-abc"'],
    ["another version", (e) => void (e.v = 2)],
    ["a missing key", (e) => void delete e.k],
    ["a key with characters the route refuses", (e) => void (e.k = "a b/../c")],
    ["a key that is too long", (e) => void (e.k = "x".repeat(101))],
    ["a key that is not a string", (e) => void (e.k = 12)],
    ["a hash that is not this intent's", (e) => void (e.h = "0".repeat(64))],
    ["a hash that is not hex", (e) => void (e.h = "zz")],
    ["a time that is not a number", (e) => void (e.t = "now")],
    ["a time that is NaN", (e) => void (e.t = null)],
    ["an unsure flag that is not a boolean", (e) => void (e.u = "yes")],
  ];
  for (const [name, mutate] of bad) {
    it(`${name}: a new key, and the bad entry is replaced`, () => {
      const storeName = tamper(mutate);
      const a = createAttempt(counter("b"));
      expect(a.keyFor(sig(), scope())).toBe("b1");
      const now = JSON.parse(window.sessionStorage.getItem(storeName) as string);
      expect(now.k).toBe("b1");
    });
  }

  it("an entry copied from another user's storage name is not accepted for this user", () => {
    const { name, entry } = good();
    const other = createAttempt(counter("o"));
    other.keyFor(sig(), scope({ userId: "other" }));
    const otherName = names().find((n) => n !== name) as string;
    window.sessionStorage.setItem(otherName, JSON.stringify(entry));
    expect(createAttempt(counter("b")).keyFor(sig(), scope({ userId: "other" }))).toBe("b1");
  });
});
