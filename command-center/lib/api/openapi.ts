/**
 * The public API's OpenAPI 3.1 description, served at /docs/api/openapi.json.
 * Built from the same constants the API uses (tiers, key format, fields), so
 * the spec cannot quietly drift from the code; tests/api-openapi.test.ts
 * checks every documented path has a route.
 */

import { API_TIERS, DEFAULT_API_PRICES, TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "@/lib/api/pricing";
import { IMAGE_PROVIDERS, VIDEO_PROVIDERS } from "@/lib/runBackend";
import { API_SCOPES, KEY_RPM_MAX, LEGACY_SCOPES } from "@/lib/api/scopes";
import { CREATIVE_CAPABILITIES, PARAM_KEYS } from "@/lib/creative/operations";

const ERROR_CODES = [
  "invalid_api_key",
  "api_not_activated",
  "key_owner_not_admin",
  "rate_limit_exceeded",
  "concurrency_limit_exceeded",
  "insufficient_balance",
  "monthly_limit_reached",
  "key_limit_reached",
  "insufficient_scope",
  "insufficient_credits",
  "key_credit_limit_reached",
  "run_limit_reached",
  "price_changed",
  "max_credits_required",
  "idempotency_key_required",
  "model_not_sellable",
  "entitlement_required",
  "unpriced",
  "capability_not_supported",
  "source_unavailable",
  "style_unavailable",
  "mode_not_supported",
  "registry_missing",
  "forbidden",
  "invalid_body",
  "unknown_parameter",
  "invalid_params",
  "channel_required",
  "duration_required",
  "channel_not_found",
  "channel_not_active",
  "video_not_found",
  "job_not_found",
  "download_not_found",
  "no_master",
  "targets_required",
  "too_many_targets",
  "publish_refused",
  "invalid_idempotency_key",
  "idempotency_key_reused",
  "idempotency_in_progress",
  "queue_backend_required",
  "downloads_unavailable",
  "pricing_unavailable",
  "api_unavailable",
  "upstream_error",
  "internal_error",
  "unknown_endpoint",
];

const json = (schema: unknown) => ({ "application/json": { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errors = (...codes: number[]) =>
  Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/E${c}` }]));
const idem = { $ref: "#/components/parameters/IdempotencyKey" };
const idemRequired = { $ref: "#/components/parameters/IdempotencyKeyRequired" };
const pathId = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});

/** The scope each existing operation needs (the creative ones state theirs inline). */
const SCOPE_OF: Record<string, string | null> = {
  "get /me": null,
  "get /balance": "account:read",
  "get /channels": "account:read",
  "get /accounts": "account:read",
  "post /videos": "videos:write",
  "get /videos": "videos:read",
  "get /videos/{id}": "videos:read",
  "post /videos/{id}/publish": "videos:write",
  "post /videos/{id}/downloads": "videos:write",
  "get /downloads/{id}": "videos:read",
  "get /downloads/{id}/file": "videos:read",
  "get /jobs/{id}": "videos:read",
};

export function openApiSpec(serverUrl: string): Record<string, unknown> {
  const spec = buildSpec(serverUrl);
  const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
  for (const [key, scope] of Object.entries(SCOPE_OF)) {
    const [method, path] = key.split(" ");
    // /me is open to every valid key: it is how a client reads its own scopes.
    paths[path][method]["x-required-scope"] = scope ?? "none (any valid key)";
  }
  return spec;
}

function buildSpec(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Nightshift API",
      version: "1.0.0",
      description:
        "Make, list and publish videos, and generate images, video and audio, programmatically. Videos are prepaid in US dollars, separate from site credits; " +
        "generations (/creative) are paid in the organization's credits, exactly like the Studio. " +
        `Video: $${(DEFAULT_API_PRICES.video_minute / 100).toFixed(2)} per minute of requested length, at least ` +
        `$${(DEFAULT_API_PRICES.job_minimum / 100).toFixed(2)} (default prices; the live list is on /docs/api).`,
    },
    servers: [{ url: `${serverUrl.replace(/\/+$/, "")}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key: nsk_live_ followed by 43 characters. A key has scopes (" + API_SCOPES.join(", ") + "); each operation names the one it needs " +
            "in x-required-scope, and a key without it is refused with 403 insufficient_scope. Keys made before generations existed hold only " +
            LEGACY_SCOPES.join(", ") + ". A key may also carry its own requests-per-minute limit (it can only lower the usage tier's, up to " + KEY_RPM_MAX +
            ") and a monthly credit ceiling for generations.",
        },
      },
      parameters: {
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: "Retry-safe POST: the same key and body within 24 hours replays the first success.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,255}$" },
        },
        IdempotencyKeyRequired: {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description:
            "Required: a generation spends credits, so a retry must not spend twice. The same key and body replays the first answer; " +
            "the same key with another body is 422 idempotency_key_reused. Keys are per API key.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_:.-]{1,255}$" },
        },
      },
      headers: {
        RequestId: { schema: { type: "string" }, description: "Quote it when contacting support." },
        RateLimitLimit: { schema: { type: "integer" } },
        RateLimitRemaining: { schema: { type: "integer" } },
        RateLimitReset: { schema: { type: "integer" }, description: "Seconds until the minute window resets." },
        RetryAfter: { schema: { type: "integer" } },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["type", "code", "message", "request_id"],
              properties: {
                type: {
                  type: "string",
                  enum: [
                    "invalid_request_error",
                    "authentication_error",
                    "billing_error",
                    "permission_error",
                    "not_found_error",
                    "conflict_error",
                    "idempotency_error",
                    "rate_limit_error",
                    "api_error",
                  ],
                },
                code: { type: "string", enum: ERROR_CODES },
                message: { type: "string" },
                request_id: { type: "string" },
                retry_after: { type: "integer" },
              },
              additionalProperties: true,
            },
          },
        },
        CreateVideo: {
          type: "object",
          required: ["channel_id"],
          additionalProperties: false,
          properties: {
            channel_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
            topic: { type: "string", maxLength: 300 },
            niche: { type: "string", maxLength: 120 },
            duration: { type: "integer", minimum: 30, maximum: 3600, description: "Seconds. Defaults to the channel's target length; the price is based on it." },
            language: { type: "string", maxLength: 40 },
            visual_style: { type: "string", maxLength: 300 },
            video_provider: { type: "string", enum: [...VIDEO_PROVIDERS] },
            image_provider: { type: "string", enum: [...IMAGE_PROVIDERS] },
          },
        },
        Job: {
          type: "object",
          properties: {
            id: { type: "integer" },
            channel_id: { type: "string" },
            status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
            params: { type: "object" },
            attempts: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            started_at: { type: ["string", "null"], format: "date-time" },
            finished_at: { type: ["string", "null"], format: "date-time" },
            error: { type: ["string", "null"] },
            charge: {
              type: ["object", "null"],
              properties: {
                status: { type: "string", enum: ["open", "captured", "released"] },
                held_cents: { type: "integer" },
                captured_cents: { type: ["integer", "null"] },
              },
            },
          },
        },
        Video: {
          type: "object",
          properties: {
            id: { type: "string" },
            channel_id: { type: "string" },
            title: { type: ["string", "null"] },
            topic: { type: ["string", "null"] },
            format: { type: ["string", "null"] },
            published_at: { type: ["string", "null"] },
            privacy: { type: ["string", "null"] },
            publish_state: { type: ["string", "null"] },
            review_state: { type: ["string", "null"] },
            youtube_url: { type: ["string", "null"] },
          },
        },
        Publish: {
          type: "object",
          additionalProperties: false,
          properties: {
            account_ids: { type: "array", items: { type: "string", format: "uuid" }, description: "Connected Instagram / TikTok accounts." },
            channel_ids: { type: "array", items: { type: "string" }, description: "The organization's YouTube channels (uploaded private)." },
          },
        },
        Balance: {
          type: "object",
          properties: {
            currency: { const: "usd" },
            exempt: { type: "boolean" },
            balance_cents: { type: "integer" },
            reserved_cents: { type: "integer" },
            available_cents: { type: "integer" },
            month_spend_cents: { type: "integer" },
            monthly_limit_cents: { type: ["integer", "null"] },
            tier: { type: "integer", enum: API_TIERS.map((t) => t.tier) },
          },
        },
        CreativeQuoteRequest: {
          type: "object",
          required: ["capability", "model", "params"],
          additionalProperties: false,
          properties: {
            capability: { type: "string", enum: [...CREATIVE_CAPABILITIES] },
            model: { type: "string", description: "A model id the API sells for this capability (not every model the Studio offers is on the API)." },
            params: {
              type: "object",
              additionalProperties: false,
              description:
                "What to generate. edit, i2v, upscale, remove_bg and describe take source_asset_id: an image in the key's organization's media library " +
                "(another organization's id answers exactly like one that does not exist).",
              properties: Object.fromEntries(PARAM_KEYS.map((k) => [k, {}])),
            },
            mode: { const: "exact", description: "Only exact: the model you named runs." },
          },
        },
        CreativeCreateRequest: {
          type: "object",
          required: ["capability", "model", "params", "max_credits"],
          additionalProperties: false,
          properties: {
            capability: { type: "string", enum: [...CREATIVE_CAPABILITIES] },
            model: { type: "string" },
            params: { type: "object", description: "As in the quote." },
            mode: { const: "exact" },
            max_credits: {
              type: "number",
              minimum: 0,
              description: "The most credits you accept to be charged. A price above it is refused with 409 price_changed; nothing is held.",
            },
          },
        },
        CreativeQuote: {
          type: "object",
          properties: {
            quote: {
              type: "object",
              properties: {
                credits: { type: "number", description: "What the generation costs; exactly what is held when it is started." },
                exempt: { type: "boolean" },
                model: { type: "string" },
                capability: { type: "string" },
                unit: { type: "string" },
                quantity: { type: "number" },
                credits_per_unit: { type: "number" },
                margin: { type: "number" },
                minimum: { type: "number" },
              },
            },
          },
        },
        CreativeJob: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            capability: { type: "string" },
            model: { type: "string" },
            status: {
              type: "string",
              enum: ["queued", "running", "provider_pending", "processing", "completed", "failed", "cancelled", "expired"],
            },
            quoted_credits: { type: "number", description: "Held when the job was started." },
            charged_credits: { type: ["number", "null"], description: "What was captured; null until the job ends. 0 when it failed, was cancelled or expired (the hold is released)." },
            error_code: { type: ["string", "null"] },
            error: { type: ["string", "null"] },
            result: { type: ["object", "null"], description: "Files (type, size, digest) or, for describe, the text. Outputs are in the organization's media library: result_asset_ids." },
            result_asset_ids: { type: "array", items: { type: "string", format: "uuid" } },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            finished_at: { type: ["string", "null"], format: "date-time" },
            expires_at: { type: "string", format: "date-time", description: "A job no worker picks up by then expires and its hold is released." },
          },
        },
        Download: {
          type: "object",
          properties: {
            id: { type: "integer" },
            video_id: { type: "string" },
            quality: { type: "string", enum: ["720p", "1080p"] },
            status: { type: "string", enum: ["queued", "processing", "ready", "failed", "expired"] },
            file_url: { type: "string" },
            expires_at: { type: ["string", "null"], format: "date-time" },
          },
        },
      },
      responses: Object.fromEntries(
        [400, 401, 402, 403, 404, 409, 410, 422, 429, 503].map((c) => [
          `E${c}`,
          { description: "Error", content: json(ref("Error")), headers: { "x-request-id": { $ref: "#/components/headers/RequestId" } } },
        ]),
      ),
    },
    paths: {
      "/me": {
        get: { summary: "The key's organization, usage tier and limits", responses: { "200": { description: "OK" }, ...errors(401, 403, 429) } },
      },
      "/balance": {
        get: {
          summary: "Prepaid API balance and this month's spend",
          description: `Top up in the Developer console (${TOPUP_MIN_CENTS / 100}–${TOPUP_MAX_CENTS / 100} USD per payment).`,
          responses: { "200": { description: "OK", content: json(ref("Balance")) }, ...errors(401, 403, 429) },
        },
      },
      "/channels": { get: { summary: "The organization's channels", responses: { "200": { description: "OK" }, ...errors(401, 403, 429) } } },
      "/accounts": { get: { summary: "Publish targets: YouTube channels and connected Instagram / TikTok accounts", responses: { "200": { description: "OK" }, ...errors(401, 403, 429) } } },
      "/videos": {
        post: {
          summary: "Make a video (queued; charged when the job succeeds)",
          parameters: [idem],
          requestBody: { required: true, content: json(ref("CreateVideo")) },
          responses: {
            "201": {
              description: "Queued",
              content: json({
                type: "object",
                properties: { job_id: { type: "integer" }, channel_id: { type: "string" }, status: { const: "queued" }, price_cents: { type: ["integer", "null"] } },
              }),
            },
            ...errors(400, 401, 402, 403, 404, 409, 422, 429, 503),
          },
        },
        get: {
          summary: "List videos, newest first",
          parameters: [
            { name: "channel_id", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 10000, default: 0 } },
          ],
          responses: { "200": { description: "OK", content: json({ type: "object", properties: { videos: { type: "array", items: ref("Video") } } }) }, ...errors(400, 401, 403, 429) },
        },
      },
      "/videos/{id}": {
        get: { summary: "One video with its publish requests", parameters: [pathId("id", "Video id")], responses: { "200": { description: "OK", content: json(ref("Video")) }, ...errors(401, 403, 404, 429) } },
      },
      "/videos/{id}/publish": {
        post: {
          summary: "Cross-post a finished video (free). Same gate and approvals as the site; YouTube uploads are private.",
          parameters: [pathId("id", "Video id"), idem],
          requestBody: { required: true, content: json(ref("Publish")) },
          responses: { "200": { description: "One request per target, or why it was refused" }, ...errors(400, 401, 403, 404, 409, 422, 429) },
        },
      },
      "/videos/{id}/downloads": {
        post: {
          summary: "Order a 720p / 1080p download (site credit price x $0.015, charged when ready)",
          parameters: [pathId("id", "Video id"), idem],
          requestBody: { required: true, content: json({ type: "object", required: ["quality"], properties: { quality: { enum: ["720p", "1080p"] } } }) },
          responses: { "201": { description: "Queued", content: json(ref("Download")) }, "200": { description: "An existing download reused" }, ...errors(400, 401, 402, 403, 404, 422, 429, 503) },
        },
      },
      "/downloads/{id}": {
        get: { summary: "A download's status", parameters: [pathId("id", "Download id")], responses: { "200": { description: "OK", content: json(ref("Download")) }, ...errors(401, 403, 404, 429) } },
      },
      "/downloads/{id}/file": {
        get: {
          summary: "The MP4 of a ready download",
          parameters: [pathId("id", "Download id")],
          responses: { "200": { description: "video/mp4", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } }, ...errors(401, 403, 404, 409, 410, 429, 503) },
        },
      },
      "/creative/quote": {
        post: {
          summary: "The price of one generation, in credits. Nothing is held.",
          "x-required-scope": "creative:quote",
          requestBody: { required: true, content: json(ref("CreativeQuoteRequest")) },
          responses: { "200": { description: "OK", content: json(ref("CreativeQuote")) }, ...errors(400, 401, 403, 422, 429, 503) },
        },
      },
      "/creative/jobs": {
        post: {
          summary: "Start a generation: held now at the quoted price, captured when it succeeds, released if it fails.",
          description:
            "The same start as the Studio's, on the organization's credits: the quote is held in one transaction with the job, the worker captures " +
            "the charge when the provider succeeds and releases it on failure, expiry or cancellation. Idempotency-Key and max_credits are required. " +
            "The plan's parallel-run limit applies (429 run_limit_reached).",
          "x-required-scope": "creative:create",
          parameters: [idemRequired],
          requestBody: { required: true, content: json(ref("CreativeCreateRequest")) },
          responses: {
            "201": { description: "Queued, and the quote held", content: json(ref("CreativeJob")) },
            "200": { description: "The job's own idempotency record answered: the same job, nothing more held", content: json(ref("CreativeJob")) },
            ...errors(400, 401, 402, 403, 409, 422, 429, 503),
          },
        },
      },
      "/creative/jobs/{id}": {
        get: {
          summary: "A generation this key started: status, held and charged credits, result.",
          description: "Another key's generation, another organization's and a missing id all answer 404 job_not_found.",
          "x-required-scope": "creative:read",
          parameters: [pathId("id", "Generation id")],
          responses: { "200": { description: "OK", content: json(ref("CreativeJob")) }, ...errors(401, 403, 404, 429) },
        },
      },
      "/jobs/{id}": {
        get: { summary: "A video job's status and charge", parameters: [pathId("id", "Job id")], responses: { "200": { description: "OK", content: json(ref("Job")) }, ...errors(401, 403, 404, 429) } },
      },
    },
  };
}
