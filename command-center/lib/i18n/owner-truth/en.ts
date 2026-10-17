/**
 * What the owner's screens say when something went wrong or is not known: a session that ended, an action that did
 * not go through, a read that failed. Each reason has its own sentence, because "try again" is the right advice for a
 * dropped connection and the wrong one for a signed-out session. English is the source of truth; ru.ts and uz.ts are
 * typed against it.
 */
export const ownerTruthEn = {
  // Why an owner action did not go through (lib/operator-post.ts kinds)
  sessionEnded: "Your session ended, so nothing was changed. Sign in again, then repeat this.",
  signInAgain: "Sign in again",
  mfaRequired: "Enter your authenticator code first (sign in again to be asked), then repeat this. Nothing was changed.",
  forbidden: "This account is not allowed to do that. Nothing was changed.",
  serverError: "The server could not do it. Try again in a minute.",
  notRecorded: "The server did not save it. Try again.",
  offline: "No connection to the server. Check your internet and try again.",
  checkBeforeRetry: "If you are not sure it went through, check the history before trying again.",
  // The bar shown on any owner page once an action finds the session gone
  sessionBar: "Your session ended. Sign in again to continue.",
  // Layout: access could not be checked (the database did not answer)
  accessErrorTitle: "Can’t reach the database",
  accessErrorBody: "We could not check your access just now. Your account is fine and nothing was changed. Try again.",
  accessErrorRetry: "Retry",
  accessErrorWorking: "Checking…",
  // Sign out
  signOutFailed: "Could not reach the server to sign you out. Try again when you are online.",
  testDeliveredNotSaved: "Delivered, but not saved to the feed. It will not show in the list below.",
  // Billing and the Command Center: what is unknown or cut is said, never shown as zero
  spendHorizon: "Spend is read back at most {n} days. A balance that depends on an older top-up shows as unknown.",
  noRowsYet: "no rows yet",
  lastSync: "last sync {when}",
  syncUnknown: "last sync unknown",
  basedOnDays: "based on the last {n} days",
  usedLastDays: "Used, last {n} days",
  spendPace: "Spend at this pace, 30 days",
  asOf: "as of {t}",
  billingReadFailed: "Part of the billing data could not be read. The figures that depend on it are shown as unknown, not as zero.",
  spendCut: "The spend history was cut at {n} rows: only the newest are counted, so spend and days left may be understated.",
  notTracked: "not tracked",
  autoRechargeOn: "tops itself up",
  noEventsYet: "nothing recorded yet",
  // Alerts test
};

export type OwnerTruthDictionary = typeof ownerTruthEn;
