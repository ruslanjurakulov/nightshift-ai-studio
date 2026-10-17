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
  signOutFailed: "Could not sign you out on this phone. Close the browser tab and try again.",
  // Alerts test
};

export type OwnerTruthDictionary = typeof ownerTruthEn;
