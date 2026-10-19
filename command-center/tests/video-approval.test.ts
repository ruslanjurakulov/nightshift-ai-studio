/**
 * The decision the review panel offers (lib/videoApproval.ts, migration 0112): what the Approve key does for each state of a
 * video, and who may press it. The database decides everything again (approve_video_publish); this saves a press that would
 * come back refused and says why, so it must never offer what the database would refuse, and never say "approved" for a
 * cut that is not the one that was approved.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVE_REASONS,
  approvalState,
  accessFromWord,
  canPressApprove,
  knownApproveReason,
  shortHash,
  storedGate,
  studioUrl,
  type ApprovalFields,
} from "@/lib/videoApproval";
import { publishBlocker } from "@/lib/publish";

const CUT = "a".repeat(64);
const OTHER = "b".repeat(64);
const NOW = Date.parse("2026-10-19T12:00:00Z");
const HOUR = 3600_000;

function video(over: Partial<ApprovalFields> = {}): ApprovalFields {
  return {
    review_state: "pending",
    published_at: "2026-10-19T10:00:00Z",
    privacy: "private",
    publish_state: "uploaded",
    preview_path: "chan/vid.mp4",
    cut_sha256: CUT,
    gate_verdict: { allowed: true, blocks: [], warnings: ["thin_sources"], checks_run: ["rights"] },
    ...over,
  };
}
const open = { autoPublish: false, access: "ok" as const, nowMs: NOW };

describe("what the Approve key offers", () => {
  it("a normal uploaded private video with a stored passing verdict can be approved", () => {
    const s = approvalState(video(), open);
    expect(s.view.kind).toBe("open");
    expect(s.blocker).toBeNull();
    expect(canPressApprove(s)).toBe(true);
  });

  it("a held run (never uploaded) cannot, whatever else is true", () => {
    for (const publish_state of ["held", "blocked", "awaiting_approval", "repaired_awaiting_review"]) {
      const s = approvalState(video({ publish_state, published_at: null, privacy: null }), open);
      expect(s.blocker, publish_state).toBe("held");
      expect(canPressApprove(s)).toBe(false);
    }
  });

  it("a blocked gate verdict cannot be approved, including a pass that still lists blocks", () => {
    expect(approvalState(video({ gate_verdict: { allowed: false, blocks: ["rights"] } }), open).blocker).toBe("gate_blocked");
    expect(approvalState(video({ gate_verdict: { allowed: true, blocks: ["rights"] } }), open).blocker).toBe("gate_blocked");
  });

  it("no stored verdict is unknown, never a pass", () => {
    for (const gate_verdict of [null, undefined, {}, { allowed: "true" }, { allowed: 1 }, "allowed", []]) {
      expect(approvalState(video({ gate_verdict }), open).blocker, JSON.stringify(gate_verdict)).toBe("gate_unknown");
    }
  });

  it("a video recorded before 0112 (no hash, no verdict) says it cannot be approved here", () => {
    const s = approvalState(video({ cut_sha256: null, gate_verdict: null }), open);
    expect(s.blocker).toBe("gate_unknown");
    expect(approvalState(video({ cut_sha256: null }), open).blocker).toBe("cut_unknown");
  });

  it("rejected, no preview", () => {
    expect(approvalState(video({ review_state: "rejected" }), open).blocker).toBe("rejected");
    expect(approvalState(video({ preview_path: null }), open).blocker).toBe("no_preview");
  });

  it("the people who cannot press are told why: a viewer or editor, a platform admin on a customer's channel", () => {
    expect(approvalState(video(), { ...open, access: "not_admin" }).blocker).toBe("not_admin");
    expect(approvalState(video(), { ...open, access: "not_member" }).blocker).toBe("not_member");
    // a state reason is more useful than a role reason
    expect(approvalState(video({ preview_path: null }), { ...open, access: "not_admin" }).blocker).toBe("no_preview");
  });

  it("a channel that publishes on its own has nothing to approve; neither does a video approved with nobody behind it", () => {
    expect(approvalState(video(), { ...open, autoPublish: true }).view.kind).toBe("auto");
    expect(approvalState(video({ review_state: "approved" }), open).view.kind).toBe("auto");
    expect(canPressApprove(approvalState(video({ review_state: "approved" }), open))).toBe(false);
  });
});

describe("what an approval shows", () => {
  const approved = (over: Partial<ApprovalFields> = {}) =>
    video({
      review_state: "approved",
      approved_cut_sha256: CUT,
      decided_by_email: "anna@example.com",
      decided_at: new Date(NOW - 2 * HOUR).toISOString(),
      approval_expires_at: new Date(NOW + 22 * HOUR).toISOString(),
      ...over,
    });

  it("an approval of this cut that has not run out is approved, names who and when, and hides the key", () => {
    const s = approvalState(approved(), open);
    expect(s.view).toMatchObject({ kind: "approved", by: "anna@example.com" });
    expect(canPressApprove(s)).toBe(false);
  });

  it("an approval that ran out is expired, and approving again is offered", () => {
    const s = approvalState(approved({ approval_expires_at: new Date(NOW - 1000).toISOString() }), open);
    expect(s.view.kind).toBe("expired");
    expect(canPressApprove(s)).toBe(true);
  });

  it("the expiry is the stored one: no expiry stored reads as expired, never as forever", () => {
    expect(approvalState(approved({ approval_expires_at: null }), open).view.kind).toBe("expired");
    expect(approvalState(approved({ approval_expires_at: "not a date" }), open).view.kind).toBe("expired");
  });

  it("an approval of ANOTHER cut does not count: the video is waiting again", () => {
    const s = approvalState(approved({ approved_cut_sha256: OTHER }), open);
    expect(s.view.kind).toBe("open");
    expect(canPressApprove(s)).toBe(true);
    // and a video with no recorded cut is never shown as approved
    expect(approvalState(approved({ cut_sha256: null }), open).view.kind).not.toBe("approved");
  });

  it("an expired approval is still blocked by a blocker that arose since", () => {
    const s = approvalState(approved({ approval_expires_at: new Date(NOW - 1000).toISOString(), gate_verdict: { allowed: false } }), open);
    expect(s.view.kind).toBe("expired");
    expect(canPressApprove(s)).toBe(false);
  });
});

describe("who may press", () => {
  it("is the database's word, and anything else is no", () => {
    expect(accessFromWord("ok")).toBe("ok");
    expect(accessFromWord("not_member")).toBe("not_member");
    expect(accessFromWord("not_admin")).toBe("not_admin");
    for (const odd of ["not_found", "", null, undefined, 1, {}, "OK", "ok "]) expect(accessFromWord(odd), String(odd)).toBe("not_admin");
  });
});

describe("small helpers", () => {
  it("the stored gate is read defensively", () => {
    expect(storedGate(video())).toEqual({ allowed: true, blocks: [], warnings: ["thin_sources"] });
    expect(storedGate({ gate_verdict: { allowed: false, blocks: ["a", 3, "b"] } })).toEqual({ allowed: false, blocks: ["a", "b"], warnings: [] });
    expect(storedGate({ gate_verdict: null })).toBeNull();
    expect(storedGate(null)).toBeNull();
  });
  it("a short hash is ten characters of a real checksum, nothing else", () => {
    expect(shortHash(CUT)).toBe("aaaaaaaaaa");
    expect(shortHash("abc")).toBe("");
    expect(shortHash(null)).toBe("");
    expect(shortHash("A".repeat(64))).toBe("");
  });
  it("the Studio link is built only from a YouTube id", () => {
    expect(studioUrl("dQw4w9WgXcQ")).toBe("https://studio.youtube.com/video/dQw4w9WgXcQ/edit");
    expect(studioUrl("run-0123456789abcdef0123")).toBeNull();
    expect(studioUrl("x/../y")).toBeNull();
    expect(studioUrl(null)).toBeNull();
  });
  it("the reason words are the database's closed set", () => {
    expect(knownApproveReason("cut_changed")).toBe("cut_changed");
    expect(knownApproveReason("select * from videos")).toBeNull();
    expect(knownApproveReason(undefined)).toBeNull();
    expect(new Set(APPROVE_REASONS).size).toBe(APPROVE_REASONS.length);
  });
});

describe("the cross-post rail", () => {
  it("opens for an approved uploaded video on a channel that does not publish on its own, and stays closed before", () => {
    const base = { published_at: "2026-10-19T10:00:00Z", publish_state: "uploaded" };
    expect(publishBlocker({ ...base, review_state: "pending" })).toBe("not_approved");
    expect(publishBlocker({ ...base, review_state: "approved" })).toBeNull();
    expect(publishBlocker({ ...base, review_state: "rejected" })).toBe("rejected");
    expect(publishBlocker({ published_at: null, publish_state: "held", review_state: "approved" })).toBe("not_uploaded");
  });
});
