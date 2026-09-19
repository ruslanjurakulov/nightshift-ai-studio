import "server-only";

/**
 * Alert channels — Slack + email, dependency-free HTTP integrations.
 *
 * The honest shape of this feature, given how the Command Center holds its
 * credentials: provider secrets live as GitHub Actions secrets, and the web app
 * can only ever learn whether a secret NAME is configured — GitHub never hands
 * a value back. So the web side does two things it can do truthfully:
 *
 *   1. Report which channels are CONFIGURED, by secret/variable name presence.
 *   2. Write the durable `alert_events` feed (RLS: any signed-in operator).
 *
 * The actual send with the real credential happens where the secret env var is
 * present: the GitHub Actions pipeline that raises the alert, or a future server
 * deploy that carries SLACK_WEBHOOK_URL / RESEND_API_KEY in its environment. The
 * "Send test" route calls `sendSlackWebhook` only when `process.env.SLACK_WEBHOOK_URL`
 * happens to be present in the web runtime; otherwise it records the event and
 * returns `queued: true`. Secret VALUES are never printed, returned, or stored.
 *
 * `sendSlackWebhook` and `sendResendEmail` below are pure fetch helpers so the
 * pipeline (and that future env-aware server) can call the exact same code path.
 */

export type AlertSeverity = "info" | "warn" | "critical";

/** The GitHub Actions secret names that back each alert channel. */
export const ALERT_SECRET_NAMES = ["SLACK_WEBHOOK_URL", "RESEND_API_KEY"] as const;
/** The GitHub Actions variable names that route email alerts (non-secret). */
export const ALERT_VARIABLE_NAMES = ["ALERT_EMAIL_TO", "ALERT_EMAIL_FROM"] as const;

export interface AlertConfig {
  /** Slack is usable: its incoming-webhook secret is set. */
  slackConfigured: boolean;
  /** Email is usable: the Resend key AND both from/to addresses are set. */
  emailConfigured: boolean;
}

/**
 * Which channels are configured, from the two facts the web app can actually
 * observe: the set of configured secret NAMES and the map of variable values.
 *
 * Slack needs only its webhook secret. Email needs all three: the Resend API
 * key (a secret) and both the from- and to-address (plain variables); a key
 * with nowhere to send, or an address with no key, is not "configured".
 * Pure — no I/O — so it is unit-tested directly.
 */
export function deriveAlertConfig(
  configuredSecretNames: Iterable<string>,
  variables: Record<string, string>,
): AlertConfig {
  const secrets =
    configuredSecretNames instanceof Set
      ? configuredSecretNames
      : new Set(configuredSecretNames);
  const has = (v: string | undefined) => Boolean(v && v.trim());
  return {
    slackConfigured: secrets.has("SLACK_WEBHOOK_URL"),
    emailConfigured:
      secrets.has("RESEND_API_KEY") &&
      has(variables.ALERT_EMAIL_TO) &&
      has(variables.ALERT_EMAIL_FROM),
  };
}

/** The severity prefix a rendered alert leads with. */
export function severityTag(severity: AlertSeverity): string {
  return severity === "critical" ? "CRITICAL" : severity === "warn" ? "WARN" : "INFO";
}

/**
 * The one-line Slack/plaintext rendering of an alert — a leading severity tag,
 * the kind, the title, and an optional body. Deterministic, so it is unit
 * tested and shared by every sender.
 */
export function formatAlertText(input: {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body?: string | null;
}): string {
  const head = `[Nightshift · ${severityTag(input.severity)}] ${input.title}`;
  const meta = input.kind ? `\nkind: ${input.kind}` : "";
  const body = input.body && input.body.trim() ? `\n${input.body.trim()}` : "";
  return `${head}${meta}${body}`;
}

/** The HTML body for an email alert — the same content, lightly marked up. */
export function formatAlertHtml(input: {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body?: string | null;
}): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const bodyHtml =
    input.body && input.body.trim() ? `<p>${esc(input.body.trim())}</p>` : "";
  return (
    `<div><p><strong>[Nightshift · ${severityTag(input.severity)}]</strong> ${esc(input.title)}</p>` +
    (input.kind ? `<p><code>kind: ${esc(input.kind)}</code></p>` : "") +
    bodyHtml +
    `</div>`
  );
}

/**
 * POST `{ text }` to a Slack incoming webhook. Pure fetch helper: the caller
 * supplies the URL (from wherever the secret is available), so nothing here
 * reads or exposes the secret. Returns whether Slack accepted the message.
 */
export async function sendSlackWebhook(url: string, text: string): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    cache: "no-store",
  });
  return res.ok;
}

/**
 * POST an email through Resend's HTTP API. Pure fetch helper: the caller
 * supplies the API key and addresses (from wherever the secret is available).
 * Returns whether Resend accepted the request.
 */
export async function sendResendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
    cache: "no-store",
  });
  return res.ok;
}
