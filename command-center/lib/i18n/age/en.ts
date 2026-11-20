/** The 18+ confirmation (migration 0199). English is the source of truth; ru.ts and uz.ts are typed against it. */
export const ageEn = {
  title: "Confirm your age",
  body: "Nightshift is for adults (18+). Some of its models are allowed by their makers for adults only. Confirm once; your answer is recorded with the date.",
  consequence: "If you are under 18, creating is not available on this account. Your answer can't be changed here.",
  confirm: "I confirm I am 18 or older",
  under: "I am under 18",
  underSure: "Are you sure? Creating will be turned off on this account, and this answer can't be changed here.",
  underConfirm: "Yes, I am under 18",
  goBack: "Go back",
  saving: "Saving…",
  failed: "Couldn't save your answer. Try again.",
  unavailable: "Age confirmation isn't available right now. Try again later.",
  minorTitle: "Nightshift is for adults (18+)",
  minorBody: "You told us you are under 18, so creating is not available on this account. The models are not gone: the service is for adults only.",
  contact: "If this answer was a mistake, contact support.",
  contactNoEmail: "If this answer was a mistake, contact support through the Help or Contact page.",
  home: "Back to Home",
  done: "Thank you. Your confirmation is saved.",
  legal: "Your answer is your own statement. It is stored once and can't be changed here.",
};

export type AgeDictionary = typeof ageEn;
