import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIO_SLACK_S,
  CLIP_COLUMNS,
  MAX_CLIPS,
  MAX_CLIP_SCENES,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  REQUEST_COLUMNS,
  candidateWindows,
  canPress,
  clipMasterId,
  clipRefs,
  clockText,
  decodeClips,
  encodeClips,
  failureText,
  isIdempotencyKey,
  isRepurposedClip,
  isSceneId,
  isVideoId,
  mapRepurposeError,
  newIdempotencyKey,
  parseClipRows,
  parseQuote,
  parseRequestRows,
  pickedOverlap,
  planClips,
  proposeClips,
  reasonText,
  repurposeErrorText,
  requestText,
  round3,
  scoreText,
} from "@/lib/repurpose";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

/**
 * Multi-clip repurposing (migration 0080): the proposal twin, the quote the
 * button shows and how the database's refusals read. The shared cases are the
 * SAME file the Python mirror (modules/repurpose.py) and the database's
 * repurpose_plan run, so the page, the worker and the database can never
 * disagree about what a window is.
 */

type Spec = { __raw__?: unknown; lengths?: number[]; audio_s?: number | null; overrides?: Record<string, Record<string, unknown>> };

const CASES = JSON.parse(readFileSync(path.resolve(process.cwd(), "..", "samples", "repurpose_cases.json"), "utf-8")) as {
  plan: Array<{ name: string; manifest: Spec; clips: unknown; expected: { ok: boolean; reason?: string; position?: number; clips?: Array<Record<string, unknown>> } }>;
  propose: Array<{
    name: string;
    manifest: Spec;
    points: Array<{ elapsed_ratio: number; watch_ratio: number; measured_date: string }>;
    max_clips: number;
    expected: { retention: string; clips: Array<Record<string, unknown>> };
  }>;
};

/** The manifest spec of samples/repurpose_cases.json, built the way Python builds it. */
function build(spec: Spec): unknown {
  if ("__raw__" in spec) return spec.__raw__;
  const scenes: Array<Record<string, unknown>> = [];
  let t = 0; // thousandths, so nothing accumulates float noise
  (spec.lengths ?? []).forEach((n, i) => {
    const s = t;
    t += Math.round(n * 10000); // ten-thousandths (cases use up to 4 decimals)
    scenes.push({ id: `s${String(i).padStart(3, "0")}`, index: i, start_s: s / 10000, end_s: t / 10000, narration: `Scene ${i} narration.` });
  });
  for (const [k, ov] of Object.entries(spec.overrides ?? {})) Object.assign(scenes[Number(k)], ov);
  const m: Record<string, unknown> = { version: 1, scenes };
  const audio = "audio_s" in spec ? spec.audio_s : t / 10000;
  if (audio !== null && audio !== undefined) m.audio = { duration_s: audio };
  return m;
}

const TEN: Spec = { lengths: [20, 5, 8, 12, 25, 10, 30, 15, 18, 7] };

describe("shared plan cases (Python mirror and the database run the same file)", () => {
  for (const c of CASES.plan) {
    it(c.name, () => {
      const got = planClips(build(c.manifest), c.clips);
      expect(got.ok).toBe(c.expected.ok);
      if (c.expected.ok && got.ok) {
        expect(got.clips).toHaveLength(c.expected.clips!.length);
        got.clips.forEach((g, i) => {
          const w = c.expected.clips![i];
          expect(g.position).toBe(w.position);
          expect([g.first, g.last, g.sceneIds]).toEqual([w.first, w.last, w.scene_ids]);
          expect(g.startS).toBeCloseTo(w.start_s as number, 9);
          expect(g.endS).toBeCloseTo(w.end_s as number, 9);
          expect(g.durationS).toBeCloseTo(w.duration_s as number, 9);
        });
      } else if (!got.ok) {
        expect(got.reason).toBe(c.expected.reason);
        expect(got.position).toBe(c.expected.position);
      }
    });
  }
});

describe("shared proposal cases (Python twin runs the same file)", () => {
  for (const c of CASES.propose) {
    it(c.name, () => {
      const got = proposeClips(build(c.manifest), c.points, c.max_clips);
      expect(got.retention).toBe(c.expected.retention);
      expect(got.clips).toHaveLength(c.expected.clips.length);
      got.clips.forEach((g, i) => {
        const w = c.expected.clips[i];
        expect(g.rank).toBe(w.rank);
        expect([g.first, g.last, g.sceneIds]).toEqual([w.first, w.last, w.scene_ids]);
        expect([g.startS, g.endS, g.durationS]).toEqual([w.start_s, w.end_s, w.duration_s]);
        expect(g.measured).toBe(w.measured);
        if (w.score === null) expect(g.score).toBeNull();
        else expect(g.score).toBeCloseTo(w.score as number, 6);
      });
    });
  }
});

describe("windows are whole scenes", () => {
  it("every candidate starts and ends on a real scene boundary and fits the Shorts window", () => {
    // A deterministic spread of manifests (no randomness: a failure must repeat).
    for (let seed = 1; seed <= 40; seed++) {
      const lengths = Array.from({ length: 2 + (seed % 25) }, (_, i) => 1 + ((seed * 7 + i * 13) % 39) + ((i * seed) % 10) / 10);
      const m = build({ lengths }) as { scenes: Array<{ start_s: number; end_s: number }> };
      const starts = new Set(m.scenes.map((s) => s.start_s));
      const ends = new Set(m.scenes.map((s) => s.end_s));
      for (const w of candidateWindows(m)) {
        expect(starts.has(w.startS)).toBe(true);
        expect(ends.has(w.endS)).toBe(true);
        expect(w.durationS).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
        expect(w.durationS).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
        expect(w.sceneIds.length).toBeLessThanOrEqual(MAX_CLIP_SCENES);
        expect(planClips(m, [{ first: w.first, last: w.last }]).ok).toBe(true);
      }
      const picked = proposeClips(m, []).clips;
      expect(pickedOverlap(picked)).toBe(false);
    }
  });

  it("a scene longer than a Short is never split", () => {
    const got = proposeClips(build({ lengths: [90, 20, 20] }), []);
    expect(got.clips.map((c) => [c.first, c.last])).toEqual([["s001", "s002"]]);
  });

  it("proposes at most five, and none when asked for none or given no scene record", () => {
    expect(proposeClips(build({ lengths: Array(20).fill(16) }), [], 99).clips).toHaveLength(MAX_CLIPS);
    expect(proposeClips(build({ lengths: Array(20).fill(16) }), [], 0).clips).toEqual([]);
    for (const bad of [null, undefined, {}, [], { scenes: "x" }, { scenes: [null, 3, "s000"] }]) {
      expect(proposeClips(bad, []).clips).toEqual([]);
      expect(proposeClips(bad, []).retention).toBe("not_measured");
    }
  });

  it("with no retention it says not measured and invents no score", () => {
    const got = proposeClips(build(TEN), []);
    expect(got.retention).toBe("not_measured");
    expect(got.clips.length).toBeGreaterThan(0);
    for (const c of got.clips) {
      expect(c.score).toBeNull();
      expect(c.measured).toBe(false);
      expect(scoreText(c, en.repurpose)).toBe(en.repurpose.scoreNotMeasured);
    }
  });

  it("round3 rounds half away from zero on the decimal text, like the database", () => {
    expect(round3(20.0005)).toBe(20.001);
    expect(round3(35.0009)).toBe(35.001);
    expect(round3(1.0004)).toBe(1);
    expect(round3(12.5)).toBe(12.5);
    expect(round3(1e-7)).toBe(0);
  });

  it("the limits are the Shorts window and the database's", () => {
    expect([MIN_CLIP_SECONDS, MAX_CLIP_SECONDS, MAX_CLIPS, MAX_CLIP_SCENES, AUDIO_SLACK_S]).toEqual([15, 60, 5, 12, 0.5]);
  });

  it("two picked clips that share a scene are caught before the press", () => {
    const got = proposeClips(build(TEN), []);
    expect(pickedOverlap(got.clips)).toBe(false);
    expect(pickedOverlap([got.clips[0], got.clips[0]])).toBe(true);
  });
});

describe("what travels between the page and the database", () => {
  it("ids and keys are checked before anything is asked", () => {
    expect(isSceneId("s000")).toBe(true);
    expect(isSceneId("s12")).toBe(false);
    expect(isSceneId("s000; drop")).toBe(false);
    expect(isVideoId("run-0123456789abcdef0123")).toBe(true);
    expect(isVideoId("../x")).toBe(false);
    expect(isIdempotencyKey(newIdempotencyKey(() => "abc12345"))).toBe(true);
    expect(isIdempotencyKey("short")).toBe(false);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });

  it("clips travel as first-last pairs and are refused when they are not", () => {
    const refs = [{ first: "s000", last: "s002" }, { first: "s004", last: "s004" }];
    expect(encodeClips(refs)).toBe("s000-s002,s004-s004");
    expect(decodeClips("s000-s002,s004-s004")).toEqual(refs);
    for (const bad of [null, undefined, "", "s000", "s000-", "s000-s002,", "x-y", "s000-s001,".repeat(6).slice(0, -1), "s000-s002;s004-s005"]) {
      expect(decodeClips(bad as string | null | undefined)).toBeNull();
    }
    expect(clipRefs(refs)).toEqual(refs);
    expect(clipRefs([{ first: "s000", last: "s002", start_s: 5 }])).toEqual([{ first: "s000", last: "s002" }]);
    for (const bad of [[], "x", null, [1], [{ first: "s000" }], Array(6).fill(refs[0]), [{ first: "s0", last: "s1" }]]) {
      expect(clipRefs(bad)).toBeNull();
    }
  });
});

describe("the quote", () => {
  const priced = {
    status: "priced", credits: "8.00", clip_credits: 4, may_start: true,
    clips: [{ position: 1, first: "s000", last: "s000", scene_ids: ["s000"], start_s: 0, end_s: 20, duration_s: 20 }],
  };

  it("reads a price only when the database says priced with a positive number", () => {
    const q = parseQuote(priced);
    expect(q).toMatchObject({ status: "priced", credits: 8, clipCredits: 4, mayStart: true, reason: null });
    expect(q.clips).toEqual([{ position: 1, first: "s000", last: "s000", sceneIds: ["s000"], startS: 0, endS: 20, durationS: 20 }]);
    expect(canPress(q)).toBe(true);
  });

  it("an unset price is unpriced, never zero, and cannot be pressed", () => {
    const q = parseQuote({ status: "unpriced", credits: null, may_start: true, clips: priced.clips });
    expect(q.status).toBe("unpriced");
    expect(q.credits).toBeNull();
    expect(canPress(q)).toBe(false);
  });

  it("a priced answer without a positive number is not a price", () => {
    for (const credits of [0, "0", -1, null, "x", undefined]) {
      const q = parseQuote({ ...priced, credits });
      expect(q.status).toBe("unavailable");
      expect(canPress(q)).toBe(false);
    }
  });

  it("a member who may only read sees the price and cannot press", () => {
    expect(canPress(parseQuote({ ...priced, may_start: false }))).toBe(false);
  });

  it("the operator's own organization reads included, with no number", () => {
    const q = parseQuote({ status: "included", credits: null, may_start: true, clips: priced.clips });
    expect(q.status).toBe("included");
    expect(q.credits).toBeNull();
    expect(canPress(q)).toBe(true);
  });

  it("anything unexpected is unavailable with an unknown reason", () => {
    for (const junk of [null, undefined, "x", [], { status: "free" }, { status: "unavailable", reason: "<script>" }]) {
      const q = parseQuote(junk);
      expect(q.status).toBe("unavailable");
      expect(q.reason).toBe("unknown");
      expect(canPress(q)).toBe(false);
    }
  });

  it("an unavailable quote carries the reason and the clip it is about", () => {
    const q = parseQuote({ status: "unavailable", reason: "clip_too_short", position: 2, may_start: true });
    expect(q.reason).toBe("clip_too_short");
    expect(q.position).toBe(2);
    expect(reasonText(q.reason, en.repurpose)).toMatch(/15 seconds/);
  });
});

describe("the database's refusals", () => {
  it("map to the route's answers without leaking anything but the person's own numbers", () => {
    expect(mapRepurposeError({ code: "42501", message: "forbidden" })).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(mapRepurposeError({ code: "NS402", message: "insufficient credits", details: "available=3 needed=8" })).toEqual({
      status: 402, body: { error: "insufficient_credits", needed: 8, available: 3 },
    });
    expect(mapRepurposeError({ code: "NS429", message: "parallel run limit reached", details: "active=1 limit=1" })).toEqual({
      status: 429, body: { error: "run_limit" },
    });
    expect(mapRepurposeError({ code: "NS409", message: "price_changed", details: "credits=12.50" })).toEqual({
      status: 409, body: { error: "price_changed", credits: 12.5 },
    });
    expect(mapRepurposeError({ code: "NS409", message: "in_progress" }).body).toEqual({ error: "in_progress" });
    expect(mapRepurposeError({ code: "NS409", message: "idempotency_conflict" }).body).toEqual({ error: "idempotency_conflict" });
    expect(mapRepurposeError({ code: "NS400", message: "unpriced" })).toEqual({ status: 409, body: { error: "unpriced" } });
    expect(mapRepurposeError({ code: "NS400", message: "clips_unavailable", details: "master_too_small" }).body).toEqual({
      error: "clips_unavailable", reason: "master_too_small",
    });
    expect(mapRepurposeError({ code: "NS400", message: "clips_unavailable", details: "weird; drop table" }).body).toEqual({
      error: "clips_unavailable", reason: "unknown",
    });
    expect(mapRepurposeError({ code: "22023", message: "price_required", details: "credits=8" }).body).toEqual({ error: "price_required", credits: 8 });
    expect(mapRepurposeError({ code: "22023", message: "invalid_clips" })).toEqual({ status: 400, body: { error: "invalid_clips" } });
    expect(mapRepurposeError({ code: "42883", message: "function does not exist" }).body).toEqual({ error: "repurpose_unavailable" });
    expect(mapRepurposeError({ code: "XX000", message: "relation secret_table exploded" })).toEqual({ status: 502, body: { error: "repurpose_failed" } });
  });

  it("read as sentences, never as a raw code or a provider's words", () => {
    const t = en.repurpose;
    expect(repurposeErrorText({ error: "insufficient_credits", needed: 8, available: 3 }, t)).toBe("Not enough credits: 8 needed, 3 available.");
    expect(repurposeErrorText({ error: "price_changed", credits: 12 }, t)).toContain("12 credits");
    expect(repurposeErrorText({ error: "run_limit" }, t)).toBe(t.errors.runLimit);
    expect(repurposeErrorText({ error: "unpriced" }, t)).toBe(t.unpriced);
    expect(repurposeErrorText({ error: "clips_unavailable", reason: "gate_blocked" }, t)).toBe(t.reasons.gate_blocked);
    expect(repurposeErrorText({ error: "queue_required" }, t)).toBe(t.errors.queueRequired);
    expect(repurposeErrorText({ error: "anything else" }, t)).toBe(t.errors.failed);
    expect(repurposeErrorText(null, t)).toBe(t.errors.failed);
  });
});

describe("the rows the page reads", () => {
  const reqRow = { id: "r1", status: "partial", clip_count: 3, quoted_credits: "12.00", charged_credits: "8.00", error_code: "cut_failed", created_at: "2026-10-02T10:00:00Z", finished_at: "2026-10-02T10:05:00Z" };
  const clipRows = [
    { request_id: "r1", ordinal: 2, first_scene: "s004", last_scene: "s004", start_s: "45.000", end_s: "70.000", duration_s: "25.000", status: "failed", clip_video_id: null, error_code: "cut_failed", captions: null },
    { request_id: "r1", ordinal: 1, first_scene: "s000", last_scene: "s000", start_s: "0.000", end_s: "20.000", duration_s: "20.000", status: "rendered", clip_video_id: "run-0123456789abcdef0123", error_code: null, captions: { youtube: { title: "T #Shorts" }, instagram: "c", tiktok: "c" } },
    { request_id: "other", ordinal: 1, first_scene: "s000", last_scene: "s000", start_s: 0, end_s: 20, duration_s: 20, status: "queued", clip_video_id: null, error_code: null, captions: null },
    { request_id: "r1", ordinal: 3, first_scene: "bad", last_scene: "s000", start_s: 0, end_s: 20, duration_s: 20, status: "queued" },
    { request_id: "r1", ordinal: 4, first_scene: "s000", last_scene: "s000", start_s: 0, end_s: 20, duration_s: 20, status: "teleported" },
  ];

  it("clips are joined to their request in order, and malformed rows are dropped", () => {
    const rows = parseRequestRows([reqRow, { id: "x", status: "odd", clip_count: 1 }, null], parseClipRows(clipRows));
    expect(rows).toHaveLength(1);
    expect(rows[0].clips.map((c) => [c.ordinal, c.status, c.clipVideoId])).toEqual([[1, "rendered", "run-0123456789abcdef0123"], [2, "failed", null]]);
    expect(rows[0].clips[0].captions).toEqual({ youtube: "T #Shorts", instagram: "c", tiktok: "c" });
    expect(rows[0].quotedCredits).toBe(12);
    expect(rows[0].chargedCredits).toBe(8);
  });

  it("an unreadable list is no requests", () => {
    expect(parseRequestRows(null)).toEqual([]);
    expect(parseClipRows({})).toEqual([]);
  });

  it("selects only columns a member may read", () => {
    for (const col of ["id", "status", "clip_count", "quoted_credits", "charged_credits"]) expect(REQUEST_COLUMNS).toContain(col);
    for (const bad of ["credit_ref", "idempotency_key", "request_hash", "worker_id", "unit_credits", "floor_credits", "sha256", "local_path"]) {
      expect(REQUEST_COLUMNS).not.toContain(bad);
      expect(CLIP_COLUMNS).not.toContain(bad);
    }
  });

  it("says what happened and what it cost", () => {
    const t = en.repurpose;
    const [r] = parseRequestRows([reqRow], parseClipRows(clipRows));
    expect(requestText(r, t)).toBe("1 of 3 clips made · 8 credits charged. The others were not charged.");
    expect(requestText({ ...r, status: "failed", errorCode: "master_too_small", clips: [] }, t)).toContain(t.failures.master_too_small);
    expect(requestText({ ...r, status: "succeeded", chargedCredits: null }, t)).toContain("clips made.");
    expect(requestText({ ...r, status: "queued" }, t)).toBe(t.status.queued);
    expect(requestText({ ...r, status: "running" }, t)).toContain("1 of 3");
    expect(failureText("something_new", t)).toBe(t.failures.failed);
    expect(clockText(125)).toBe("2:05");
    expect(clockText(-3)).toBe("0:00");
  });

  it("recognises a clip and its master from the hold detail only", () => {
    const clip = { hold_detail: { reason: "repurposed_clip", master_video_id: "run-0123456789abcdef0123" } };
    expect(isRepurposedClip(clip)).toBe(true);
    expect(clipMasterId(clip)).toBe("run-0123456789abcdef0123");
    expect(isRepurposedClip({ hold_detail: { reason: "gate" } })).toBe(false);
    expect(isRepurposedClip(null)).toBe(false);
    expect(clipMasterId({ hold_detail: { reason: "repurposed_clip", master_video_id: "../x" } })).toBeNull();
  });

  it("retention text says gained, held or lost, or not measured", () => {
    const t = en.repurpose;
    expect(scoreText({ score: 0.05, measured: true }, t)).toContain("5");
    expect(scoreText({ score: 0, measured: true }, t)).toBe(t.scoreHeld);
    expect(scoreText({ score: -0.1275, measured: true }, t)).toContain("12.8");
    expect(scoreText({ score: null, measured: false }, t)).toBe(t.scoreNotMeasured);
  });
});

describe("the words", () => {
  const sections = { en: en.repurpose, ru: ru.repurpose, uz: uz.repurpose } as const;

  function shape(v: unknown, prefix = ""): string[] {
    if (typeof v === "string") return [`${prefix}=${[...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",")}`];
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => shape(x, `${prefix}.${k}`));
  }

  it("en, ru and uz have the same keys and placeholders, with nothing empty", () => {
    expect(shape(sections.ru)).toEqual(shape(sections.en));
    expect(shape(sections.uz)).toEqual(shape(sections.en));
    for (const s of Object.values(sections)) expect(JSON.stringify(s)).not.toMatch(/:""/);
  });

  it("names no provider or model, and no owner, editor or viewer", () => {
    // The copy only (the values): a key like `ffmpeg_missing` is an identifier, never shown.
    const values = (v: unknown): string[] => (typeof v === "string" ? [v] : Object.values(v as Record<string, unknown>).flatMap(values));
    const text = values(sections).join("\n");
    for (const word of ["minimax", "higgsfield", "kling", "veo", "seedance", "wan ", "openai", "gemini", "elevenlabs", "pexels", "ffmpeg", "supabase", "paddle"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    for (const role of [/\bowners?\b/i, /\beditors?\b/i, /\bviewers? (of|can|may|role)/i]) expect(text).not.toMatch(role);
  });

  it("every reason the database can give has a sentence in every language", () => {
    const reasons = ["invalid_clips", "no_manifest", "scene_ids_not_unique", "scene_not_found", "invalid_range", "too_many_scenes", "scene_timing_unknown", "clip_too_short", "clip_too_long", "beyond_audio", "clips_overlap", "is_a_clip", "gate_blocked", "rejected", "no_run", "no_master", "master_too_small", "in_progress", "unknown"];
    for (const s of Object.values(sections)) {
      for (const r of reasons) expect((s.reasons as Record<string, string>)[r], r).toBeTruthy();
    }
    const failures = ["master_not_available", "master_too_small", "master_changed", "master_record_missing", "probe_failed", "cut_failed", "clip_invalid", "timeout", "disk_full", "ffmpeg_missing", "bad_clip_path", "worker_error", "hold_not_open", "job_ended", "not_rendered", "failed"];
    for (const s of Object.values(sections)) {
      for (const f of failures) expect((s.failures as Record<string, string>)[f], f).toBeTruthy();
    }
  });
});
