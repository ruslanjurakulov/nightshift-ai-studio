/**
 * "Not available yet" for the Studio's tools (lib/tool-availability.ts): what the sidebar, the desk bar, Home, the create overview
 * and the Presets page say over a tool no model is on sale for, and where they point instead. English is the source; ru.ts and uz.ts
 * are typed against it.
 *
 * Wording rules: it says plainly that nothing is on sale (never "coming soon", never a date), it never names a model or a vendor,
 * and it always ends on something the person CAN do.
 */
export const availabilityEn = {
  notYet: "Not available yet",
  /** The accessible name of an inert row or card: the tool, then why it does nothing. */
  rowLabel: "{name}: not available yet",
  noneTitle: "Pictures, clips and voice-overs are not on sale yet",
  noneBody:
    "No model for these tools has passed its test and been priced yet, so there is nothing to buy here today. What works now: a full YouTube video for your channel, written, voiced and edited for you. It stays private until you decide.",
  noneCta: "Make a YouTube video",
  deskTitle: "Nothing on this desk is on sale yet",
  deskBody: "{tools}: no model has passed its test and been priced yet. A full YouTube video for your channel works today.",
  someClosed: "Not available yet on this desk: {tools}.",
  skipToPrompt: "Skip to the prompt",
};

export type AvailabilityDictionary = typeof availabilityEn;
