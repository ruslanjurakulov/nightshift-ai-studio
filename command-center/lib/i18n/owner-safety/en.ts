/**
 * Money and access safety for the platform owner: the confirm sheets (price,
 * credit grant, team, top-up, provider key, routing, 2FA), their toasts and the
 * "you cannot do that here" notes. English is the source of truth; ru.ts and
 * uz.ts are typed against it. `{name}` style fillers are filled with fmt().
 */
export const ownerSafetyEn = {
  // Shared by every sheet
  confirmWorking: "Working…",
  actionFailed: "That did not go through and nothing was changed. Check your connection and try again.",
  typeToConfirm: "To go ahead, type {word}",
  // Credit prices
  priceDeleteTitle: "Delete the price of “{name}”?",
  priceDeleteBody:
    "This service becomes unpriced for every customer. Runs that depend on it may stop being estimated or started until you set a price again.",
  priceDeleteConfirm: "Delete price",
  priceDeleted: "Price deleted: {name}.",
  priceSetTitle: "Set a price for “{name}”?",
  priceChangeTitle: "Change the price of “{name}”?",
  priceSaveBody: "Every customer is charged this rate from the next run on.",
  priceSaveConfirm: "Save price",
  priceSaved: "Price saved: {name}.",
  dService: "Service",
  dRate: "Credits per unit",
  dMargin: "Markup",
  dCharged: "Customer pays per unit",
  // Granting credits
  grantTitle: "Give {credits} {unit} to “{org}”?",
  grantBody: "The credits are added to their balance at once. The app has no undo for this.",
  grantConfirm: "Give credits",
  grantDone: "{credits} {unit} given to “{org}”.",
  checkLedger: "If the connection dropped, check the credit history on this page before trying again: it may have gone through.",
  dOrg: "Organization",
  dCredits: "Credits",
  dCost: "Approximate cost",
  costAbout: "about {usd}",
  // Team
  memberAddTitle: "Give {email} the role “{role}”?",
  memberAddBody: "They can sign in with this email and use the access below right away. New role: {cap}",
  memberAddConfirm: "Add person",
  memberAdded: "{email} added as {role}.",
  memberRemoveTitle: "Remove {email} from the team?",
  memberRemoveBody: "They lose access right away. You can invite them again later.",
  memberRemoveConfirm: "Remove person",
  memberRemoved: "{email} removed.",
  roleChangeTitle: "Change the role of {email}?",
  roleChangeBody: "Their access changes right away. New role: {cap}",
  roleChangeConfirm: "Change role",
  roleChanged: "{email} is now: {role}.",
  dPerson: "Person",
  dRole: "Role",
  blockSelf:
    "You cannot change or remove your own access here. Ask another owner to do it, so you are never locked out.",
  blockLast: "This is the only owner. Make someone else an owner first.",
  // Provider top-ups
  topupTitle: "Record {amount} paid to {provider}?",
  topupBody:
    "The payment is added to the balance ledger. Record only money that really left your card: a wrong entry cannot be removed in the app.",
  topupConfirm: "Record payment",
  topupDone: "Recorded {amount} for {provider}.",
  dProvider: "Provider",
  dAmount: "Amount",
  dDate: "Date",
  settingFailed: "Could not save that setting. It was put back.",
  // Provider keys
  keyReplaceTitle: "Replace the key of {name}?",
  keyReplaceBody:
    "The stored key is overwritten and cannot be read back. If the new key is wrong, {name} stops working in the pipeline.",
  keyReplaceConfirm: "Replace key",
  keyEnds: "ends with {tail}",
  dNewKey: "New key",
  keyInvalid: "That does not look like a key. Remove any spaces and paste the whole key.",
  // Pipeline routing
  routeAutopilotTitle: "Turn on autopilot?",
  routeAutopilotBody: "From now on Nightshift picks each day's topic by itself, without asking you first.",
  routeAutopilotConfirm: "Turn on autopilot",
  routeSwitchTitleVideo: "Switch the video generator to “{name}”?",
  routeSwitchTitleImage: "Switch the image generator to “{name}”?",
  routeSwitchBody: "The next run renders with it.",
  routeSwitchKeyMissing: "It has no key yet, so the pipeline uses stock footage until you add one.",
  routeSwitchConfirm: "Switch generator",
  dNow: "Now",
  dNew: "New",
  routeNotSaved: "Not saved. The setting stays as it was.",
  // Two-factor sign-in
  factorRemoveTitle: "Remove “{name}”?",
  factorUnverifiedBody: "This authenticator was never finished, so removing it changes nothing about how you sign in.",
  factorLastTitle: "Remove your last authenticator?",
  factorLastBody: "After this only the password protects this account. Anyone who learns the password can sign in.",
  factorLastWord: "REMOVE",
  factorRemoved: "Authenticator removed.",
  removeFailed: "Could not remove the authenticator. Nothing was changed.",
  readFailed: "Could not read your authenticators just now. Your protection has not changed. Try again.",
  levelUnknown: "Unknown",
  openApp: "Open in authenticator app",
  openAppHint: "On this phone? Tap to add the account to your authenticator app. On another device, scan the code.",
  copySecret: "Copy key",
  copiedSecret: "Copied",
  cancelEnroll: "Cancel",
  cancelFailed: "Could not cancel the setup. The unfinished authenticator is listed below: remove it there.",
  enrollCancelled: "Setup cancelled.",
};

export type OwnerSafetyDictionary = typeof ownerSafetyEn;
