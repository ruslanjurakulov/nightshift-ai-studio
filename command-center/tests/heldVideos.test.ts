import { describe, expect, it, vi } from "vitest";
import {
  HELD_STATES,
  UPLOADED_FILTER,
  heldGate,
  heldOnly,
  heldState,
  heldStateLabel,
  isHeldVideo,
  isUploadedVideo,
  uploadedOnly,
} from "@/lib/heldVideos";
import { sceneRepairEligibility } from "@/lib/sceneRepair";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

// What modules/held_video.py writes for a run the gate blocked.
const heldRow = {
  video_id: "run-0123456789abcdef0123",
  channel_id: "news",
  slug: "the-lost-city",
  published_at: null,
  privacy: null,
  publish_state: "blocked",
  held_at: "2026-09-25T10:00:00+00:00",
  hold_detail: { reason: "blocked", gate: { allowed: false, blocks: ["fact_check"], warnings: ["qc_short"] } },
};

describe("held vs uploaded — one rule, with or without migration 0016", () => {
  it("a held row is held and not uploaded", () => {
    expect(isHeldVideo(heldRow)).toBe(true);
    expect(isUploadedVideo(heldRow)).toBe(false);
  });

  it("a held row written before 0016 (no publish_state) is still held", () => {
    const legacy = { published_at: null, privacy: null };
    expect(isHeldVideo(legacy)).toBe(true);
    expect(heldState(legacy)).toBe("unknown");
  });

  it("an uploaded row is never held — publish time, privacy or the promoted state is enough", () => {
    expect(isHeldVideo({ published_at: "2026-09-26T08:00:00", privacy: "private" })).toBe(false);
    expect(isHeldVideo({ published_at: null, privacy: "unlisted" })).toBe(false);
    expect(isHeldVideo({ published_at: "2026-09-26T08:00:00", privacy: null })).toBe(false);
    expect(isHeldVideo({ published_at: null, privacy: null, publish_state: "uploaded" })).toBe(false);
  });

  it("no row is neither", () => {
    expect(isHeldVideo(null)).toBe(false);
    expect(isUploadedVideo(undefined)).toBe(false);
  });
});

describe("the Regenerate scene button appears for a held row", () => {
  it("sceneRepairEligibility is repairable for exactly what the pipeline writes on a hold", () => {
    expect(sceneRepairEligibility(heldRow, [])).toEqual({ repairable: true });
    for (const publish_state of HELD_STATES) {
      expect(sceneRepairEligibility({ ...heldRow, publish_state })).toEqual({ repairable: true });
    }
  });

  it("is no longer repairable once that same row is promoted to its upload", () => {
    const promoted = { ...heldRow, video_id: "dQw4w9WgXcQ", published_at: "2026-09-26T08:00:00", privacy: "private", publish_state: "uploaded" };
    expect(sceneRepairEligibility(promoted)).toEqual({ repairable: false, reason: "uploaded" });
    // Even if only the state landed (a partial write), it is not offered.
    expect(sceneRepairEligibility({ published_at: null, privacy: null, publish_state: "uploaded" })).toEqual({
      repairable: false,
      reason: "uploaded",
    });
  });
});

describe("heldState / heldStateLabel / heldGate", () => {
  it("knows each state and never guesses an unknown one", () => {
    expect(heldState(heldRow)).toBe("blocked");
    expect(heldState({ publish_state: "published" })).toBe("unknown");
    expect(heldState({ publish_state: "uploaded" })).toBe("unknown");
    expect(heldStateLabel("awaiting_approval", en.held)).toBe(en.held.stateAwaitingApproval);
    expect(heldStateLabel("unknown", en.held)).toBe(en.held.stateUnknown);
  });

  it("reads the gate's recorded verdict, and null when none was recorded", () => {
    expect(heldGate(heldRow)).toEqual({ allowed: false, blocks: ["fact_check"], warnings: ["qc_short"] });
    expect(heldGate({ hold_detail: { reason: "repaired_awaiting_review" } })).toBeNull();
    expect(heldGate({ hold_detail: null })).toBeNull();
    expect(heldGate({ hold_detail: { gate: { allowed: "yes", blocks: [1, "x"] } } })).toEqual({
      allowed: false,
      blocks: ["x"],
      warnings: [],
    });
  });
});

describe("query helpers", () => {
  it("uploadedOnly asks for rows with a publish time or a privacy status", () => {
    const q = { or: vi.fn(() => "filtered") };
    expect(uploadedOnly(q)).toBe("filtered");
    expect(q.or).toHaveBeenCalledWith(UPLOADED_FILTER);
    expect(UPLOADED_FILTER).toBe("published_at.not.is.null,privacy.not.is.null");
  });

  it("heldOnly asks for rows with neither", () => {
    const calls: Array<[string, null]> = [];
    const q: { is: (c: string, v: null) => typeof q } = {
      is: (c, v) => {
        calls.push([c, v]);
        return q;
      },
    };
    heldOnly(q);
    expect(calls).toEqual([
      ["published_at", null],
      ["privacy", null],
    ]);
  });
});

describe("i18n", () => {
  it("has the held section in en/ru/uz with identical keys and no empty string", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(ru.held)).toEqual(keys(en.held));
    expect(keys(uz.held)).toEqual(keys(en.held));
    for (const d of [en, ru, uz]) {
      for (const v of Object.values(d.held)) expect(String(v).trim()).not.toBe("");
      expect(d.held.heldAt).toContain("{t}");
    }
  });
});
