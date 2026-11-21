/** The accounts kept on this device (the avatar menu's list and the sign-in page's "continue as"). lib/device-accounts.ts. */
export const deviceAccountsEn = {
  title: "Accounts on this device",
  current: "Current account",
  switchTo: "Switch to {name}",
  add: "Add account",
  limit: "This device keeps up to 3 accounts. Sign out of one to add another.",
  signInAgain: "Sign in again",
  expired: "Session ended",
  expiredMessage: "That account's session ended. Sign in to it again.",
  staleBelow: "Session ended · sign in with the form below",
  logOut: "Sign out",
  logOutOf: "Sign out of {name}",
  logOutAll: "Sign out of all accounts",
  working: "One moment…",
  loading: "Loading accounts…",
  loadFailed: "Could not load the accounts on this device.",
  retry: "Try again",
  failed: "That did not work. Try again.",
  unavailable: "The sign-in service did not answer. Try again.",
  mismatch: "That saved account was not valid and was removed. Sign in to it again.",
  changed: "The accounts on this device changed in another tab. Here they are as they are now.",
  notRevoked: "Removed from this device, but the sign-in service could not be reached to end that session. It ends on its own, or sign out of it on another device.",
  continueAs: "Continue as {name}",
  savedTitle: "Saved on this device",
};

export type DeviceAccountsDictionary = typeof deviceAccountsEn;
