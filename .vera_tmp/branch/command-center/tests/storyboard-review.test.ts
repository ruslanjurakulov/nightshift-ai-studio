import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import {
  MAX_SCENES,
  STORYBOARD_COLUMNS,
  isStoryboardId,
  mapStoryboardError,
  minutesLabel,
  storyboardErrorText,
  toScenes,
  toStoryboard,
} from "@/lib/storyboardReview";
import { PROVIDER_BRANDS } from "./helpers/brands";

/**
 * Storyboard review (migration 0057) — the pure half.
 *
 * What would break without these: a card the database never vouched for shown
 * as if it were the plan (a malformed one repaired into text it did not say);
 * the worker's script read into the browser; the database's refusals reaching
 * the person as a 500 or a raw error, or a refusal that read as "approved";
 * customer copy naming a provider or a role.
 */

const ID = "0b8f7a52-3f9c-4d1e-9b7a-1c2d3e4f5a6b";

function row(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    channel_id: "chan-a",
    slug: "the-lighthouse",
    topic: "The Lighthouse",
    title: "The Last Lighthouse",
    scenes: [
      { n: 1, name: "Open", type: "hook", narration: "A light in the storm.", visual: "storm waves", duration_s: 20 },
      { n: 2, name: "Keeper", type: "story", narration: "He kept it lit.", visual: "", duration_s: 40 },
    ],
    duration_s: 60,
    status: "ready",
    created_at: "2026-10-01T10:00:00Z",
    decided_at: null,
    credits_held: null,
    render_job_id: null,
    ...extra,
  };
}

describe("reading a storyboard row", () => {
  it("keeps the cards in order with their own text and length", () => {
    const sb = toStoryboard(row());
    expect(sb?.scenes.map((s) => [s.n, s.narration, s.durationS])).toEqual([
      [1, "A light in the storm.", 20],
      [2, "He kept it lit.", 40],
    ]);
    expect(sb?.durationS).toBe(60);
    expect(sb?.status).toBe("ready");
  });

  it("drops a malformed card instead of repairing it", () => {
    const scenes = toScenes([
      { n: 1, narration: "ok", visual: "v", duration_s: 10 },
      { n: "two", narration: "bad n", duration_s: 10 },
      { n: 3, narration: 42, duration_s: 10 },
      { n: 4, narration: "too long a scene", duration_s: 601 },
      "not an object",
    ]);
    expect(scenes.map((s) => s.n)).toEqual([1]);
    expect(toScenes(Array.from({ length: 80 }, (_, i) => ({ n: (i % 60) + 1, narration: "x", duration_s: 5 }))).length).toBe(
      MAX_SCENES,
    );
  });

  it("refuses a row without an id, a channel, or a priced length", () => {
    expect(toStoryboard(row({ id: "x" }))).toBeNull();
    expect(toStoryboard(row({ channel_id: "" }))).toBeNull();
    expect(toStoryboard(row({ duration_s: 10 }))).toBeNull();
    expect(toStoryboard(row({ duration_s: 4000 }))).toBeNull();
    expect(toStoryboard(null)).toBeNull();
  });

  it("an unexpected status reads as unknown, never as a decision", () => {
    expect(toStoryboard(row({ status: "approved-ish" }))?.status).toBe("unknown");
  });

  it("never selects the script the render resumes from", () => {
    expect(STORYBOARD_COLUMNS.split(",")).not.toContain("script");
  });

  it("validates ids and labels minutes", () => {
    expect(isStoryboardId(ID)).toBe(true);
    expect(isStoryboardId("../x")).toBe(false);
    expect(minutesLabel(270)).toBe("4.5");
    expect(minutesLabel(1800)).toBe("30");
  });
});

describe("the database's answers", () => {
  it("maps each refusal to a status and a code, with only the person's own numbers", () => {
    expect(mapStoryboardError({ code: "42501", message: "forbidden" })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(mapStoryboardError({ code: "NS409", message: "storyboard_not_ready" }).status).toBe(409);
    expect(
      mapStoryboardError({ code: "NS402", message: "insufficient credits", details: "available=12.5 needed=60" }),
    ).toEqual({ status: 402, body: { error: "insufficient_credits", needed: 60, available: 12.5 } });
    expect(mapStoryboardError({ code: "NS429", message: "x" }).body.error).toBe("run_limit");
    expect(mapStoryboardError({ code: "22023", message: "below_floor" })).toEqual({ status: 409, body: { error: "below_floor" } });
    expect(mapStoryboardError({ code: "PGRST202", message: "Could not find the function" }).body.error).toBe(
      "storyboard_unavailable",
    );
    // Anything else is a retryable failure, never a success and never the raw text.
    const other = mapStoryboardError({ code: "XX000", message: "secret internals" });
    expect(other).toEqual({ status: 502, body: { error: "approve_failed" } });
  });

  it("says each refusal as a sentence in every language", () => {
    for (const d of [en, ru, uz]) {
      const t = d.storyboardReview;
      expect(storyboardErrorText({ error: "insufficient_credits", needed: 60, available: 12 }, t)).toContain("60");
      expect(storyboardErrorText({ error: "price_changed", credits: 75 }, t)).toContain("75");
      expect(storyboardErrorText({ error: "storyboard_not_ready" }, t)).toBe(t.errNotReady);
      expect(storyboardErrorText({ error: "forbidden" }, t)).toBe(t.notAllowed);
      expect(storyboardErrorText(null, t)).toBe(t.errGeneric);
    }
  });
});

describe("customer copy", () => {
  it("names no provider and no role in any language", () => {
    for (const d of [en, ru, uz]) {
      const text = JSON.stringify(d.storyboardReview);
      expect(text).not.toMatch(PROVIDER_BRANDS);
      expect(text).not.toMatch(/\b(owner|editor|viewer|admin)\b/i);
      expect(text).not.toMatch(/владел|редактор|админ|наблюдател/i);
    }
  });

  it("every language has every string", () => {
    const keys = Object.keys(en.storyboardReview).sort();
    expect(Object.keys(ru.storyboardReview).sort()).toEqual(keys);
    expect(Object.keys(uz.storyboardReview).sort()).toEqual(keys);
  });
});

describe("the notification", () => {
  it("a run waiting at its storyboard shows in the header notifications", async () => {
    const { buildNotifications } = await import("@/lib/intelligence");
    const ev = {
      event_key: "ev-1", channel_id: "chan-a", event: "storyboard.ready", ts: "2026-10-01T10:00:00Z",
      video_id: null, job_id: null, agent: "storyboard", status: "completed", duration_ms: null,
      metadata: { storyboard_id: ID, slug: "the-lighthouse", reason: "ready" },
    };
    const stopped = { ...ev, event_key: "ev-2", event: "storyboard.stopped" };
    expect(buildNotifications([ev, stopped], [])).toEqual([
      { id: "ev:ev-1", kind: "storyboard", ts: ev.ts, subject: "the-lighthouse" },
    ]);
  });
});

// ── migration 0058: editing ──────────────────────────────────────────────

describe("an edit as the server takes it", () => {
  it("only src, narration and visual pass — no length, no ids, nothing else", async () => {
    const { toSceneEdits } = await import("@/lib/storyboardReview");
    expect(toSceneEdits([{ src: 2, narration: "a", visual: "b" }, { src: null, narration: "c" }])).toEqual([
      { src: 2, narration: "a", visual: "b" },
      { src: null, narration: "c", visual: "" },
    ]);
    for (const bad of [
      [{ src: 1, narration: "a", duration_s: 9 }],
      [{ src: 1, narration: "a", id: "x" }],
      [{ src: 1, narration: "a", asset_id: "00000000-0000-4000-8000-000000000001" }],
      [{ src: "1", narration: "a" }],
      [{ src: 0, narration: "a" }],
      [{ src: 61, narration: "a" }],
      [{ src: 1, narration: null }],
      [{ src: 1, narration: "a", visual: 3 }],
      [],
      Array.from({ length: MAX_SCENES + 1 }, () => ({ src: null, narration: "a" })),
      { src: 1, narration: "a" },
      null,
    ]) {
      expect(toSceneEdits(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("the screen names the same problems the database refuses", async () => {
    const { sceneProblem, editProblem } = await import("@/lib/storyboardReview");
    expect(sceneProblem({ narration: "Fine words.", visual: "harbour, dawn" })).toBeNull();
    expect(sceneProblem({ narration: "   ", visual: "" })).toBe("empty");
    expect(sceneProblem({ narration: "x".repeat(4001), visual: "" })).toBe("too_long");
    expect(sceneProblem({ narration: "Hi [ VOICE : secondary ] there", visual: "" })).toBe("markup");
    expect(sceneProblem({ narration: "x", visual: "[sfx:boom]" })).toBe("markup");
    expect(sceneProblem({ narration: "a\u0007b", visual: "" })).toBe("characters");
    expect(sceneProblem({ narration: "abc‮def", visual: "" })).toBe("characters");
    expect(sceneProblem({ narration: "x", visual: "a,b,c,d,e,f,g,h,i" })).toBe("terms");
    // A bracket that is not a cue is just text.
    expect(sceneProblem({ narration: "The year [1912] began.", visual: "" })).toBeNull();
    expect(editProblem([])).toBe("count");
    expect(editProblem([{ src: 1, narration: "a", visual: "" }, { src: 1, narration: "b", visual: "" }])).toBe("duplicate");
    expect(editProblem([{ src: 1, narration: "", visual: "" }])).toBe("scene");
  });

  it("reads the revision when the database has it, and none when it does not", () => {
    expect(toStoryboard(row({ revision: 3 }))?.revision).toBe(3);
    expect(toStoryboard(row())?.revision).toBeNull();
    expect(toStoryboard(row({ revision: -1 }))?.revision).toBeNull();
  });

  it("the edit's and the re-open's refusals become answers", () => {
    expect(mapStoryboardError({ code: "NS412", message: "stale_revision", details: "revision=7" })).toEqual({
      status: 409,
      body: { error: "stale_revision", revision: 7 },
    });
    for (const m of ["render_in_progress", "render_finished", "hold_not_released", "render_unverifiable"])
      expect(mapStoryboardError({ code: "NS423", message: m })).toEqual({ status: 409, body: { error: m } });
    expect(mapStoryboardError({ code: "22023", message: "scenes_invalid", details: "scene=2 cue_markup" })).toEqual({
      status: 400,
      body: { error: "scenes_invalid" },
    });
    expect(mapStoryboardError({ code: "22023", message: "storyboard_too_long" }).status).toBe(400);
    expect(mapStoryboardError({ code: "23514", message: "violates check constraint" }).body).toEqual({ error: "scenes_invalid" });
    // An unknown NS423 text never passes through.
    expect(mapStoryboardError({ code: "NS423", message: "something internal" })).toEqual({ status: 502, body: { error: "approve_failed" } });
  });

  it("each new refusal has its own sentence in every language", () => {
    for (const dict of [en, ru, uz]) {
      const t = dict.storyboardReview;
      for (const error of ["stale_revision", "scenes_invalid", "storyboard_too_long", "render_in_progress", "render_finished"]) {
        const text = storyboardErrorText({ error }, t);
        expect(text, error).not.toBe(t.errGeneric);
        expect(text).not.toMatch(PROVIDER_BRANDS);
      }
    }
  });
});
