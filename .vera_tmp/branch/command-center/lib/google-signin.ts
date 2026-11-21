/**
 * "Continue with Google": the decisions worth pinning, without React.
 *
 * Supabase Auth's Google provider does the OAuth (PKCE) round trip; the browser
 * lands on /auth/callback with a one-time `code` exactly like a sign-up
 * confirmation link does. Three things are ours:
 *
 *  1. Where Google sends the person back to (googleRedirectTo): this origin's
 *     callback, with a `next` that is only ever a path on this origin.
 *  2. A fixed error vocabulary. Whatever Google or Supabase said is never shown
 *     or echoed; /login?error=<one of GOOGLE_ERRORS> carries the outcome.
 *  3. The verified-email gate (googleGate), run on the server in the callback
 *     right after the code is exchanged: a session is kept only when Google
 *     itself vouches for the address.
 *
 * Account linking is Supabase's, not ours: an existing email+password user who
 * signs in with Google on the same VERIFIED address gets the Google identity
 * linked to the same user; a password account that was never confirmed has its
 * unconfirmed identity removed when that happens, which is what stops the
 * classic pre-account takeover (docs/GOOGLE_SIGNIN.md, "Security").
 */
import { safeLoginReturn } from "@/lib/safe-redirect";

export const GOOGLE_PROVIDER = "google";

/** Why /auth/callback sent someone back to /login after a Google attempt. */
export const GOOGLE_ERRORS = ["google_denied", "google_unverified", "google_failed"] as const;
export type GoogleError = (typeof GOOGLE_ERRORS)[number];

export function isGoogleError(value: string | null | undefined): value is GoogleError {
  return (GOOGLE_ERRORS as readonly string[]).includes(value ?? "");
}

/**
 * The URL Google's round trip ends on. `origin` is the browser's own (the one
 * the person is using is by definition the public one; the server-side helper
 * publicOrigin() reads APP_ORIGIN and exists for code that has no window).
 * `next` is attacker-writable (it comes from the page's address), so it is
 * validated here as well as again in the callback.
 */
export function googleRedirectTo(origin: string, rawNext: string | null | undefined, fallback: string): string {
  const url = new URL("/auth/callback", origin);
  url.searchParams.set("next", safeLoginReturn(rawNext, fallback));
  url.searchParams.set("provider", GOOGLE_PROVIDER);
  return url.toString();
}

/**
 * A callback that arrived with an error from Supabase or Google (the person
 * pressed Cancel, signup is closed, the provider is down …), mapped to our
 * fixed code. null when it is not a Google error, so the caller keeps its own
 * mapping for email links.
 */
export function googleCallbackError(params: URLSearchParams): GoogleError | null {
  const error = (params.get("error") ?? "").toLowerCase();
  const code = (params.get("error_code") ?? "").toLowerCase();
  // Our marker on redirectTo: this callback belongs to a Google attempt.
  const marked = params.get("provider") === GOOGLE_PROVIDER;
  if (code === "provider_email_needs_verification") return "google_unverified";
  // Cancel on Google's screen: access_denied with no more specific code. An
  // email link also says access_denied, but always with error_code=otp_expired
  // (or similar), and that stays the email link's own message.
  if (code === "access_denied" || (error === "access_denied" && (marked || !code))) return "google_denied";
  if (marked && (error || code)) return "google_failed";
  return null;
}

interface IdentityLike {
  provider?: string | null;
  identity_data?: { email_verified?: unknown } | null;
}

/** The slice of a Supabase user the gate reads. */
export interface GoogleUserLike {
  email_confirmed_at?: string | null;
  user_metadata?: { email_verified?: unknown } | null;
  identities?: IdentityLike[] | null;
}

/**
 * Keep the session only when Google vouches for the address.
 *
 * `fromGoogle` is whether the callback was told this was a Google attempt (our
 * marker on redirectTo). The marker is not trusted to switch the gate OFF: an
 * account that carries a Google identity is checked whichever way the code
 * arrived. Returns the error to send the person away with, or null to let them in.
 *
 * Strictly `=== true`: the string "true", 1 or a missing claim all fail. Both
 * halves are required — Google's own claim on its identity, and Supabase's
 * email_confirmed_at on the user (Supabase sets it only from a verified claim,
 * or after the provider-address confirmation mail).
 */
export function googleGate(user: GoogleUserLike | null | undefined, fromGoogle: boolean): GoogleError | null {
  if (!user) return fromGoogle ? "google_failed" : null;
  const identities = Array.isArray(user.identities) ? user.identities : null;
  const google = identities?.find((i) => i.provider === GOOGLE_PROVIDER) ?? null;
  if (!google && !fromGoogle) return null;
  // The identities are listed on the token response; if a deployment ever
  // omits them, the provider claim copied into user_metadata is the fallback.
  // A list that exists but has no Google identity in it is not a Google login.
  if (!google && identities) return "google_failed";
  const claim = google ? google.identity_data?.email_verified : user.user_metadata?.email_verified;
  if (claim !== true) return "google_unverified";
  if (!user.email_confirmed_at) return "google_unverified";
  return null;
}

/**
 * Is the Google provider switched on in this Supabase project?
 *
 * Supabase publishes which sign-in providers are enabled at
 * GET <project>/auth/v1/settings (public; it needs only the anon key the app
 * already ships). The button asks once and is shown only when the answer is a
 * clear `external.google === true`: an unconfigured project, a network error or
 * an odd answer all mean "no", so the page never offers a sign-in that cannot
 * work. Nothing about the answer is shown; the owner enables the provider in the
 * Supabase Dashboard and the button appears without a deploy.
 */
export function googleEnabledFromSettings(body: unknown): boolean {
  const external = (body as { external?: { google?: unknown } } | null)?.external;
  return external?.google === true;
}

/** One ask of the settings endpoint; any failure is "no". `init` lets the server add caching and a timeout. */
export function fetchGoogleEnabled(supabaseUrl: string, anonKey: string, init: RequestInit = {}): Promise<boolean> {
  if (!supabaseUrl || !anonKey) return Promise.resolve(false);
  return fetch(`${supabaseUrl.replace(/\/+$/, "")}/auth/v1/settings`, { ...init, headers: { apikey: anonKey } })
    .then((r) => (r.ok ? r.json() : null))
    .then(googleEnabledFromSettings)
    .catch(() => false);
}

let enabledCache: Promise<boolean> | null = null;

/** The browser's own ask (remembered for the page's life): the fallback when the server did not say. */
export function isGoogleEnabled(supabaseUrl: string, anonKey: string): Promise<boolean> {
  enabledCache ??= fetchGoogleEnabled(supabaseUrl, anonKey);
  return enabledCache;
}

/** For tests: forget the remembered answer. */
export function resetGoogleEnabledCache() {
  enabledCache = null;
}
