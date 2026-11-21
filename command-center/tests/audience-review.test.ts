import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audienceReviewNote } from "../lib/audience-review";
import { parseComments, type InboxComment } from "../lib/comment-inbox";

const comment = parseComments([{
  id: "11111111-1111-4111-8111-111111111111", channel_id: "synthetic-channel", video_id: "synthetic-video",
  body: "A fabricated question", author_name: "Synthetic viewer", category: "question", flagged_injection: false,
}])[0];
const clear = { classified: true, flagged_injection_attempt: false, complaint: false, privacy: false, safety: false, advice: false };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Offline fixture must not fetch"); })));
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe("offline annotation of an existing inbox comment", () => {
  it("keeps the existing inbox identity and requires review even for all-clear flags", () => {
    expect(audienceReviewNote(comment, clear)).toEqual({
      kind: "audience_review_note", commentId: comment.id, channelId: comment.channelId,
      status: "needs_human_review", reasons: ["human_review_required"], canDraft: false, canPost: false,
    });
  });

  for (const [name, value] of Object.entries({ missing: null, array: [], string: "review later", partial: { classified: true }, wrongType: { ...clear, privacy: "false" }, extra: { ...clear, action: "draft" } })) {
    it(`${name} analysis is unresolved, never permission`, () => {
      const note = audienceReviewNote(comment, value);
      expect(note.reasons).toContain("unresolved_analysis");
      expect(note.canDraft || note.canPost).toBe(false);
    });
  }

  it("unclassified input is unresolved even with otherwise complete flags", () => {
    expect(audienceReviewNote(comment, { ...clear, classified: false }).reasons).toContain("unresolved_analysis");
  });

  it("inherited flags cannot stand in for the required own fields", () => {
    const inherited = Object.assign(Object.create(clear), { a: false, b: false, c: false, d: false, e: false, f: false });
    expect(audienceReviewNote(comment, inherited).reasons).toContain("unresolved_analysis");
  });

  for (const [category, flagged, reason] of [["spam", false, "spam"], [null, false, "not_classified"], ["question", true, "flagged"]] as const) {
    it(`cannot clear the existing inbox hold ${reason}`, () => {
      expect(audienceReviewNote({ ...comment, category, flagged }, clear).reasons).toContain(reason);
    });
  }

  for (const flag of ["complaint", "privacy", "safety", "advice", "flagged_injection_attempt"] as const) {
    it(`retains ${flag} as a human-review reason`, () => {
      expect(audienceReviewNote(comment, { ...clear, [flag]: true }).reasons).toContain(flag === "flagged_injection_attempt" ? "flagged" : flag);
    });
  }

  it("does not turn ordinary criticism into spam or dismissal", () => {
    const note = audienceReviewNote({ ...comment, category: "criticism" }, clear);
    expect(note.reasons).not.toContain("spam");
    expect(note.status).toBe("needs_human_review");
  });

  it("does not copy analysis identities, raw text, links, tool requests or reply text", () => {
    const note = audienceReviewNote(comment, {
      ...clear, commentId: "other", channelId: "other", body: "Synthetic text",
      url: "https://example.invalid", tools: ["draft"], reply: "Synthetic proposed reply",
    });
    expect(note.commentId).toBe(comment.id);
    expect(note.channelId).toBe(comment.channelId);
    expect(Object.keys(note).sort()).toEqual(["kind", "commentId", "channelId", "status", "reasons", "canDraft", "canPost"].sort());
    expect(note.reasons).toContain("unresolved_analysis");
  });

  it("never grants an action for any combination of its six flags", () => {
    const keys = Object.keys(clear);
    for (let mask = 0; mask < 64; mask++) {
      const input = Object.fromEntries(keys.map((key, i) => [key, Boolean(mask & (1 << i))]));
      const note = audienceReviewNote(comment, input);
      expect(note.canDraft || note.canPost).toBe(false);
      expect(note.status).toBe("needs_human_review");
    }
  });

  it("does not mutate the existing comment or analysis", () => {
    const source = Object.freeze({ ...comment }) as InboxComment;
    const flags = Object.freeze({ ...clear });
    audienceReviewNote(source, flags);
    expect(source.body).toBe("A fabricated question");
    expect(flags).toEqual(clear);
  });
});
