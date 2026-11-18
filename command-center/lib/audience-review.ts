import { heldReason, type InboxComment } from "./comment-inbox";

const FLAGS = ["classified", "flagged_injection_attempt", "complaint", "privacy", "safety", "advice"] as const;
export type AudienceReviewReason = "human_review_required" | "unresolved_analysis" | "spam" | "flagged" | "not_classified" | "complaint" | "privacy" | "safety" | "advice";

/** An annotation on an existing inbox comment, never another inbox or an approval. */
export interface AudienceReviewNote {
  kind: "audience_review_note";
  commentId: string;
  channelId: string;
  status: "needs_human_review";
  reasons: AudienceReviewReason[];
  canDraft: false;
  canPost: false;
}

/**
 * Offline only: the caller must already have read this comment through the
 * existing authorized inbox. Source IDs come from that read, never analysis.
 * Flags are untrusted hints; even an all-clear cannot authorize an action.
 * No audience text/author, proposed reply, tool or URL is copied to the annotation.
 */
export function audienceReviewNote(
  comment: Pick<InboxComment, "id" | "channelId" | "category" | "flagged">,
  analysis: unknown,
): AudienceReviewNote {
  const reasons: AudienceReviewReason[] = ["human_review_required"];
  const held = heldReason(comment);
  if (held) reasons.push(held);
  const record = analysis && typeof analysis === "object" && !Array.isArray(analysis)
    ? analysis as Record<string, unknown>
    : null;
  // Missing flags are unknown, not false. Extra fields cannot add authority.
  const valid = record !== null && Object.keys(record).length === FLAGS.length
    && FLAGS.every((key) => Object.prototype.hasOwnProperty.call(record, key) && typeof record[key] === "boolean");
  if (!valid || record?.classified !== true) reasons.push("unresolved_analysis");
  if (record?.flagged_injection_attempt === true && !reasons.includes("flagged")) reasons.push("flagged");
  for (const key of ["complaint", "privacy", "safety", "advice"] as const) {
    if (record?.[key] === true) reasons.push(key);
  }
  return {
    kind: "audience_review_note", commentId: comment.id, channelId: comment.channelId,
    status: "needs_human_review", reasons, canDraft: false, canPost: false,
  };
}
