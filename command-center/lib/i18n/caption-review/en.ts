/** The editor's read-only caption review (components/editor/CaptionReviewHints.tsx). Source of truth for ./ru and ./uz. */
export const captionReviewEn = {
  title: "Caption review",
  note: "Suggestions only. Captions are unchanged.",
  cue: "Caption {n}",
  empty: "Add caption text.",
  out_of_order: "Check timing, order or overlaps.",
  past_end: "Check the caption against the picture’s end.",
  more: "{n} more captions to review.",
};

export type CaptionReviewDictionary = typeof captionReviewEn;
