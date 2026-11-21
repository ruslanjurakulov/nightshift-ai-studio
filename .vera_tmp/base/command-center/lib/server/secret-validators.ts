import { IMAGE_PROVIDERS } from "@/lib/imageProviders";
import { VIDEO_PROVIDERS } from "@/lib/runBackend";

/**
 * Per-name value checks for the write-only GitHub secret and variable routes
 * (docs/security/ADMIN_MFA.md, "Secrets and variables"; ledger BR-S-020).
 *
 * The routes used to accept any string for an allow-listed NAME. That let a
 * single typed value (a) redirect alerts (`ALERT_EMAIL_TO`, `SLACK_WEBHOOK_URL`),
 * (b) point the pipeline's Google OAuth refresh at another host (`token_uri` in a
 * token JSON), or (c) break every deploy, because deploy_web.yml writes some of
 * these into the server's env file and refuses a value with `$`, a line break or a
 * quote/` #` that docker compose would read as syntax (.github/workflows/deploy_web.yml,
 * deploy/build-service-env.py `clean`). A refused value costs the owner one retyped
 * field; an accepted bad one can cost a deploy.
 *
 * Pure and client-safe: no request, no network. A rejection carries a stable
 * `reason` and never the value (or any part of it).
 */

export type ValueReason =
  | "empty"
  | "too_long"
  | "control_chars"
  | "forbidden_chars"
  | "bad_shape"
  | "bad_url"
  | "bad_host"
  | "bad_email"
  | "bad_json"
  | "bad_choice";

export type ValueCheck = { ok: true; value: string } | { ok: false; reason: ValueReason };

const ok = (value: string): ValueCheck => ({ ok: true, value });
const no = (reason: ValueReason): ValueCheck => ({ ok: false, reason });

const CONTROL = /[\x00-\x1f\x7f]/;
/** What compose / the env-file builder reads as syntax. */
const ENV_SYNTAX = /[$`"'\\]/;

/** Hard ceilings, by kind. */
export const MAX_KEY_CHARS = 4096;
export const MAX_URL_CHARS = 300;
export const MAX_JSON_CHARS = 16_384;
export const MAX_EMAIL_CHARS = 254;
export const MAX_CHOICE_CHARS = 32;

/** A provider API key or access token: one token of printable ASCII, no whitespace, no env syntax. */
function checkToken(raw: string): ValueCheck {
  if (raw.length > MAX_KEY_CHARS) return no("too_long");
  if (CONTROL.test(raw)) return no("control_chars");
  if (!/^[\x21-\x7e]{8,}$/.test(raw)) return no("bad_shape");
  if (ENV_SYNTAX.test(raw)) return no("forbidden_chars");
  return ok(raw);
}

/** Slack incoming webhooks: https, Slack's own host, the `/services/T…/B…/…` path, nothing else. */
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
function checkSlackWebhook(raw: string): ValueCheck {
  if (raw.length > MAX_URL_CHARS) return no("too_long");
  if (CONTROL.test(raw) || /\s/.test(raw)) return no("control_chars");
  if (ENV_SYNTAX.test(raw)) return no("forbidden_chars");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return no("bad_url");
  }
  if (url.protocol !== "https:") return no("bad_url");
  if (url.username || url.password || url.port || url.search || url.hash) return no("bad_url");
  if (!SLACK_HOSTS.has(url.hostname)) return no("bad_host");
  if (!/^\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,64}$/.test(url.pathname)) return no("bad_shape");
  return ok(raw);
}

/** Resend API keys look like `re_` + a token. */
function checkResendKey(raw: string): ValueCheck {
  if (raw.length > MAX_KEY_CHARS) return no("too_long");
  if (CONTROL.test(raw)) return no("control_chars");
  return /^re_[A-Za-z0-9_]{8,200}$/.test(raw) ? ok(raw) : no("bad_shape");
}

/** A YouTube channel id: `UC` + 22 url-safe characters. */
function checkYoutubeChannelId(raw: string): ValueCheck {
  if (raw.length > 64) return no("too_long");
  return /^UC[A-Za-z0-9_-]{22}$/.test(raw) ? ok(raw) : no("bad_shape");
}

/** The only hosts a Google OAuth JSON may name as an endpoint the pipeline will send credentials to. */
const GOOGLE_OAUTH_HOSTS = new Set(["oauth2.googleapis.com", "accounts.google.com", "www.googleapis.com", "googleapis.com"]);
function isGoogleEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && GOOGLE_OAUTH_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * A Google OAuth JSON (client secret file or authorized-user token), as a JSON
 * object. The pipeline posts the refresh token and client secret to its
 * `token_uri`, so a document that names another host there would hand those to
 * whoever owns it: any endpoint named in the document must be Google's.
 *
 * The value WRITTEN is the compact form (`JSON.stringify(JSON.parse(raw))`): one
 * line, no pretty-printing. The worker env file builder (deploy/build-service-env.py
 * `clean()`) refuses a line break, `$` and ` #`, so a pasted pretty-printed token
 * would otherwise break a deploy. A compact document that still holds `$` or ` #`
 * (inside a string) is refused here for the same reason.
 */
function checkGoogleJson(raw: string, kind: "client" | "token"): ValueCheck {
  if (raw.length > MAX_JSON_CHARS) return no("too_long");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) return no("control_chars");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return no("bad_json");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return no("bad_json");
  const obj = doc as Record<string, unknown>;
  // Google writes a client file under exactly one of these two keys (modules/channel_credentials.py).
  const inner =
    kind === "client"
      ? (["installed", "web"] as const).map((k) => obj[k]).find((v) => v && typeof v === "object" && !Array.isArray(v))
      : obj;
  if (!inner || typeof inner !== "object") return no("bad_shape");
  const fields = inner as Record<string, unknown>;
  if (kind === "token" && !(typeof fields.refresh_token === "string" && fields.refresh_token.length > 0)) return no("bad_shape");
  if (kind === "client" && !(typeof fields.client_id === "string" && typeof fields.client_secret === "string")) return no("bad_shape");
  for (const key of ["token_uri", "auth_uri", "revoke_uri"]) {
    if (key in fields && !isGoogleEndpoint(fields[key])) return no("bad_host");
  }
  const compact = JSON.stringify(doc);
  if (compact.includes("$") || compact.includes(" #")) return no("forbidden_chars");
  return ok(compact);
}

/** One plain address: ASCII local part and a dotted domain with a real TLD. */
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
function isAddress(value: string): boolean {
  return value.length <= MAX_EMAIL_CHARS && ADDRESS.test(value) && !value.includes("..");
}

/** The alert recipient: exactly one address (no list, no display name). */
function checkEmailTo(raw: string): ValueCheck {
  if (raw.length > MAX_EMAIL_CHARS) return no("too_long");
  if (CONTROL.test(raw)) return no("control_chars");
  return isAddress(raw) ? ok(raw) : no("bad_email");
}

/** The alert sender: one address, or `Display Name <address>`. */
function checkEmailFrom(raw: string): ValueCheck {
  if (raw.length > MAX_EMAIL_CHARS) return no("too_long");
  if (CONTROL.test(raw)) return no("control_chars");
  const named = /^([A-Za-z0-9][A-Za-z0-9 ._-]{0,59}) <([^<>\s]+)>$/.exec(raw);
  if (named) return isAddress(named[2]) ? ok(raw) : no("bad_email");
  return isAddress(raw) ? ok(raw) : no("bad_email");
}

const FLAG_VALUES = new Set(["0", "1", "true", "false", "yes", "no", "on", "off"]);
function checkFlag(raw: string): ValueCheck {
  const v = raw.toLowerCase();
  return FLAG_VALUES.has(v) ? ok(v) : no("bad_choice");
}

function checkChoice(raw: string, choices: readonly string[]): ValueCheck {
  if (raw.length > MAX_CHOICE_CHARS) return no("too_long");
  const v = raw.toLowerCase();
  return choices.includes(v) ? ok(v) : no("bad_choice");
}

/**
 * The value to write for secret `name`, or why it is refused. `name` has
 * already passed the allow-list (isWritableSecretName); a name this function
 * does not know by shape gets the generic token rule, so a new provider key
 * needs no change here.
 */
export function validateSecretValue(name: string, raw: unknown): ValueCheck {
  if (typeof raw !== "string") return no("bad_shape");
  const value = raw.trim();
  if (!value) return no("empty");
  switch (name) {
    case "SLACK_WEBHOOK_URL":
      return checkSlackWebhook(value);
    case "RESEND_API_KEY":
      return checkResendKey(value);
    case "YOUTUBE_CHANNEL_ID":
      return checkYoutubeChannelId(value);
    case "YOUTUBE_CLIENT_SECRET_JSON":
      return checkGoogleJson(value, "client");
    case "YOUTUBE_TOKEN_JSON":
      return checkGoogleJson(value, "token");
    default:
      return name.startsWith("CHRONOS_YT_TOKEN_") ? checkGoogleJson(value, "token") : checkToken(value);
  }
}

/** The value to write for variable `name`, or why it is refused. `name` has passed isWritableVariable. */
export function validateVariableValue(name: string, raw: unknown): ValueCheck {
  if (typeof raw !== "string") return no("bad_shape");
  const value = raw.trim();
  // An empty value stays allowed: it is how a switch or an address is cleared, as before.
  if (!value) return ok("");
  if (CONTROL.test(value)) return no("control_chars");
  if (ENV_SYNTAX.test(value)) return no("forbidden_chars");
  switch (name) {
    case "ALERT_EMAIL_TO":
      return checkEmailTo(value);
    case "ALERT_EMAIL_FROM":
      return checkEmailFrom(value);
    case "CHRONOS_VIDEO_PROVIDER":
      return checkChoice(value, VIDEO_PROVIDERS);
    case "CHRONOS_IMAGE_PROVIDER":
      return checkChoice(value, IMAGE_PROVIDERS);
    default:
      return checkFlag(value);
  }
}
