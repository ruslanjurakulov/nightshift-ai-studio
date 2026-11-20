import { cueWarnings, type Cue } from "@/lib/captions";
import { ms } from "@/lib/editor";

export type CaptionReviewReason = "empty" | "out_of_order" | "past_end";

export interface CaptionReviewFlag {
  cueId: string;
  /** Zero-based position in the supplied list, which is never sorted. */
  index: number;
  reasons: CaptionReviewReason[];
}

/**
 * Review typed captions without repairing, trimming or persisting anything.
 * Times use the editor's existing millisecond precision. A cue must move
 * forward and not overlap an earlier cue; touching edges are allowed.
 * pictureEnd is the picture's end in seconds, as used by withinPicture.
 * This is advisory QA over typed cues, not a replacement document validator.
 */
export function reviewCaptions(cues: readonly Cue[], pictureEnd: number): CaptionReviewFlag[] {
  const flags: CaptionReviewFlag[] = [];
  const limit = ms(pictureEnd);
  let previousEnd = 0;
  cues.forEach((cue, index) => {
    const reasons: CaptionReviewReason[] = [];
    if (cueWarnings([cue])[cue.id] === "empty") reasons.push("empty");
    const start = ms(cue.start_s);
    const end = ms(cue.end_s);
    if (end <= start || start < previousEnd) reasons.push("out_of_order");
    if (start >= limit || end > limit) reasons.push("past_end");
    if (reasons.length) flags.push({ cueId: cue.id, index, reasons });
    previousEnd = Math.max(previousEnd, end);
  });
  return flags;
}
