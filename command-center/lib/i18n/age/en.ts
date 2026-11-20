/** The 18+ confirmation (migration 0199). English is the source of truth; ru.ts and uz.ts are typed against it. */
export const ageEn = {
  title: "Confirm your age",
  body: "Nightshift is for adults. Some of the models it offers are allowed by their makers for people 18 or older only. Confirm once; it is recorded with the date.",
  confirm: "I confirm I am 18 or older",
  under: "I am under 18",
  saving: "Saving…",
  failed: "Couldn't save your answer. Try again.",
  unavailable: "Age confirmation isn't available right now. Try again later.",
  minorTitle: "Nightshift is for adults (18+)",
  minorBody: "You told us you are under 18, so creating is not available on this account. The models are not gone: their makers' terms allow them for adults only. If this answer was a mistake, contact support.",
  done: "Thank you. Your confirmation is saved.",
  legal: "Your answer is your own statement. It is stored once and can't be changed here.",
};

export type AgeDictionary = typeof ageEn;
