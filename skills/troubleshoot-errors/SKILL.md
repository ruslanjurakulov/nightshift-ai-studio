---
name: troubleshoot-errors
description: Diagnose Nightshift CLI and API errors by exit code and error code - auth, billing, rate limits, idempotency, price changes, publish refusals, downloads and network problems - and say what to do for each. Use when a nightshift command fails or returns an error envelope.
---

# Troubleshoot errors

Every API error is `{"error": {"type", "code", "message", "request_id", ...}}`. The CLI prints the code, the message and the `request_id`; with `--json` it prints the envelope on stdout. Always quote the `request_id` when reporting a problem. Read the **code**, not just the HTTP status: `insufficient_balance` and `monthly_limit_reached` are both 402 and need different fixes.

## Exit codes

| Exit | Meaning | First move |
| --: | :-- | :-- |
| 0 | ok | |
| 1 | error (including a failed job, a refused publish) | read the code below |
| 2 | usage: a wrong flag, a missing argument | `nightshift <command> --help` |
| 3 | auth or permission (HTTP 401, 403) | key, scope, activation |
| 4 | billing (HTTP 402) | nothing was charged; a person must act |
| 5 | rate limited (HTTP 429) | wait `Retry-After`, then retry |

## Codes

| Code | What it means and what to do |
| :-- | :-- |
| `invalid_api_key`, `not_logged_in` | Wrong, revoked or missing key. The person runs `nightshift login` or sets `NIGHTSHIFT_API_KEY`. Do not ask them to paste it here. |
| `api_not_activated` | An owner or admin activates the API in Developers. |
| `key_owner_not_admin` | The key's creator is no longer an owner or admin. Make a new key. |
| `insufficient_scope` | The message and `required_scope` name the missing scope. Make a new key with it. |
| `insufficient_balance` | Available balance is below the price. Nothing charged. Top up in Developers > Billing. |
| `monthly_limit_reached` | The organization's monthly limit. Raise it in Developers > Limits. |
| `key_limit_reached` | This key's own monthly limit. Raise it or use another key. |
| `insufficient_credits`, `key_credit_limit_reached` | Credits for generations (not the USD balance). Nothing held. |
| `rate_limit_exceeded` | Too many requests per minute. Wait the `Retry-After` seconds, then retry. |
| `concurrency_limit_exceeded` | Too many videos at once for the tier. Wait for one to finish. |
| `run_limit_reached` | Too many generations at once for the plan. Wait. |
| `price_changed` | The price is above `--max-credits`. Nothing held. Quote again and ask the person. |
| `route_changed` | The automatic model pick changed since the quote. Quote again. |
| `max_credits_required`, `idempotency_key_required` | A generation needs both. Add `--max-credits` and `--idempotency-key`. |
| `idempotency_key_reused` | That key was used with different arguments. A new request needs a new key; a retry needs the identical arguments. |
| `idempotency_in_progress` | The first request with this key is still running. Wait, retry with the same key. |
| `network_error`, `timeout` | The request may or may not have arrived. Retry the identical command with the same `--idempotency-key` (printed in the output). Never use a new key for a retry. |
| `wait_timeout` | `--wait` stopped waiting. The job continues. Resume with `jobs get ID --wait`. |
| `channel_not_found`, `channel_not_active`, `channel_required` | Check `nightshift channels`. Only active channels make videos. |
| `duration_required` | The channel has no target length. Pass `--duration`. |
| `invalid_params`, `unknown_parameter`, `invalid_body` | A value is out of bounds. The message says which. Fix and resend. |
| `job_not_found`, `video_not_found`, `download_not_found` | Wrong id, or it belongs to another organization. Another key's generation is also `job_not_found`. |
| `no_master` | The video has no master file to download. |
| `download_not_ready` | The file is not ready. `nightshift download get ID --wait`. |
| `download_expired`, `download_file_missing` | Order it again with `download request`. |
| `publish_refused` | The publish gate or approvals refused. Report the reason; do not retry in a loop. |
| `model_not_sellable`, `unpriced`, `capability_not_supported`, `mode_not_supported`, `no_model_available` | Not sold through the API as asked. Use a routed `--mode`, or another capability. |
| `source_unavailable`, `style_unavailable` | The media-library asset or style kit is not usable by this organization. |
| `entitlement_required` | The plan does not include this. A person checks the plan. |
| `queue_backend_required`, `downloads_unavailable`, `api_unavailable`, `registry_missing`, `pricing_unavailable` | This deployment is not set up for that yet. Report it; retrying will not help. |
| `upstream_error`, `internal_error`, `bad_response` | A server problem. Retry reads with backoff. For a create, retry only with the same idempotency key. |
| `insecure_base_url` | Plain `http` to a non-local host. Use `https`. The CLI never sends the key that way. |

## Rules for every failure

1. Quote code, message and `request_id`.
2. Say whether money moved. For exit 4 and refusals (`price_changed`, `publish_refused`) nothing was held or charged. After a network error on a create, check `nightshift balance` and `nightshift jobs get`.
3. Retry only when the table says so, and a retry of a create or download or generate always reuses the same idempotency key.
4. Do not change the key, scopes, base URL or limits to get around a refusal. Those are the person's decisions.
