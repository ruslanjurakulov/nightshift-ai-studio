/**
 * Private review links: the panel the video's maker uses to share a preview
 * (`reviewLink`) and the page the link opens (`reviewPage`). English is the
 * source of truth; ru.ts and uz.ts are typed against it.
 *
 * Plain words only: no price, no refund and no promise about what a viewer can
 * or cannot do beyond what the link really allows (view the preview copy).
 */
export const reviewLinkEn = {
  title: "Share a preview",
  intro:
    "Make a private link to the preview copy of this video. Anyone who has the link can watch it without an account, until it expires or you turn it off. The link shows this preview only: it cannot download the original, approve or publish.",
  expiryLabel: "The link works for",
  days: { d1: "1 day", d3: "3 days", d7: "7 days", d14: "14 days", d30: "30 days" },
  create: "Create link",
  creating: "Creating…",
  newTitle: "Your new link",
  newNote: "Copy it now. It is shown only once. If you lose it, turn it off and make a new one.",
  linkField: "Preview link",
  dismiss: "Done",
  listTitle: "Links for this video",
  loading: "Loading links…",
  empty: "No links yet.",
  loadFailed: "The links could not be loaded.",
  retry: "Try again",
  state: { live: "Active", expired: "Expired", revoked: "Turned off" },
  made: "Made {when}",
  until: "until {when}",
  views: "Views: {n}",
  revoke: "Turn off",
  revoking: "Turning off…",
  revokeLabel: "Turn off the link made {when}",
  errors: {
    unauthorized: "Sign in again to continue.",
    forbidden: "This page could not confirm the request. Reload and try again.",
    bad_request: "That request was not valid.",
    not_found: "You can't share this video.",
    no_preview: "The preview copy of this video is no longer kept, so there is nothing to share.",
    limit_reached: "This video already has the most active links allowed. Turn one off first.",
    rate_limited: "Too many requests. Try again in a few minutes.",
    not_available: "Sharing a preview is not available yet.",
    failed: "That did not work. Try again.",
  },
};

export type ReviewLinkDictionary = typeof reviewLinkEn;

export const reviewPageEn = {
  badge: "Preview",
  untitled: "Untitled video",
  videoLabel: "Video preview",
  note: "This is a preview copy for review. It is not the final file, and its quality can be lower than the finished video.",
  viewOnly: "View only: this page has no approve, publish or download buttons.",
  until: "This link works until {when}.",
  goneTitle: "This link isn't available",
  goneBody: "It may have expired or been turned off. Ask the person who sent it to you for a new link.",
  limitedTitle: "Too many views right now",
  limitedBody: "Wait a minute, then reload this page.",
  unavailableTitle: "The preview can't be shown right now",
  unavailableBody: "Try again in a moment.",
};

export type ReviewPageDictionary = typeof reviewPageEn;
