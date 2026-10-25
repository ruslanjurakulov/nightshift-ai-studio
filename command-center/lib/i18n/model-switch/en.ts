/**
 * The owner's model switches (/{channel}/models?view=switch, migration 0124, docs/MODEL_SWITCH.md) and the one line the Studio shows over a
 * model that is temporarily off. English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` fillers are filled with fmt().
 *
 * Words to keep: the switch is TEMPORARY and OPERATIONAL. It never changes whether a model is on sale (that is the Availability view), it
 * never swaps in another model, and a person using the app is told "temporarily unavailable" and never the owner's reason. Counts are
 * written as "label: number", never as a noun after a number, so no language needs a plural form.
 */
export const modelSwitchEn = {
  viewSwitch: "Switches",
  title: "Model switches",
  subtitle:
    "Turn a provider, or one model, off while its vendor balance is empty or the vendor is down. People stop being offered it and cannot start it until you turn it on again. Nothing is ever replaced by another model.",
  off: {
    title: "Model switches are switched off",
    body: "The server switch NIGHTSHIFT_MODEL_SWITCH is not “on”, so this view reads nothing and no switch can be changed. Nothing was changed.",
  },
  ownerOnly: "Only the platform owner can use the model switches. Nothing was changed.",
  unsupported: "The database part of the model switches is not installed yet (migration 0124). Nothing was changed.",
  failed: "The switches could not be read, so nothing is shown rather than a guess. Try again.",
  notInForce: {
    title: "The switches are not in force",
    body: "Every model is available to everyone, and nothing here can be changed, until the switches are put in force in the database (model_availability_settings.enforced, set in the SQL editor: docs/MODEL_SWITCH.md). This is how the feature ships.",
  },
  inForce: "The switches are in force.",
  scope: { provider: "Provider", model: "Model" },
  status: {
    // "Not switched off", not "available": whether a model is on sale and priced is a different question (the sale state beside it).
    on: "Not switched off",
    hidden: "Hidden from users",
    hiddenByProvider: "Hidden from users: its provider is off",
    offNotInForce: "Recorded as off, but the switches are not in force, so people can still use it",
  },
  sale: {
    hidden: "not on sale",
    beta: "beta",
    ga: "on sale",
    disabled: "disabled",
  },
  saleNote: "A switch never changes whether a model is on sale (the Availability view does that).",
  providerHint: "Switching a provider off hides all of its models at once. A model you switch on does not override it.",
  pipelineNote:
    "Channel runs honour provider switches for video and image providers only, and only while the server switch is on. A model switch does not stop a channel run, and nothing here covers voice, sound effects and captions (ElevenLabs), transcription (AssemblyAI), Runway, Luma, xAI, stock footage or runs started from GitHub Actions. Jobs already sent to a vendor always finish.",
  models: "Models: {n}",
  hiddenModels: "Hidden: {n}",
  lastChanged: "Last changed by {who} on {when}",
  neverChanged: "Never switched",
  whoUnknown: "unknown",
  reasonLabel: "Why",
  reasons: {
    out_of_funds: "Out of funds at the vendor",
    vendor_outage: "Vendor outage",
    terms_review: "Terms under review",
    other: "Other",
  },
  reasonUnknown: "no reason recorded",
  noteLabel: "Short note (optional)",
  noteHint: "For you only: people never see it. Up to {max} characters. Never type a key or a password.",
  switchOff: "Switch off…",
  switchOn: "Switch on…",
  switchLabel: "{name}: {state}",
  stateOn: "on",
  stateOff: "off",
  form: {
    title: "Switch off {name}",
    cancel: "Cancel",
    review: "Review…",
  },
  confirmOff: {
    title: "Switch off {name}?",
    body: "People will no longer be offered it, and new requests for it are refused with “temporarily unavailable” until you switch it on. Nothing is replaced by another model.",
    waiting: "Jobs not yet sent to the vendor (stopped, credits returned)",
    inFlight: "Jobs already with the vendor (finish and are charged as usual)",
    modelsAffected: "Models switched off",
    confirm: "Switch off",
    previewFailed: "How many jobs this touches could not be read, so nothing was switched off. Try again.",
  },
  confirmOn: {
    title: "Switch on {name}?",
    body: "People are offered it again. Jobs that were stopped stay stopped: they start them again.",
    confirm: "Switch on",
  },
  done: {
    off: "Switched off. Jobs stopped: {stopped}. Already with the vendor: {inFlight}.",
    on: "Switched on.",
    onStillHidden: "Switched on, but its provider is still off, so it stays hidden.",
    stillWaiting: "Still waiting: {remaining}. None of them can be sent: each is stopped with its credits returned as soon as a worker reaches it.",
    sweepInterrupted: "It is switched off, but stopping the waiting jobs was interrupted. None of them can be sent: each is stopped with its credits returned as soon as a worker reaches it.",
  },
  alerts: {
    title: "Alerts",
    none: "No alerts.",
    line: "{provider} may be out of funds: {failures} jobs failed with a spent balance or quota in the last {minutes} minutes.",
    note: "This is a suggestion only. Nothing was switched off.",
    dismiss: "Dismiss",
    dismissed: "Dismissed.",
    on: "Alert on a likely empty balance: on ({failures} failures in {minutes} minutes).",
    off: "Alert on a likely empty balance: off.",
  },
  log: {
    title: "Recent changes",
    empty: "No changes yet.",
    when: "When",
    who: "Who",
    change: "Change",
    why: "Why",
    stopped: "Jobs stopped",
    on: "switched {scope} {target} on",
    offLine: "switched {scope} {target} off",
    settings: "changed the switch settings in the database",
    dismissedLine: "dismissed the alert for {target}",
    system: "SQL editor",
  },
  err: {
    mfa_required: "Confirm your authenticator code again (sign in and type the code), then retry. Nothing was changed.",
    rate_limited: "Too many requests. Wait a few minutes and retry. Nothing was changed.",
    owner_required: "Only the platform owner can switch models. Nothing was changed.",
    not_enforced: "The switches are not in force on this deployment. Nothing was changed.",
    bad_scope: "Choose a provider or a model. Nothing was changed.",
    bad_enabled: "The request did not say on or off. Nothing was changed.",
    unknown_target: "That model or provider is not in the registry any more. Reload the page. Nothing was changed.",
    bad_reason: "Choose why you are switching it off. Nothing was changed.",
    bad_note: "The note is at most {max} characters on one line. Nothing was changed.",
    confirm_required: "Confirm the switch-off first. Nothing was changed.",
    no_such_alert: "That alert is already dismissed or gone. Reload the page.",
    unauthorized: "You are signed out. Sign in again.",
    forbidden: "Only the platform owner can switch models. Nothing was changed.",
    migration_missing: "The database part of the model switches is not installed yet (migration 0124). Nothing was changed.",
    not_found: "Model switches are switched off on this server. Nothing was changed.",
    bad_request: "The request was not understood. Reload the page. Nothing was changed.",
    bad_reply: "The database answered with something this page does not understand. Reload the page and check before you retry.",
    rpc_failed: "The database could not be reached. Nothing was changed. Try again.",
    not_configured: "The database is not configured. Nothing was changed.",
    unknown: "The switch was refused ({code}). Nothing was changed.",
  },
  /** The Studio: over a model a form came with (a retried job, a link from the catalog) that is switched off. */
  studio: {
    offTitle: "This model is temporarily unavailable",
    offBody: "It is switched off for now, so nothing was started or charged. Choose another model to go on.",
    offChoose: "Choose another model",
  },
};

export type ModelSwitchDictionary = typeof modelSwitchEn;
