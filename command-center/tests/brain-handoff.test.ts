import { describe, expect, it, vi } from "vitest";
import { IDEA_KEY, IDEA_MAX_AGE_MS, brainSessionFromUrl, recordRunHandoff, takeLandingIdea } from "@/lib/brain/handoff";
import { FILM, filmLength } from "@/lib/brain/logic";

function store(v: string | null) {
  const m = new Map<string, string>(v === null ? [] : [[IDEA_KEY, v]]);
  return { getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k), m };
}

describe("the landing page's idea (ns.idea.v1)", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  it("is read once and removed, so a reload does not type it in again", () => {
    const s = store(JSON.stringify({ text: "  a film about owls  ", at: now - 1000 }));
    expect(takeLandingIdea(s, now)).toBe("a film about owls");
    expect(s.m.has(IDEA_KEY)).toBe(false);
    expect(takeLandingIdea(s, now)).toBeNull();
  });
  it("older than two hours, from the future, or malformed is dropped — and still removed", () => {
    for (const raw of [JSON.stringify({ text: "old", at: now - IDEA_MAX_AGE_MS - 1 }), JSON.stringify({ text: "future", at: now + 3_600_000 }),
                       "{not json", JSON.stringify({ text: 5, at: now }), JSON.stringify({ text: "   ", at: now })]) {
      const s = store(raw);
      expect(takeLandingIdea(s, now)).toBeNull();
      expect(s.m.has(IDEA_KEY)).toBe(false);
    }
  });
  it("is bounded by code points, never splitting a character", () => {
    const s = store(JSON.stringify({ text: "😀".repeat(10), at: now }));
    expect(takeLandingIdea(s, now, 3)).toBe("😀😀😀");
  });
  it("a blocked storage reads as no idea, not a crash", () => {
    expect(takeLandingIdea({ getItem: () => { throw new Error("denied"); }, removeItem: () => {} }, now)).toBeNull();
    expect(takeLandingIdea(null, now)).toBeNull();
  });
});

describe("the run hand-off", () => {
  const sid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  it("takes the conversation only from a well-formed ?brain=", () => {
    expect(brainSessionFromUrl(`?topic=x&brain=${sid}`)).toBe(sid);
    expect(brainSessionFromUrl("?brain=../../x")).toBeNull();
    expect(brainSessionFromUrl("")).toBeNull();
  });
  it("sends the job and channel only — never a credit_ref (the database reads it from the job)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await recordRunHandoff(sid, "ch1", 42, f as unknown as typeof fetch)).toBe(true);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ action: "handoff", session: sid, handoff: { kind: "run", channel_id: "ch1", job_id: "42" } });
    expect(JSON.stringify(body)).not.toContain("credit_ref");
  });
  it("a failed record never throws into Run now (the run is already queued)", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); });
    await expect(recordRunHandoff(sid, "ch1", 1, f as unknown as typeof fetch)).resolves.toBe(false);
    expect(await recordRunHandoff("nope", "ch1", 1, f as unknown as typeof fetch)).toBe(false);
  });
});

describe("a short film's minimum is 10 seconds (0198)", () => {
  it("accepts 10 s and refuses 9 s", () => {
    expect(FILM.targetMin).toBe(10);
    expect(filmLength(10)).toBe(10);
    expect(filmLength(9)).toBeUndefined();
  });
});

describe("an idea for a closed panel goes to Create's idea box (S4)", () => {
  it("redirects only when the panel is closed and the landing params are both there", async () => {
    const { ideaNeedsCreate } = await import("@/lib/brain/flag");
    expect(ideaNeedsCreate({ ai: "new", idea: "1" }, false)).toBe(true);
    expect(ideaNeedsCreate({ ai: "new", idea: "1" }, true)).toBe(false);
    expect(ideaNeedsCreate({ ai: "new" }, false)).toBe(false);
    expect(ideaNeedsCreate({ idea: "1" }, false)).toBe(false);
    expect(ideaNeedsCreate({ ai: ["new"], idea: "1" }, false)).toBe(false);
  });
});
