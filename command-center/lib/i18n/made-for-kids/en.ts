/**
 * YouTube's "made for kids" switch (components/review/MadeForKidsSwitch.tsx): on the review panel, where a person approves a
 * video, and on the Create form, where a run starts. English is the source: ru.ts and uz.ts are typed `MadeForKidsDictionary`.
 * The ru and uz sentences are machine drafts: have a native speaker read them.
 */
export const madeForKidsEn = {
  label: "Made for kids (YouTube requirement)",
  help: "When this is on, YouTube turns off comments, personalised ads, notifications and some other features on this video.",
  kidsNote: "This is kids content, so it is on. Turning it off needs your confirmation.",
  confirmTitle: "Declare this video not made for kids?",
  confirmBody:
    "It is kids content. YouTube's rules and children's privacy law (COPPA) require a video for children to be declared made for kids. Turn it off only if this video is not aimed at children.",
  confirmYes: "Yes, it is not made for kids",
  confirmNo: "Keep it on",
  saving: "Saving…",
  saved: "Saved.",
  createNote: "Applies to this run's video. Kids content is made for kids even when this is off.",
  notRecorded: "Not recorded for this video: it was uploaded before this setting existed. Check its audience in YouTube Studio.",
  confirmedOff: "Declared not made for kids; confirmed on {when}.",
  blockers: {
    already_public: "The video is public: change its audience in YouTube Studio.",
    approval_live: "Approved as it is. The audience can change when the approval runs out.",
    not_admin: "Only an administrator of this organization can change it.",
    not_member: "Only a member of this organization can change it.",
  },
  errors: {
    bad_value: "That value cannot be saved.",
    rate_limited: "Too many changes in a short time. Try again in a few minutes.",
    already_public: "The video is public: change its audience in YouTube Studio.",
    approval_live: "Approved as it is. The audience can change when the approval runs out.",
    confirm_required: "Turning it off needs your confirmation.",
    forbidden: "Only an administrator of this organization can change it.",
    not_found: "The video was not found.",
    failed: "Not saved. Try again.",
  },
};

export type MadeForKidsDictionary = typeof madeForKidsEn;
