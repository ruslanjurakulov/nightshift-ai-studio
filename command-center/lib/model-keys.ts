/**
 * The owner's API key per model vendor, VERIFIED AND FORGOTTEN (docs/MODEL_API_KEYS.md): the closed list of vendors, how each key is checked,
 * and the small pure rules around it. Pure and client-safe: no request, no network, no secret. The server half is lib/server/model-keys.ts.
 *
 * NOTHING IS STORED. A key pasted here is sent once to the server, checked with the vendor, and dropped: not in a database, not in Vault, not
 * in a log, not in an audit row, not even its last four characters. The page shows the verdict for this visit only. To use a verified key a run
 * needs it in GitHub Actions secrets and the worker environment under the name this page shows (CLAUDE.md rule 1 is untouched).
 *
 * WHAT A VENDOR ENTRY CLAIMS, AND ONLY THAT
 *   keyUrl      the page where the vendor says to create a key, copied from the vendor's OWN documentation (keyUrlSource names the page it
 *               was read on). `null` = not verified, and the page says "link unverified" instead of guessing one.
 *   strategy    `http`: ONE free request to a FIXED vendor host that creates nothing (a list of models, an account or credits read, a list of
 *               the account's own files). A key is "API verified" only when the vendor answers that request with success and the answer has the
 *               documented shape. `format_only`: the vendor documents no such request we could rely on, so the key is NEVER sent anywhere;
 *               only its shape is checked, and the page says so.
 *   A generation endpoint is never a strategy: a check must not cost money or make anything (CLAUDE.md rule 6 asks to fail early; it does not
 *   ask to spend to find out).
 *
 * The vendors are the providers of schemas/model_registry.json (tests/model-keys-registry.test.ts compares them). `unassigned-video-vendor` is a placeholder in the registry, not a vendor, and has no entry.
 */

import { validateSecretValue } from "@/lib/server/secret-validators";

export const MODEL_KEY_PROVIDER_IDS = [
  "alibaba",
  "assemblyai",
  "bfl",
  "bytedance",
  "elevenlabs",
  "google",
  "ideogram",
  "kling",
  "krea",
  "lightricks",
  "luma",
  "minimax",
  "openai",
  "pika",
  "recraft",
  "runway",
  "vidu",
  "xai",
] as const;
export type ModelKeyProviderId = (typeof MODEL_KEY_PROVIDER_IDS)[number];

export function isModelKeyProviderId(value: unknown): value is ModelKeyProviderId {
  return typeof value === "string" && (MODEL_KEY_PROVIDER_IDS as readonly string[]).includes(value);
}

/** What a successful answer must look like. Anything else is "unexpected", never "verified". */
export type ExpectShape =
  | { kind: "object" }
  | { kind: "array" }
  | { kind: "field"; name: string; type: "array" | "number" | "object" };

export type VerifyStrategy =
  | {
      kind: "http";
      /** https origin of the vendor, fixed in this file. Nothing the owner types ever becomes part of a URL. */
      origin: string;
      /** Always a GET. */
      path: string;
      /** Fixed query (no key in it), e.g. `limit=1`; empty when none. */
      query: string;
      /** Where the key goes. `bearer` = `Authorization: Bearer <key>`; `raw` = the header holds the key as is. */
      auth: { header: string; scheme: "bearer" | "raw" };
      /** Other fixed headers the vendor requires. Never a secret. */
      headers: Readonly<Record<string, string>>;
      /** HTTP statuses that mean "the vendor does not accept this key". */
      rejectStatuses: readonly number[];
      expect: ExpectShape;
      /** The vendor's documentation of this request. */
      docUrl: string;
    }
  | {
      kind: "format_only";
      /** The vendor page that was read, when there is one. */
      docUrl: string | null;
    };

export interface ModelKeyProvider {
  id: ModelKeyProviderId;
  name: string;
  /** The vendor's own page for creating an API key; null = link unverified. */
  keyUrl: string | null;
  /** The documentation page the keyUrl was read on (for the reviewer; null when keyUrl is null). */
  keyUrlSource: string | null;
  /**
   * The GitHub Actions secrets the deploy maps into the worker's environment for this vendor (deploy/.env.worker.example,
   * .github/workflows/deploy_web.yml). The vendor "has an env key" when EVERY name of ANY one set is configured.
   */
  envSets: readonly (readonly string[])[];
  strategy: VerifyStrategy;
  /** The vendor can limit a key to some endpoints, so a refusal on the check can also mean "this key may not read that". */
  scopedKeys: boolean;
  /** Kling signs requests with an access key and a secret key, so its single field takes `access_key:secret_key`. */
  pairedKey?: boolean;
  /** The check is made in one region of the vendor; a valid key of another region can be refused by it. */
  regionBound?: boolean;
}

const json = (rest: { auth: VerifyStrategyHttp["auth"] } & Partial<VerifyStrategyHttp> & Pick<VerifyStrategyHttp, "origin" | "path" | "docUrl" | "expect">): VerifyStrategyHttp => ({
  kind: "http",
  query: "",
  headers: {},
  rejectStatuses: [401, 403],
  ...rest,
});
type VerifyStrategyHttp = Extract<VerifyStrategy, { kind: "http" }>;

/**
 * Every vendor, in display order. Each `docUrl` and `keyUrlSource` below was opened and read on 2026-10-25; the request shapes are the
 * vendors' own examples. Nothing here was CALLED with a key (no key was used in building this).
 */
export const MODEL_KEY_PROVIDERS: readonly ModelKeyProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlSource: "https://developers.openai.com/api/docs/quickstart",
    envSets: [["OPENAI_API_KEY"]],
    scopedKeys: true,
    strategy: json({
      origin: "https://api.openai.com",
      path: "/v1/models",
      auth: { header: "Authorization", scheme: "bearer" },
      expect: { kind: "field", name: "data", type: "array" },
      docUrl: "https://developers.openai.com/api/reference/resources/models/methods/list",
    }),
  },
  {
    id: "google",
    name: "Google (Gemini API, Veo)",
    keyUrl: "https://aistudio.google.com/apikey",
    keyUrlSource: "https://ai.google.dev/gemini-api/docs/api-key",
    envSets: [["GEMINI_API_KEY"], ["VEO_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://generativelanguage.googleapis.com",
      path: "/v1beta/models",
      auth: { header: "x-goog-api-key", scheme: "raw" },
      // Google answers a key it does not know with 400 (API key not valid), a key without permission with 403.
      rejectStatuses: [400, 401, 403],
      expect: { kind: "field", name: "models", type: "array" },
      docUrl: "https://ai.google.dev/api/models",
    }),
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    keyUrlSource: "https://docs.x.ai/developers/quickstart",
    envSets: [["XAI_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.x.ai",
      path: "/v1/models",
      auth: { header: "Authorization", scheme: "bearer" },
      // xAI's own table: 401 = no or invalid token, 403 = forbidden; 400 is "check your request", not a key verdict.
      expect: { kind: "field", name: "data", type: "array" },
      docUrl: "https://docs.x.ai/developers/rest-api-reference/inference/models",
    }),
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyUrlSource: "https://elevenlabs.io/docs/overview/administration/workspaces/api-keys",
    envSets: [["ELEVENLABS_API_KEY"]],
    scopedKeys: true,
    strategy: json({
      origin: "https://api.elevenlabs.io",
      path: "/v1/models",
      auth: { header: "xi-api-key", scheme: "raw" },
      expect: { kind: "array" },
      docUrl: "https://elevenlabs.io/docs/api-reference/models/list",
    }),
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    keyUrl: "https://www.assemblyai.com/dashboard/home",
    keyUrlSource: "https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file",
    envSets: [["ASSEMBLYAI_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.assemblyai.com",
      path: "/v2/transcript",
      query: "limit=1",
      // The key goes in the Authorization header as is, with no scheme word.
      auth: { header: "Authorization", scheme: "raw" },
      expect: { kind: "field", name: "page_details", type: "object" },
      docUrl: "https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/list",
    }),
  },
  {
    id: "bfl",
    name: "Black Forest Labs (FLUX)",
    keyUrl: "https://dashboard.bfl.ai",
    keyUrlSource: "https://docs.bfl.ml/quick_start/get_started",
    envSets: [["BFL_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.bfl.ai",
      path: "/v1/credits",
      auth: { header: "x-key", scheme: "raw" },
      expect: { kind: "field", name: "credits", type: "number" },
      docUrl: "https://docs.bfl.ml/api-reference/get-the-users-credits",
    }),
  },
  {
    id: "recraft",
    name: "Recraft",
    keyUrl: "https://app.recraft.ai/profile/api",
    keyUrlSource: "https://www.recraft.ai/docs/api-reference/models/recraft-v4-1",
    envSets: [["RECRAFT_API_TOKEN"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://external.api.recraft.ai",
      path: "/v1/users/me",
      auth: { header: "Authorization", scheme: "bearer" },
      // Recraft's own table: 401 = missing or invalid token (text/plain "request unauthorized"). The documented answer is "information of
      // the current user including credits balance"; its fields are not listed, so only "a JSON object" counts as an answer.
      expect: { kind: "object" },
      docUrl: "https://www.recraft.ai/docs/api-reference/endpoints",
    }),
  },
  {
    id: "ideogram",
    name: "Ideogram",
    keyUrl: "https://ideogram.ai/platform",
    keyUrlSource: "https://developer.ideogram.ai/v2/ideogram-api/api-setup",
    envSets: [["IDEOGRAM_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.ideogram.ai",
      // The only account read in the documentation. It answers 404 for a key whose owner is not an organization admin, which is NOT a
      // verdict on the key, so only 200 verifies and only 401 rejects; a 404 reads "could not verify".
      path: "/v2/account/api-keys",
      auth: { header: "Api-Key", scheme: "raw" },
      rejectStatuses: [401],
      expect: { kind: "field", name: "api_keys", type: "array" },
      docUrl: "https://developer.ideogram.ai/v2/api-reference/account/api-keys",
    }),
  },
  {
    id: "minimax",
    name: "MiniMax (Hailuo)",
    keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    keyUrlSource: "https://platform.minimax.io/docs/guides/quickstart-preparation",
    envSets: [["MINIMAX_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.minimax.io",
      path: "/v1/models",
      auth: { header: "Authorization", scheme: "bearer" },
      expect: { kind: "field", name: "data", type: "array" },
      docUrl: "https://platform.minimax.io/docs/api-reference/models/openai/list-models",
    }),
  },
  {
    id: "runway",
    name: "Runway",
    keyUrl: "https://dev.runway.com",
    keyUrlSource: "https://docs.dev.runwayml.com/ai-context.md",
    envSets: [["RUNWAYML_API_SECRET"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.dev.runwayml.com",
      path: "/v1/organization",
      auth: { header: "Authorization", scheme: "bearer" },
      headers: { "X-Runway-Version": "2024-11-06" },
      expect: { kind: "field", name: "creditBalance", type: "number" },
      docUrl: "https://docs.dev.runwayml.com/api.md",
    }),
  },
  {
    id: "luma",
    name: "Luma (Ray)",
    keyUrl: "https://platform.lumalabs.ai/",
    keyUrlSource: "https://docs.lumalabs.ai/reference/getcredits.md",
    envSets: [["LUMA_AGENTS_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://agents.lumalabs.ai",
      // Lists the account's own uploaded files: a read that creates nothing.
      path: "/v1/files",
      query: "limit=1",
      auth: { header: "Authorization", scheme: "bearer" },
      expect: { kind: "object" },
      docUrl: "https://docs.agents.lumalabs.ai/api/resources/files/methods/list/",
    }),
  },
  {
    id: "krea",
    name: "Krea (Krea 3)",
    keyUrl: "https://www.krea.ai/settings/api-tokens",
    keyUrlSource: "https://www.krea.ai/docs/developers/api-keys-and-billing.md",
    envSets: [["KREA_API_KEY"]],
    scopedKeys: false,
    strategy: json({
      origin: "https://api.krea.ai",
      // Lists the token's own jobs, one at most: a read that creates nothing and is not billed (Krea's OpenAPI document, which its docs link
      // as the API reference). The document lists only 401 for a bad token (400 is a bad query, which this fixed query is not).
      path: "/jobs",
      query: "limit=1",
      auth: { header: "Authorization", scheme: "bearer" },
      rejectStatuses: [401],
      expect: { kind: "field", name: "items", type: "array" },
      docUrl: "https://api.krea.ai/openapi.json",
    }),
  },
  {
    id: "lightricks",
    name: "Lightricks (LTX)",
    // The authentication page says "Sign in to the Developer Console to create your API key" and names no address in the text read, so no
    // link is offered.
    keyUrl: null,
    keyUrlSource: null,
    envSets: [["LTX_API_KEY"]],
    scopedKeys: false,
    // LTX's own OpenAPI document (docs.ltx.io/openapi.json) has no read that needs no job id: every path is a POST that starts a billed
    // generation, plus GET /v2/{endpoint}/{id} for one job. No free account, credits or models call exists, so the key is never sent anywhere.
    strategy: { kind: "format_only", docUrl: "https://docs.ltx.io/openapi.json" },
  },
  {
    id: "pika",
    name: "Pika (Pika 2.5)",
    keyUrl: "https://dev.pika.art/keys",
    keyUrlSource: "https://dev.pika.art/llms.txt",
    envSets: [["PIKA_API_KEY"]],
    scopedKeys: false,
    // The one free read is the org balance (GET /billing/balance, "never charged"; llms.txt: the same API key reads it and a 200 "proves the
    // key is active"). But Pika's OpenAPI document describes the /billing Bearer scheme as "a console session JWT" and lists the API-key header
    // as the other accepted scheme, so which of the two the balance read takes was not settled by the pages, and a 401 or 403 from it would be
    // read here as "the vendor rejected this key" about a key that is fine. Until a live probe confirms it, the key is never sent anywhere.
    strategy: { kind: "format_only", docUrl: "https://dev.pika.art/llms.txt" },
  },
  {
    id: "vidu",
    name: "Vidu (Q3, Q4 preview)",
    // The FAQ says only "create a new API key under the 'API Key Management' menu of the platform" and no page read names its address, so
    // no link is offered.
    keyUrl: null,
    keyUrlSource: null,
    envSets: [["VIDU_API_KEY"]],
    scopedKeys: false,
    // The one read that creates nothing is Account Balance (GET /ent/v2/credits, docs: api-reference/task-management/account-balance), but its
    // page lists a REQUIRED `show_detail` parameter in the body of a GET, and its example answer names a field (`remains`) its own table calls
    // `remaining_credits`. A check built on that would be a guess, so the key is never sent anywhere. docUrl is the FAQ page that says where
    // keys are made.
    strategy: { kind: "format_only", docUrl: "https://platform.vidu.com/docs/overview/faq" },
  },
  {
    id: "alibaba",
    name: "Alibaba Cloud (Wan)",
    keyUrl: "https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key",
    keyUrlSource: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    envSets: [["WAN_API_KEY"]],
    scopedKeys: false,
    regionBound: true,
    strategy: json({
      // The Singapore endpoint of the documentation. A key from another region or a workspace host can be refused here although it is valid
      // there, which is why a refusal reads "the vendor did not accept it" and the page tells the owner which region this checks.
      origin: "https://dashscope-intl.aliyuncs.com",
      path: "/api/v1/models",
      query: "page_size=1",
      auth: { header: "Authorization", scheme: "bearer" },
      expect: { kind: "field", name: "output", type: "object" },
      docUrl: "https://www.alibabacloud.com/help/en/model-studio/list-models",
    }),
  },
  {
    id: "kling",
    name: "Kling",
    // The documentation site is JavaScript-only: no page naming the key console could be read, so no link is offered.
    keyUrl: null,
    keyUrlSource: null,
    envSets: [["KLING_API_KEY"], ["KLING_ACCESS_KEY", "KLING_SECRET_KEY"]],
    scopedKeys: false,
    pairedKey: true,
    strategy: { kind: "format_only", docUrl: null },
  },
  {
    id: "bytedance",
    name: "BytePlus ModelArk (Seedance)",
    keyUrl: "https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey",
    keyUrlSource: "https://docs.byteplus.com/en/docs/modelark/manage-api-keys",
    envSets: [["SEEDANCE_API_KEY"]],
    scopedKeys: false,
    // The documented model-list call is a control-plane operation of the BytePlus account, not a call made with a ModelArk API key; no free
    // call for the key itself is documented.
    strategy: { kind: "format_only", docUrl: "https://docs.byteplus.com/en/docs/modelark/manage-api-keys" },
  },
];

export function getModelKeyProvider(id: string): ModelKeyProvider | null {
  return MODEL_KEY_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The names the owner sets in GitHub for this vendor (the first set; what the page tells him to create). */
export function primaryEnvNames(p: ModelKeyProvider): readonly string[] {
  return p.envSets[0] ?? [];
}

// ── the key the owner typed ──────────────────────────────────────────────────────────────────────────────────────────────

export const MODEL_KEY_MIN_CHARS = 16;
export const MODEL_KEY_MAX_CHARS = 512;

export type KeyShape = { ok: true; key: string } | { ok: false; reason: "empty" | "too_short" | "too_long" | "bad_shape" | "bad_pair" };

/**
 * One printable token. The same rule the worker-secret route applies to a provider key (secret-validators.ts checkToken: printable ASCII,
 * no whitespace, none of `$ \` " ' \`, which a deploy file or a shell reads as syntax) and the same bounds as the database function
 * (16 to 512 characters). A reason code, never the value.
 */
export function checkModelKeyShape(provider: ModelKeyProvider, raw: unknown): KeyShape {
  if (typeof raw !== "string") return { ok: false, reason: "bad_shape" };
  const key = raw.trim();
  if (!key) return { ok: false, reason: "empty" };
  if (key.length < MODEL_KEY_MIN_CHARS) return { ok: false, reason: "too_short" };
  if (key.length > MODEL_KEY_MAX_CHARS) return { ok: false, reason: "too_long" };
  const token = validateSecretValue(primaryEnvNames(provider)[0] ?? "MODEL_API_KEY", key);
  if (!token.ok) return { ok: false, reason: "bad_shape" };
  if (provider.pairedKey && key.includes(":")) {
    const [access, secret, ...rest] = key.split(":");
    if (!access || !secret || rest.length > 0) return { ok: false, reason: "bad_pair" };
  }
  return { ok: true, key: token.value };
}

// ── what the owner sees ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The verdict of one check, for this visit only. `not_checked` is the state of a card nobody has used yet; `checking` is a request in flight.
 * Nothing here survives a reload: the key was not saved, so there is nothing to remember.
 */
export type KeyState = "not_checked" | "checking" | "verified" | "rejected" | "format_only" | "could_not_reach";

export type VerifyOutcome =
  | { outcome: "verified" }
  | { outcome: "rejected" }
  | { outcome: "could_not_reach"; reason: CouldNotReachReason };
export type CouldNotReachReason = "timeout" | "network" | "rate_limited" | "vendor_error" | "redirect" | "unexpected_response";

/**
 * Which key a run uses today. Workers read the environment only, and this page only ever sees the NAMES of the GitHub secrets:
 *   env      a GitHub secret the deploy maps into the worker is set; this is the key a run uses.
 *   none     it is not set; a run that needs this vendor stops before it spends anything.
 *   unknown  the secret names could not be read (GitHub not configured, or the read failed). Never shown as "none".
 */
export type KeySource = "env" | "none" | "unknown";

export function keySource(envSet: boolean | null): KeySource {
  if (envSet === null) return "unknown";
  return envSet ? "env" : "none";
}

/**
 * Does `configured` (the GitHub secret names) hold every name of any one of the vendor's sets?
 * `true` when a whole set was seen. Otherwise `false` only when the listing is known to be COMPLETE; a listing that is missing (`null`) or
 * may be cut short (`complete: false`) says "unknown", never "not set" (CLAUDE.md rule 5).
 */
export function envKeySet(p: ModelKeyProvider, configured: readonly string[] | null, complete = true): boolean | null {
  if (configured === null) return null;
  const have = new Set(configured);
  if (p.envSets.some((names) => names.length > 0 && names.every((n) => have.has(n)))) return true;
  return complete ? false : null;
}

/** Every secret name any vendor's sets mention: what the page asks GitHub about (the Providers board's allowlist does not know them all). */
export const ALL_ENV_NAMES: readonly string[] = Array.from(new Set(MODEL_KEY_PROVIDERS.flatMap((p) => p.envSets.flat())));

/** The exact name(s) to set, as one line: `A`, `A or B + C` (a set joined with +, alternatives with "or"). */
export function envNamesText(p: ModelKeyProvider): string {
  return p.envSets.map((names) => names.join(" + ")).join(" or ");
}

// ── the switch ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Only the literal `on` turns the feature on. Anything else, empty included, is off. */
export function parseModelKeysFlag(value: string | undefined | null): boolean {
  return (value ?? "").trim().toLowerCase() === "on";
}

// ── the route's body ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelKeyRequest {
  provider: ModelKeyProvider;
  key: string;
}

export type ParsedRequest =
  | { ok: true; request: ModelKeyRequest }
  | { ok: false; error: "bad_request" | "unknown_provider" | "bad_key"; reason?: string };

/** The refusal never carries the key, nor anything derived from it but a reason word. */
export function parseModelKeyRequest(body: unknown): ParsedRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_request" };
  const b = body as Record<string, unknown>;
  if (b.action !== "verify") return { ok: false, error: "bad_request" };
  const provider = typeof b.provider === "string" ? getModelKeyProvider(b.provider) : null;
  if (!provider) return { ok: false, error: "unknown_provider" };
  const shape = checkModelKeyShape(provider, b.key);
  if (!shape.ok) return { ok: false, error: "bad_key", reason: shape.reason };
  return { ok: true, request: { provider, key: shape.key } };
}

// ── what the page is built from ────────────────────────────────────────────────────────────────────────────────────────────

/** One card, as plain data the client component draws. Holds no secret and nothing about a key. */
export interface CardView {
  id: ModelKeyProviderId;
  name: string;
  keyUrl: string | null;
  docUrl: string | null;
  /** `http`: one free request is made. `format_only`: the key is never sent anywhere. */
  mode: "http" | "format_only";
  host: string | null;
  path: string | null;
  scopedKeys: boolean;
  regionBound: boolean;
  pairedKey: boolean;
  source: KeySource;
  /** The exact name(s) to set in GitHub Actions secrets and the worker environment. */
  envNames: string;
}

/** `configured` = the GitHub secret names (null when they could not be read); `complete` = false when the listing may be cut short. */
export function buildCards(configured: readonly string[] | null, complete = true): CardView[] {
  return MODEL_KEY_PROVIDERS.map((p) => {
    const http = p.strategy.kind === "http" ? p.strategy : null;
    return {
      id: p.id,
      name: p.name,
      keyUrl: p.keyUrl,
      docUrl: p.strategy.docUrl,
      mode: p.strategy.kind,
      host: http ? new URL(http.origin).host : null,
      path: http ? http.path : null,
      scopedKeys: p.scopedKeys,
      regionBound: p.regionBound === true,
      pairedKey: p.pairedKey === true,
      source: keySource(envKeySet(p, configured, complete)),
      envNames: envNamesText(p),
    };
  });
}
