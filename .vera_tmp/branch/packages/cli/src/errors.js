/**
 * Exit codes. Scripts and agents branch on these, so they are part of the
 * CLI's contract (docs/CLI.md).
 */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  BILLING: 4,
  RATE_LIMITED: 5,
});

/** The exit code for an HTTP status the API answered with. */
export function exitCodeForStatus(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 402) return EXIT.BILLING;
  if (status === 429) return EXIT.RATE_LIMITED;
  return EXIT.ERROR;
}

/**
 * Something the CLI reports and exits on. `code` is a stable machine word
 * (the API's own error code when the API answered), `type` the API's error
 * family or "cli_error".
 */
export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{exit?: number, type?: string, details?: Record<string, unknown>, hint?: string,
   *   requestId?: string|null, status?: number|null, retryAfter?: number|null, idempotencyKey?: string|null}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exit = opts.exit ?? EXIT.ERROR;
    this.type = opts.type ?? "cli_error";
    this.details = opts.details ?? {};
    this.hint = opts.hint ?? null;
    this.requestId = opts.requestId ?? null;
    this.status = opts.status ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.idempotencyKey = opts.idempotencyKey ?? null;
  }
}

export const usageError = (message, hint) => new CliError("usage", message, { exit: EXIT.USAGE, hint });

/** What to do next, for the codes a person or agent meets most. Never states a price. */
const HINTS = {
  invalid_api_key: "Run `nightshift login` with a key from Developers > API keys.",
  api_not_activated: "Activate the API in Developers (an organization owner or admin does this once).",
  key_owner_not_admin: "The key's creator is no longer an owner or admin; make a new key in Developers > API keys.",
  insufficient_scope: "This key lacks the scope the message names; make a new key with it in Developers > API keys.",
  insufficient_balance: "Top up the API balance in Developers > Billing. Nothing was charged.",
  monthly_limit_reached: "The organization's monthly limit is reached. An owner or admin can raise it in Developers > Limits.",
  key_limit_reached: "This key's own monthly limit is reached. Raise it or use another key in Developers > API keys.",
  insufficient_credits: "Add credits in the web app. Nothing was held.",
  key_credit_limit_reached: "This key's monthly credit ceiling is reached. Raise it in Developers > API keys.",
  price_changed: "The price moved above --max-credits. Nothing was held. Run `nightshift quote` again and decide.",
  route_changed: "The automatic model choice changed. Run `nightshift quote` again.",
  rate_limit_exceeded: "Wait for the Retry-After time, then retry the same command.",
  concurrency_limit_exceeded: "Too many videos at once for this tier. Wait for one to finish.",
  run_limit_reached: "Too many generations at once for this plan. Wait for one to finish.",
  idempotency_key_reused: "That Idempotency-Key was already used with a different request. Use a new key for a new request.",
  idempotency_in_progress: "The first request with this key is still running. Wait, then retry with the same key.",
  channel_not_active: "Only channels YouTube has confirmed can make videos. Check `nightshift channels`.",
  publish_refused: "The publish gate or approvals refused this video; they are the same as on the site. See the details above.",
  download_not_ready: "Run `nightshift download get <id> --wait` first.",
  queue_backend_required: "This deployment cannot queue API videos yet.",
  downloads_unavailable: "This deployment cannot serve HD downloads yet.",
  api_unavailable: "The API is not set up on this deployment yet.",
};

export function hintFor(code) {
  return HINTS[code] ?? null;
}
