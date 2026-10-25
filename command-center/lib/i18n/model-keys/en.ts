/**
 * The "Model API keys" page (/{channel}/model-keys): the owner pastes a vendor's API key, the server checks it with the vendor and FORGETS it.
 * English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` fillers are filled with fmt().
 *
 * Words to keep: "API verified" is said only when the vendor itself accepted the key on a free request, and always with "the key was not
 * saved". "Format only" is a weaker claim and is always said as one. Nothing is stored anywhere: a verified key reaches a run only when the
 * owner adds it to GitHub Actions secrets and the worker environment under the name the card shows.
 */
export const modelKeysEn = {
  title: "Model API keys",
  subtitle: "Paste a vendor's API key to see whether the vendor accepts it. The key is checked and then forgotten: nothing is stored.",
  nothingStored: "Nothing is stored. The key is checked with the vendor and dropped; it is not saved, logged or shown again.",
  off: {
    title: "Model API keys are switched off",
    body: "The server switch NIGHTSHIFT_MODEL_KEYS is not “on”, so this page reads nothing and no key can be checked. Nothing was changed.",
  },

  status: {
    not_checked: "Not checked",
    checking: "Checking…",
    verified: "API verified",
    rejected: "Rejected by vendor",
    format_only: "Format only",
    could_not_reach: "Could not reach vendor — retry",
  },

  card: {
    getKey: "Get a key",
    getKeyHint: "Opens the vendor's own page in a new tab.",
    linkUnverified: "Key page link unverified — find it in the vendor's own console.",
    docs: "Vendor docs",
    howHttp: "Checked with one free request that creates nothing: GET {path} on {host}.",
    howFormat: "No free check is known for this vendor. The key is never sent to the vendor from here; only its shape is checked.",
    formatOnlyNote: "Key format looks right; cannot be verified without a paid call.",
    pairedHint: "This vendor signs requests with two parts. Paste them as access_key:secret_key.",
    keyLabel: "API key",
    verify: "Verify",
    useIt: "Nothing is stored. To use a verified key, add it to GitHub Actions secrets and the worker environment as {names}.",
  },

  verdict: {
    verified: "API verified at {time}. The key was not saved.",
    format_only: "Format only, at {time}. The vendor did not check this key, and it was not saved.",
    rejected: "The vendor did not accept this key (at {time}). The key was not saved.",
    rejectedScoped: "A key limited to some endpoints can also be refused by this check.",
    rejectedRegion: "This check uses the vendor's Singapore endpoint; a valid key of another region is refused there.",
    couldNotReach: "The vendor could not be checked (at {time}). The key was not saved. Try again in a moment.",
  },
  reason: {
    timeout: "The vendor did not answer in time.",
    network: "The connection to the vendor failed.",
    rate_limited: "The vendor says there were too many requests.",
    vendor_error: "The vendor had an error on its side.",
    redirect: "The vendor answered with a redirect, which is never followed.",
    unexpected_response: "The vendor's answer was not what its documentation describes, so it was not judged.",
  },

  source: {
    label: "Key used by runs",
    env: "The GitHub secret {names} is set. Runs use that key.",
    none: "The GitHub secret {names} is not set. Runs that need this vendor stop before they spend anything.",
    unknown: "Could not read the GitHub secret names (GitHub is not configured or did not answer), so this page does not say.",
  },

  err: {
    unauthorized: "Your session ended. Sign in again.",
    forbidden: "Only the platform owner can check a vendor key here.",
    mfa_required: "Confirm your authenticator code again (sign in and type the code), then retry.",
    mfa_recent_required: "Type your authenticator code again (sign out and in), then retry.",
    mfa_enrol_required: "Add an authenticator on the Security page first.",
    rate_limited: "Too many attempts. Wait a few minutes and retry.",
    not_found: "This feature is switched off on the server.",
    bad_request: "That request was not understood.",
    unknown_provider: "That vendor is not in the list.",
    bad_key: "That is not a key shape this page checks.",
    verify_failed: "The check could not be run. The key was not saved.",
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
