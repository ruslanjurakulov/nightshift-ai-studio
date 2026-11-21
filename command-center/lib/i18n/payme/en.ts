/** Buying credits through Payme (Uzcard/Humo). English is the source of truth; ru.ts and uz.ts are typed against it. */
export const paymeEn = {
  title: "Pay with Uzcard or Humo",
  lead: "Top up through Payme. You pay in so'm on Payme's page, and your card details go only to Payme. Credits arrive when Payme confirms the payment.",
  testMode: "Payme test mode · no real charges",
  credits: "{credits} credits",
  buy: "Pay {price} with Payme",
  opening: "Opening Payme…",
  returned: "You're back from Payme. If the payment went through, the credits appear here within a minute.",
  failed: "Couldn't open Payme. Try again.",
  tooMany: "Too many payments opened today. Try again tomorrow.",
  notOnSale: "This pack isn't sold through Payme right now.",
};

export type PaymeDictionary = typeof paymeEn;
