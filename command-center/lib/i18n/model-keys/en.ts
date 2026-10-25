/**
 * The "Model API keys" page (/{channel}/model-keys, migration 0123): the owner pastes a vendor's API key, the server checks it with the
 * vendor, and a key the vendor accepted is kept in Vault. English is the source of truth; ru.ts and uz.ts are typed against it.
 * `{name}` fillers are filled with fmt().
 *
 * Words to keep: "API verified" is said only when the vendor itself accepted the key on a free request. "Format only" is a weaker claim and is
 * always said as one. A key stored here is NOT what a run uses: runs read their keys from the environment (GitHub secrets).
 */
export const modelKeysEn = {
  title: "Model API keys",
  subtitle: "Paste a vendor's API key. The server checks it with the vendor and keeps it in Vault only if the vendor accepts it.",
  vaultNote:
    "Keys are stored encrypted in Vault. Runs still read their keys from the environment (GitHub secrets): a key stored here does not change which key a run uses.",
  off: {
    title: "Model API keys are switched off",
    body: "The server switch NIGHTSHIFT_MODEL_KEYS is not “on”, so this page reads nothing and no key can be saved. Nothing was changed.",
  },
  unsupported: "The database part of this page is not installed yet (migration 0123). Nothing was changed.",
  failed: "The stored keys could not be read, so nothing is shown rather than a guess. Try again.",
  retry: "Try again",

  status: {
    not_set: "Not set",
    checking: "Checking…",
    verified: "API verified",
    rejected: "Rejected by vendor",
    format_only: "Format only",
    unreachable: "Could not reach vendor — retry",
  },

  card: {
    storedKey: "Stored key",
    verifiedOn: "Checked with the vendor on {date}.",
    formatOnlyOn: "Saved on {date} without a check by the vendor.",
    getKey: "Get a key",
    getKeyHint: "Opens the vendor's own page in a new tab.",
    linkUnverified: "Key page link unverified — find it in the vendor's own console.",
    docs: "Vendor docs",
    howHttp: "Checked with one free request that creates nothing: GET {path} on {host}.",
    howFormat: "No free check is known for this vendor. The key is never sent to the vendor from here; only its shape is checked.",
    formatOnlyNote: "Key format looks right; cannot be verified without a paid call.",
    formatOnlyConfirm: "I understand: this key is saved without the vendor having accepted it.",
    pairedHint: "This vendor signs requests with two parts. Paste them as access_key:secret_key.",
    keyLabel: "API key",
    verifyAndSave: "Verify and save",
    saveUnverified: "Save without verifying",
    remove: "Remove",
    removeAsk: "Remove the stored key from Vault?",
    removeYes: "Yes, remove",
    cancel: "Cancel",
    busy: "Working…",
  },

  source: {
    label: "Key used by runs",
    env: "Environment: the GitHub secret {names} is set. Runs use that key.",
    envAlsoVault: "A key is also stored here; runs use the environment key, not this one.",
    vault: "Stored here only. Runs do not read Vault yet, so no run uses this key.",
    none: "No key anywhere. Runs that need this vendor stop before they spend anything.",
    unknown: "Could not read the environment (GitHub is not configured or did not answer), so this page does not say.",
  },

  result: {
    verified: "API verified and saved.",
    format_only: "Saved. Format only: the vendor did not check this key.",
    rejected: "The vendor did not accept this key. Nothing was saved and the stored key, if any, is unchanged.",
    rejectedScoped: "A key limited to some endpoints can also be refused by this check.",
    rejectedRegion: "This check uses the vendor's Singapore endpoint; a valid key of another region is refused there.",
    unreachable: "The vendor could not be checked. Nothing was saved. Try again in a moment.",
    removed: "Removed. The key is deleted from Vault.",
  },
  unreachableReason: {
    timeout: "The vendor did not answer in time.",
    network: "The connection to the vendor failed.",
    rate_limited: "The vendor says there were too many requests.",
    vendor_error: "The vendor had an error on its side.",
    redirect: "The vendor answered with a redirect, which is never followed.",
    unexpected_response: "The vendor's answer was not what its documentation describes, so it was not judged.",
  },

  err: {
    unauthorized: "Your session ended. Sign in again.",
    forbidden: "Only the platform owner can store or remove a vendor key.",
    mfa_required: "Confirm your authenticator code again (sign in and type the code), then retry.",
    mfa_recent_required: "Type your authenticator code again (sign out and in), then retry.",
    mfa_enrol_required: "Add an authenticator on the Security page first.",
    rate_limited: "Too many attempts. Wait a few minutes and retry.",
    not_found: "This feature is switched off on the server.",
    bad_request: "That request was not understood.",
    unknown_provider: "That vendor is not in the list.",
    bad_key: "That is not a key shape this page stores.",
    confirm_required: "Tick the box to confirm that this key is saved without being verified.",
    migration_missing: "The database part is not installed yet (migration 0123).",
    store_failed: "The vendor accepted the key but it could not be saved. Try again.",
    verify_failed: "The check could not be run. Nothing was saved.",
    rpc_failed: "The key could not be saved. Try again.",
    not_configured: "The server has no database configured.",
    network: "No answer from the server. Check your connection.",
    server: "The server could not do that. Try again.",
    session: "Your session ended. Sign in again.",
  },
  keyReason: {
    empty: "Paste a key first.",
    too_short: "That is too short to be an API key.",
    too_long: "That is too long to be an API key.",
    bad_shape: "A key is one piece of letters, digits and symbols, with no spaces and none of $ ` \" ' \\.",
    bad_pair: "Paste both parts as access_key:secret_key.",
  },
};

export type ModelKeysDictionary = typeof modelKeysEn;
