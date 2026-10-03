import { randomUUID } from "node:crypto";
import { Client, DEFAULT_BASE_URL, normalizeBaseUrl } from "../client.js";
import { readCredentials } from "../config.js";
import { CliError, EXIT, hintFor, usageError } from "../errors.js";

export const KEY_RE = /^nsk_live_[0-9A-Za-z]{43}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_:.-]{1,255}$/;

/** Options every command accepts. */
export const GLOBAL_OPTIONS = {
  json: { type: "boolean", help: "Print machine-readable JSON on stdout (errors too). No other text." },
  "base-url": { type: "string", arg: "URL", help: "API origin (default https://nightshift-ai.studio; env NIGHTSHIFT_BASE_URL)." },
  debug: { type: "boolean", help: "Print each request line and status to stderr. The key is never printed." },
  help: { type: "boolean", short: "h", help: "Show help for this command." },
};

export function checkKey(key) {
  if (!KEY_RE.test(key))
    throw new CliError("invalid_api_key", 'That is not a Nightshift API key. Keys start with "nsk_live_" and are made in Developers > API keys.', {
      exit: EXIT.AUTH,
    });
}

/** --base-url, then NIGHTSHIFT_BASE_URL, then (when allowed) the one saved at login, then the default. */
export function resolveBaseUrl(ctx, saved) {
  const base = normalizeBaseUrl(ctx.values["base-url"] || ctx.io.env.NIGHTSHIFT_BASE_URL || saved || DEFAULT_BASE_URL);
  // The key goes wherever this points. A wrong or injected --base-url / NIGHTSHIFT_BASE_URL is the
  // one way to hand it to another server, so say so every time the target is not the default or this machine.
  const { hostname } = new URL(base);
  const home = new URL(DEFAULT_BASE_URL).hostname;
  if (hostname !== home && !LOOPBACK.has(hostname))
    ctx.warn(`your API key will be sent to ${hostname}, not ${home}. Continue only if you chose that address yourself.`);
  return base;
}

/**
 * The client for this run. The key comes from NIGHTSHIFT_API_KEY, else from the
 * file `login` wrote; it is registered for redaction before anything is sent.
 */
export async function getClient(ctx) {
  const envKey = ctx.io.env.NIGHTSHIFT_API_KEY;
  const saved = envKey ? null : await readCredentials(ctx.io);
  const key = envKey || saved?.api_key;
  if (!key)
    throw new CliError("not_logged_in", "No API key. Run `nightshift login`, or set NIGHTSHIFT_API_KEY.", {
      exit: EXIT.AUTH,
      hint: hintFor("invalid_api_key"),
    });
  ctx.addSecret(key);
  checkKey(key);
  for (const w of saved?.warnings ?? []) ctx.warn(w);
  const baseUrl = resolveBaseUrl(ctx, saved?.base_url);
  ctx.keySource = envKey ? "env NIGHTSHIFT_API_KEY" : "saved login";
  return new Client({ baseUrl, key, io: ctx.io, debug: !!ctx.values.debug, log: (s) => ctx.io.stderr.write(ctx.clean(s)) });
}

/** The key sent with a money-moving POST: the one the user gave, else a fresh one. */
export function idempotencyKeyFor(ctx) {
  const given = ctx.values["idempotency-key"];
  if (given != null) {
    if (!IDEMPOTENCY_RE.test(given)) throw usageError("--idempotency-key: 1-255 characters of A-Z a-z 0-9 _ : . -");
    return { key: given, generated: false };
  }
  return { key: `cli-${randomUUID()}`, generated: true };
}

export function intOption(ctx, name, { min, max }) {
  const raw = ctx.values[name];
  if (raw == null) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw usageError(`--${name} must be a whole number${min != null ? ` of ${min} or more` : ""}.`);
  const n = Number(raw);
  if ((min != null && n < min) || (max != null && n > max)) throw usageError(`--${name} must be between ${min} and ${max}.`);
  return n;
}

export const WAIT_OPTIONS = {
  wait: { type: "boolean", help: "Poll until the work finishes (backoff 2s up to 15s)." },
  timeout: { type: "string", arg: "SECONDS", help: "With --wait: give up waiting after this long (default 1800). Nothing is cancelled." },
};

export const IDEMPOTENCY_OPTION = {
  "idempotency-key": {
    type: "string",
    arg: "KEY",
    help: "Reuse the key printed by an earlier attempt to retry it safely (24 h). Default: a fresh key.",
  },
};

/**
 * A follow-up call failed after the work was already created and its price
 * held. Say so on the error, so the person still has the id to follow.
 */
export async function afterCreated(promise, { text, details }) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof CliError) {
      e.message = `${e.message} (${text})`;
      e.details = { ...e.details, ...details };
    }
    throw e;
  }
}
