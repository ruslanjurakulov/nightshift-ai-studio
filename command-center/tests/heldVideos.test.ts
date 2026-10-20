import { describe, expect, it, vi } from "vitest";
import {
  HELD_STATES,
  UPLOADED_FILTER,
  HELD_CAUSES,
  heldCause,
  heldCauseNote,
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

describe("D1: an upload that failed is shown as that, with the fixed cause", () => {
  // What modules/held_video.py writes when the YouTube upload raised on a run that passed the gate.
  const failedUpload = {
    ...heldRow,
    publish_state: "held",
    hold_detail: { reason: "held", cause: "upload_failed", gate: { allowed: true, blocks: [], warnings: [], checks_run: [] } },
  };

  it("heldCause reads only the fixed word", () => {
    expect(heldCause(failedUpload)).toBe("upload_failed");
    expect(heldCause(heldRow)).toBeNull();
    expect(heldCause({ hold_detail: { cause: "HttpError: invalid_grant ya29.secret" } })).toBeNull();
    expect(heldCause({ hold_detail: "upload_failed" })).toBeNull();
    expect(heldCause(null)).toBeNull();
  });

  it("the label says upload failed + reconnect YouTube in every language, instead of 'auto-publish off'", () => {
    for (const d of [en, ru, uz]) {
      const label = heldStateLabel(heldState(failedUpload), d.held, heldCause(failedUpload));
      expect(label).toBe(d.held.stateUploadFailed);
      expect(label).not.toBe(d.held.stateHeld);
      expect(d.held.uploadFailedNote.length).toBeGreaterThan(20);
    }
    expect(en.held.stateUploadFailed).toBe("Finished, but the upload did not complete");
    expect(en.held.uploadFailedNote).toMatch(/expired channel connection/);
    // The note itself makes no claim about a preview: that sentence is shown separately, only when one exists.
    expect(en.held.uploadFailedNote).not.toMatch(/watch/i);
  });

  it("without the cause the label is unchanged", () => {
    expect(heldStateLabel("held", en.held, null)).toBe(en.held.stateHeld);
    expect(heldStateLabel("held", en.held)).toBe(en.held.stateHeld);
  });
});

describe("M12: each way the upload can be refused has its own word, label and sentence", () => {
  const causeRow = (cause: unknown) => ({
    ...heldRow,
    publish_state: "held",
    hold_detail: { reason: "held", cause, gate: { allowed: true, blocks: [], warnings: [], checks_run: [] } },
  });

  it("heldCause reads exactly the fixed words of modules/held_video.HOLD_CAUSES", () => {
    for (const word of ["upload_failed", "quota_exceeded", "upload_limit_exceeded", "token_expired"]) {
      expect(heldCause(causeRow(word))).toBe(word);
    }
    expect([...HELD_CAUSES]).toEqual(["upload_failed", "quota_exceeded", "upload_limit_exceeded", "token_expired"]);
    // Free text, a near miss or a non-string is never rendered.
    for (const bad of ["quotaExceeded", "QUOTA_EXCEEDED", "quota_exceeded ya29.secret", "", 3, null, {}, ["quota_exceeded"]]) {
      expect(heldCause(causeRow(bad))).toBeNull();
    }
  });

  it("every cause gets a different label and a different sentence in every language", () => {
    for (const d of [en, ru, uz]) {
      const labels = HELD_CAUSES.map((c) => heldStateLabel("held", d.held, c));
      expect(new Set(labels).size).toBe(HELD_CAUSES.length);
      for (const label of labels) expect(label).not.toBe(d.held.stateHeld);
      const notes = HELD_CAUSES.map((c) => heldCauseNote(c, d.held));
      expect(new Set(notes).size).toBe(HELD_CAUSES.length);
      for (const note of notes) expect((note ?? "").length).toBeGreaterThan(20);
    }
  });

  it("the quota sentence says it resets by itself; the connection sentence says reconnect", () => {
    expect(en.held.quotaExceededNote).toMatch(/resets by itself/);
    expect(en.held.tokenExpiredNote).toMatch(/Reconnect YouTube/);
    expect(en.held.quotaExceededNote).not.toMatch(/Reconnect/);
    expect(en.held.uploadLimitExceededNote).toMatch(/upload limit/);
  });

  it("no cause means no sentence", () => {
    expect(heldCauseNote(null, en.held)).toBeNull();
    expect(heldCauseNote(undefined, en.held)).toBeNull();
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
