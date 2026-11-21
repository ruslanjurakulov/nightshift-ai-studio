/**
 * The create form's draft store (lib/create-draft.ts): what is kept, for whom,
 * for how long, and that anything that does not match is removed rather than
 * shown.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DRAFT_MAX_BYTES,
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  DRAFT_VERSION,
  clearAllDrafts,
  clearDraft,
  draftKey,
  readDraft,
  writeDraft,
  type Draft,
  type DraftScope,
} from "../lib/create-draft";

class MemStore {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()];
  }
}

const scope: DraftScope = { userId: "u1", orgId: "o1", channelId: "c1" };
const draft: Draft = { topic: "Ancient Khiva", duration: "300", voice: "", look: "cinematic noir" };
const NOW = 1_800_000_000_000;
let store: MemStore;
beforeEach(() => {
  store = new MemStore();
});

describe("a draft round-trips for the same user, organization and channel", () => {
  it("is restored as written", () => {
    writeDraft(store, scope, draft, NOW);
    expect(readDraft(store, scope, NOW + 1000)).toEqual(draft);
  });

  it("stores only the topic, the three choices and what scopes them", () => {
    writeDraft(store, scope, draft, NOW);
    const rec = JSON.parse(store.getItem(draftKey(scope)) as string);
    expect(Object.keys(rec).sort()).toEqual(["channelId", "duration", "look", "orgId", "savedAt", "topic", "userId", "v", "voice"]);
    expect(rec.v).toBe(DRAFT_VERSION);
    expect(store.keys().every((k) => k.startsWith(DRAFT_PREFIX))).toBe(true);
  });

  it("an empty write removes it instead of keeping an empty draft", () => {
    writeDraft(store, scope, draft, NOW);
    clearDraft(store, scope);
    expect(readDraft(store, scope, NOW)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("works with no storage at all (blocked, private window): nothing is kept, nothing throws", () => {
    expect(() => writeDraft(null, scope, draft)).not.toThrow();
    expect(readDraft(null, scope)).toBeNull();
    const broken = { ...store, length: 1, key: () => { throw new Error("denied"); }, getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => writeDraft(broken, scope, draft)).not.toThrow();
    expect(readDraft(broken, scope)).toBeNull();
    expect(() => clearAllDrafts(broken)).not.toThrow();
  });
});

describe("a draft from another context is ignored and removed", () => {
  it.each([
    ["another user", { ...scope, userId: "u2" }],
    ["another organization", { ...scope, orgId: "o2" }],
    ["another channel", { ...scope, channelId: "c2" }],
  ])("%s", (_name, other) => {
    writeDraft(store, other, draft, NOW);
    expect(store.keys()).toHaveLength(1);
    expect(readDraft(store, scope, NOW)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("a record under this scope's key that names another scope inside is not trusted", () => {
    writeDraft(store, { ...scope, userId: "u2" }, draft, NOW);
    store.setItem(draftKey(scope), store.getItem(draftKey({ ...scope, userId: "u2" })) as string);
    store.removeItem(draftKey({ ...scope, userId: "u2" }));
    expect(readDraft(store, scope, NOW)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("keeps this scope's draft while removing the others in the same sweep", () => {
    writeDraft(store, scope, draft, NOW);
    writeDraft(store, { ...scope, orgId: "o2" }, { ...draft, topic: "someone else's" }, NOW);
    expect(readDraft(store, scope, NOW)).toEqual(draft);
    expect(store.keys()).toEqual([draftKey(scope)]);
  });

  it("an ids containing the separator cannot be confused with another scope", () => {
    const a = { userId: "u.1", orgId: "o", channelId: "c" };
    const b = { userId: "u", orgId: "1.o", channelId: "c" };
    expect(draftKey(a)).not.toBe(draftKey(b));
  });

  it("an older schema version is dropped, not guessed at", () => {
    store.setItem(`${DRAFT_PREFIX}v0.${scope.userId}.${scope.orgId}.${scope.channelId}`, JSON.stringify({ v: 0, ...scope, savedAt: NOW, ...draft }));
    expect(readDraft(store, scope, NOW)).toBeNull();
    expect(store.keys()).toEqual([]);
  });
});

describe("a draft expires and is never trusted malformed", () => {
  it("is gone after 24 hours and removed; one minute short of that it is still there", () => {
    writeDraft(store, scope, draft, NOW);
    expect(readDraft(store, scope, NOW + DRAFT_TTL_MS - 60_000)).toEqual(draft);
    expect(readDraft(store, scope, NOW + DRAFT_TTL_MS + 1)).toBeNull();
    expect(store.keys()).toEqual([]);
  });

  it("a record dated in the future is not trusted either", () => {
    writeDraft(store, scope, draft, NOW + 3 * 60 * 60 * 1000);
    expect(readDraft(store, scope, NOW)).toBeNull();
  });

  it.each([
    ["not JSON", "{oops"],
    ["not an object", "42"],
    ["a topic past the cap", { topic: "x".repeat(301) }],
    ["a length the form does not offer", { duration: "999" }],
    ["a voice that is not in the list", { voice: "AAAAAAAAAAAAAAAAAAAA" }],
    ["a non-string look", { look: 5 }],
  ])("%s is dropped and removed", (_name, patch) => {
    const base = { v: DRAFT_VERSION, ...scope, savedAt: NOW, ...draft };
    store.setItem(draftKey(scope), typeof patch === "string" ? patch : JSON.stringify({ ...base, ...patch }));
    expect(readDraft(store, scope, NOW)).toBeNull();
    expect(store.keys()).toEqual([]);
  });
});

describe("size is capped", () => {
  it("long fields are cut to their cap and the record stays under the byte cap", () => {
    writeDraft(store, scope, { topic: "t".repeat(5000), duration: "", voice: "", look: "l".repeat(5000) }, NOW);
    const raw = store.getItem(draftKey(scope)) as string;
    expect(raw.length).toBeLessThanOrEqual(DRAFT_MAX_BYTES);
    expect(readDraft(store, scope, NOW)?.topic).toHaveLength(300);
  });

  it("a record that would still not fit is not written (and an old one is removed)", () => {
    writeDraft(store, scope, draft, NOW);
    const huge = { userId: "u".repeat(DRAFT_MAX_BYTES), orgId: "o", channelId: "c" };
    writeDraft(store, huge, draft, NOW);
    expect(store.getItem(draftKey(huge))).toBeNull();
  });
});

describe("clearAllDrafts (sign-out and the sign-in page)", () => {
  it("removes every draft key whatever its scope or version, and nothing else", () => {
    writeDraft(store, scope, draft, NOW);
    writeDraft(store, { ...scope, userId: "u2" }, draft, NOW);
    store.setItem(`${DRAFT_PREFIX}v0.old`, "x");
    store.setItem("nightshift.assistant.plan.v1", "keep");
    store.setItem("theme", "dark");
    clearAllDrafts(store);
    expect(store.keys().sort()).toEqual(["nightshift.assistant.plan.v1", "theme"]);
  });
});
