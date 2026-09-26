import "server-only";
import { PROVIDER_SECRET_NAMES } from "../providers";
import { IMAGE_PROVIDERS } from "@/lib/imageProviders";

/**
 * Writing GitHub Actions Repository Secrets — forward, never store.
 *
 * A key typed into the Command Center exists in three places and no more: the
 * input the operator typed it into, the body of one POST to our own origin, and
 * the sealed box we hand to GitHub. It is never written to Supabase, never put
 * in an event's metadata, never logged, and never returned to the browser.
 * Nothing here ever reads a secret back — GitHub does not permit that, and this
 * module does not want it.
 *
 * The token that authorizes the write lives in a server-only env var. It must
 * never be prefixed NEXT_PUBLIC_, and this file is `server-only` so importing
 * it from a client component fails the build rather than shipping the token.
 */

export const GITHUB_TOKEN = process.env.GITHUB_SECRETS_TOKEN ?? "";
/** "owner/repo" of the bot repository whose secrets are written. */
export const GITHUB_REPO = process.env.GITHUB_SECRETS_REPO ?? "";

export const isGithubConfigured = Boolean(GITHUB_TOKEN && GITHUB_REPO);

/**
 * The only secret names this endpoint may write.
 *
 * An allowlist, not a filter: without it, an authenticated caller could aim the
 * endpoint at SUPABASE_SERVICE_KEY or at any other secret the workflow trusts
 * and silently replace it. Anything not named here is refused.
 */
const FIXED_NAMES = new Set([
  "GEMINI_API_KEY",
  "PEXELS_API_KEY",
  "ELEVENLABS_API_KEY",
  "YOUTUBE_DATA_API_KEY",
  "YOUTUBE_CLIENT_SECRET_JSON",
  "YOUTUBE_TOKEN_JSON",
  "YOUTUBE_CHANNEL_ID",
  // Alert channel credentials (see lib/server/alerts.ts). The Slack incoming
  // webhook URL and the Resend API key are sealed here and read at runtime by
  // whatever sends the notification (the Actions pipeline, or the web "Send
  // test" route when the webhook happens to be present in the web runtime).
  "SLACK_WEBHOOK_URL",
  "RESEND_API_KEY",
  // Every provider key an operator can type on the Providers board. The list
  // lives in lib/providers.ts so the board and this allowlist cannot drift.
  ...PROVIDER_SECRET_NAMES,
]);

/** Per-channel publishing tokens: CHRONOS_YT_TOKEN_<REF>. */
const PER_CHANNEL = /^CHRONOS_YT_TOKEN_[A-Z0-9_]{1,64}$/;

export function isWritableSecretName(name: string): boolean {
  return FIXED_NAMES.has(name) || PER_CHANNEL.test(name);
}

/** The GitHub secret name for a channel's credential ref, as the bot reads it. */
export function channelTokenSecret(ref: string): string {
  return (
    "CHRONOS_YT_TOKEN_" +
    ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  );
}

type PublicKey = { key_id: string; key: string };

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

/**
 * The repository's public key, fetched once per request batch.
 *
 * A failure here is reported by HTTP status alone: GitHub's error bodies are
 * not echoed to the browser, because a misconfigured token makes them describe
 * the token's own scopes.
 */
export async function fetchPublicKey(): Promise<PublicKey> {
  const res = await gh("/actions/secrets/public-key");
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "github_unauthorized"
        : res.status === 404
          ? "github_repo_not_found"
          : "github_unavailable",
    );
  }
  return (await res.json()) as PublicKey;
}

/**
 * List which provider secrets are present, by name only.
 *
 * GitHub's `GET /actions/secrets` returns each secret's name and timestamps —
 * never its value, which GitHub does not expose to anyone. The result is
 * filtered to the provider allowlist so the Command Center learns "this
 * provider has a key set" without ever seeing the key and without leaking the
 * names of unrelated infrastructural secrets. A partial/paged listing is
 * enough here — a configured provider is only ever missed, never invented.
 */
export async function listConfiguredSecretNames(
  allowNames: Iterable<string> = PROVIDER_SECRET_NAMES,
): Promise<string[]> {
  if (!isGithubConfigured) return [];
  const allow = new Set<string>(allowNames);
  const res = await gh("/actions/secrets?per_page=100");
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "github_unauthorized"
        : res.status === 404
          ? "github_repo_not_found"
          : "github_unavailable",
    );
  }
  const body = (await res.json()) as { secrets?: { name?: unknown }[] };
  const names = (body.secrets ?? [])
    .map((s) => (typeof s?.name === "string" ? s.name : null))
    .filter((n): n is string => n !== null && allow.has(n));
  return Array.from(new Set(names));
}

/**
 * Trigger the daily-video workflow on demand for one channel.
 *
 * A "Run now" from the site is exactly a `workflow_dispatch` of the same
 * pipeline the hourly cron fires — GitHub Actions runs it, not this server, so
 * nothing heavy happens in the request. The workflow's own inputs decide the
 * rest: `channel` targets this channel whatever the hour, and `privacy` is
 * pinned to `private` so an on-demand run never surprises anyone with a public
 * upload — the channel's auto-publish and the publish gate still decide what
 * actually goes out, exactly as on a scheduled run.
 *
 * `ref` is the branch the workflow file is read from — the default branch,
 * overridable with GITHUB_SECRETS_REF for a fork or a non-main default. Requires
 * the forwarding token to carry `actions:write`; a 403 says it does not.
 */
export async function dispatchDailyVideo(
  channelId: string,
  opts: {
    topic?: string;
    niche?: string;
    duration?: number;
    language?: string;
    visualStyle?: string;
    videoProvider?: string;
    imageProvider?: string;
    /** The credit hold paying for this run (migration 0020); the workflow
     *  claims it before the run and settles it after. */
    creditRef?: string;
  } = {},
): Promise<void> {
  if (!isGithubConfigured) throw new Error("github_not_configured");
  const ref = process.env.GITHUB_SECRETS_REF?.trim() || "main";
  // The workflow exposes `topic`, `niche`, `duration`, `language` and
  // `visual_style` inputs (see .github/workflows/daily_video.yml); forward each
  // only when set so a plain run still behaves exactly as before (the AI picks
  // the topic and the channel's own settings apply).
  const inputs: Record<string, string> = { channel: channelId, privacy: "private" };
  const topic = opts.topic?.trim();
  const niche = opts.niche?.trim();
  const language = opts.language?.trim();
  const visualStyle = opts.visualStyle?.trim();
  if (topic) inputs.topic = topic.slice(0, 300);
  if (niche) inputs.niche = niche.slice(0, 120);
  // Duration is a positive integer number of seconds; a workflow_dispatch input
  // is always a string, so it is stringified here and re-parsed by main.py.
  if (typeof opts.duration === "number" && Number.isFinite(opts.duration) && opts.duration > 0) {
    inputs.duration = String(Math.round(opts.duration));
  }
  if (language) inputs.language = language.slice(0, 40);
  if (visualStyle) inputs.visual_style = visualStyle.slice(0, 300);
  // Per-run model routing — validated against the workflow's own choice lists
  // (see daily_video.yml), so only a real provider name is ever forwarded.
  const VIDEO_PROVIDERS = ["minimax", "higgsfield", "kling", "veo", "seedance", "wan"];
  const videoProvider = opts.videoProvider?.trim().toLowerCase();
  const imageProvider = opts.imageProvider?.trim().toLowerCase();
  if (videoProvider && VIDEO_PROVIDERS.includes(videoProvider)) inputs.video_provider = videoProvider;
  if (imageProvider && (IMAGE_PROVIDERS as readonly string[]).includes(imageProvider)) inputs.image_provider = imageProvider;
  // Same shape 0020 accepts for a reservation id; anything else is not sent.
  if (opts.creditRef && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(opts.creditRef)) inputs.credit_ref = opts.creditRef;
  await dispatchWorkflow("daily_video.yml", inputs, ref);
}

/**
 * Dispatch one of the bot repo's workflows by file name. Only the workflows
 * listed here may be dispatched from the site — anything else is refused before
 * GitHub is called.
 */
const DISPATCHABLE_WORKFLOWS = ["daily_video.yml", "provider_balances.yml"];

export async function dispatchWorkflow(
  file: string,
  inputs: Record<string, string> = {},
  ref: string = process.env.GITHUB_SECRETS_REF?.trim() || "main",
): Promise<void> {
  if (!isGithubConfigured) throw new Error("github_not_configured");
  if (!DISPATCHABLE_WORKFLOWS.includes(file)) throw new Error("github_workflow_not_allowed");
  const res = await gh(`/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs }),
  });
  if (res.status === 204) return;
  throw new Error(
    res.status === 401 || res.status === 403
      ? "github_unauthorized"
      : res.status === 404
        ? "github_workflow_not_found"
        : "github_dispatch_failed",
  );
}

/**
 * Seal `value` to the repository key and PUT it as `name`.
 *
 * Returns "created" or "updated" — GitHub answers 201 for a secret that did not
 * exist and 204 for one that did, which is the only fact worth surfacing: the
 * operator can tell a new channel's token from an overwritten one.
 */
export async function putSecret(
  name: string,
  value: string,
  key: PublicKey,
): Promise<"created" | "updated"> {
  if (!isWritableSecretName(name)) throw new Error("secret_not_allowed");

  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
  );
  const encrypted_value = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

  const res = await gh(`/actions/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value, key_id: key.key_id }),
  });
  if (res.status === 201) return "created";
  if (res.status === 204) return "updated";
  throw new Error(
    res.status === 401 || res.status === 403 ? "github_unauthorized" : "github_write_failed",
  );
}
