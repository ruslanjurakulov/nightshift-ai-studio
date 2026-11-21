/** The accounts kept on this device (the avatar menu's list and the sign-in page's "continue as"). lib/device-accounts.ts. */
export const deviceAccountsEn = {
  title: "Accounts on this device",
  current: "Current account",
  switchTo: "Switch to {name}",
  add: "Add account",
  limit: "This device keeps up to 3 accounts. Log out of one to add another.",
  signInAgain: "Sign in again",
  expired: "Session ended",
  logOut: "Log out",
  logOutOf: "Log out of {name}",
  logOutAll: "Log out of all accounts",
  working: "One moment…",
  loading: "Loading accounts…",
  loadFailed: "Could not load the accounts on this device.",
  retry: "Try again",
  failed: "That did not work. Try again.",
  unavailable: "The sign-in service did not answer. Try again.",
  mismatch: "That saved account was not valid and was removed. Sign in to it again.",
  continueAs: "Continue as {name}",
  savedTitle: "Saved on this device",
};

export type DeviceAccountsDictionary = typeof deviceAccountsEn;
