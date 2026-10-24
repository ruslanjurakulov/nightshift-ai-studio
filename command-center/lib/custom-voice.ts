/**
 * Custom voice, the pure half of the Command Center (slice V3, docs/CUSTOM_VOICE.md): the switch, the constants, and the
 * translation of what the database says into closed words a screen can word. No network, no React, safe in the middleware.
 *
 * THE SWITCH. `CUSTOM_VOICE_ENABLED=1`, read at request time from the server's environment (never `NEXT_PUBLIC_`, so it is not
 * baked into a bundle). Only the literal "1" is on; anything else, including unset, is OFF. OFF, the page answers the public 404
 * and asks the database nothing: the middleware decides before the auth gate (so before any Supabase call) and the page checks the
 * flag again as its first statement. The switch is not the grant: the request function (0117) is still granted to nobody (0117), so even
 * with the switch on a person who starts a voice gets a translated "not available yet" until the owner ships the grant.
 *
 * WHAT THIS FILE NEVER HOLDS. A provider's voice id, the owner reference, a hash or a sample path are not read into the screen:
 * `PROFILE_COLUMNS` is the whole list of columns the page selects, and none of those four is in it.
 */

/** The environment variable that switches the custom voice page on. */
export const CUSTOM_VOICE_FLAG = "CUSTOM_VOICE_ENABLED";

/** On only for the literal "1". "true", "yes", " 1" and the empty string are off. */
export function customVoiceEnabled(env?: Record<string, string | undefined>): boolean {
  // A literal read of the variable's name, because the deploy template test scans for those; an injected map is for tests.
  const value = env ? env[CUSTOM_VOICE_FLAG] : process.env.CUSTOM_VOICE_ENABLED;
  return value === "1";
}

/** The one page, under a channel's agents area: /{channel}/agents/voice. */
export function isCustomVoicePath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // An undecodable path is not this page; the router will not match it either.
    return false;
  }
  const segments = path.replace(/\/+$/, "").toLowerCase().split("/").slice(1);
  if (segments.length !== 3) return false;
  const last = segments[2].replace(/\.rsc$/, "");
  return segments[1] === "agents" && last === "voice";
}

/** `hide`: flag off and this is the page: the public 404. `none`: not this page, or the flag is on and the gate decides as usual. */
export function customVoiceDecision(pathname: string, enabled: boolean): "hide" | "none" {
  return !enabled && isCustomVoicePath(pathname) ? "hide" : "none";
}

/**
 * The version of the consent text a person agrees to, written to the append-only consent trail. "v0" is the PLACEHOLDER: the
 * wording is not written (counsel). Recording "v1" for text nobody has reviewed would be a false record of what was agreed, so the
 * placeholder has its own version, and counsel's text ships as v1 together with the change of this constant.
 */
export const CONSENT_TEXT_VERSION = "v0";
/** True while the consent text is a placeholder. The page shows the "counsel review required" marker for as long as it is. */
export const CONSENT_TEXT_IS_PLACEHOLDER = true;

/** The five declarations 0117 requires, all true and nothing else (voice_declarations_problem). The order is the order shown. */
export const DECLARATION_KEYS = ["own_voice", "sole_speaker", "over_18", "voice_data_to_provider", "no_impersonation"] as const;
export type DeclarationKey = (typeof DECLARATION_KEYS)[number];

/** The recording guard: shorter or longer than this is not sent. The worker measures the real length again (it never believes this). */
export const MIN_RECORDING_SECONDS = 30;
export const MAX_RECORDING_SECONDS = 60;

export const NAME_MIN = 2;
export const NAME_MAX = 60;

/** The private bucket of 0117, and the content types it accepts. */
export const SAMPLE_BUCKET = "voice-samples";

/**
 * What the recorder produced -> the file extension the bucket's rule accepts (`sample.<ext>`) and the content type to declare.
 * The declared type is the base type only: whether Storage accepts `audio/webm;codecs=opus` against its allow-list is unverified
 * (docs/CUSTOM_VOICE.md, "The bucket").
 */
const SAMPLE_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/** `{ type: "audio/webm", ext: "webm" }` for a recorder's mime type (parameters such as codecs ignored), or null if the bucket cannot take it. */
export function sampleTypeFor(mime: string | null | undefined): { type: string; ext: string } | null {
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  const ext = SAMPLE_TYPES[base];
  return ext ? { type: base, ext } : null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const PREFIX_RE = new RegExp(`^(${UUID})/(${UUID})/$`);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** An idempotency key the database accepts (1-255 of A-Z a-z 0-9 _ : . -). One per request; a retry of the same request reuses it. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `cv-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `cv-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the database returns, checked before the screen believes it
// ---------------------------------------------------------------------------------------------------------------------

export type VoiceStatus = "pending_verification" | "testing" | "approved" | "rejected" | "deleted";
export type SampleState = "awaiting" | "stored" | "purge_pending" | "purged";

/** One of the owner's voices as the screen sees it. No provider voice id, owner reference, hash or path: see the file header. */
export type VoiceProfileView = {
  id: string;
  name: string;
  /** A status this build does not know is shown as unknown, never as one it does. */
  status: VoiceStatus | "unknown";
  rejectReason: string | null;
  sampleState: SampleState | "unknown";
  keepSample: boolean;
  createdAt: string;
};

/** The columns the page selects from voice_profiles. Adding provider_voice_id, owner_ref or sample_sha256 here is a test failure. */
export const PROFILE_COLUMNS = "id,name,status,reject_reason,sample_state,keep_sample,created_at";

const STATUSES: readonly string[] = ["pending_verification", "testing", "approved", "rejected", "deleted"];
const SAMPLE_STATES: readonly string[] = ["awaiting", "stored", "purge_pending", "purged"];

/** Rows from the table API -> views. A row without a usable id or name is dropped; anything else odd becomes "unknown". */
export function coerceProfiles(data: unknown): VoiceProfileView[] {
  if (!Array.isArray(data)) return [];
  const out: VoiceProfileView[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (!isUuid(r.id) || typeof r.name !== "string") continue;
    out.push({
      id: r.id,
      name: r.name,
      status: typeof r.status === "string" && STATUSES.includes(r.status) ? (r.status as VoiceStatus) : "unknown",
      rejectReason: typeof r.reject_reason === "string" ? r.reject_reason : null,
      sampleState: typeof r.sample_state === "string" && SAMPLE_STATES.includes(r.sample_state) ? (r.sample_state as SampleState) : "unknown",
      keepSample: r.keep_sample === true,
      createdAt: typeof r.created_at === "string" ? r.created_at : "",
    });
  }
  return out;
}

export type ActiveAttachment = { profileId: string; channelId: string; slot: "narrator" | "secondary" };

export const ATTACHMENT_COLUMNS = "voice_profile_id,channel_id,slot,status";

export function coerceAttachments(data: unknown): ActiveAttachment[] {
  if (!Array.isArray(data)) return [];
  const out: ActiveAttachment[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.status !== "active" || !isUuid(r.voice_profile_id) || typeof r.channel_id !== "string") continue;
    if (r.slot !== "narrator" && r.slot !== "secondary") continue;
    out.push({ profileId: r.voice_profile_id, channelId: r.channel_id, slot: r.slot });
  }
  return out;
}

/** What a started request hands back: the phrase to read, where the recording goes, and when the request lapses. */
export type StartedRequest = { profileId: string; phrase: string; prefix: string; expiresAt: string | null };

/**
 * The answer of the request function, or null when it is not a usable one. The phrase is the database's (six words of a fixed
 * list), so a value that is not lower-case words is refused rather than shown; the upload prefix must be `<uid>/<profile>/` of THIS
 * profile, because it is the only place the recording is allowed to go.
 */
export function parseStartedRequest(data: unknown): StartedRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.ok !== true || !isUuid(d.profile_id)) return null;
  if (typeof d.phrase !== "string" || !/^[a-z]+( [a-z]+){2,11}$/.test(d.phrase)) return null;
  const prefix = typeof d.upload_prefix === "string" ? PREFIX_RE.exec(d.upload_prefix) : null;
  if (!prefix || prefix[2] !== d.profile_id) return null;
  return {
    profileId: d.profile_id,
    phrase: d.phrase,
    prefix: d.upload_prefix as string,
    expiresAt: typeof d.expires_at === "string" && !Number.isNaN(Date.parse(d.expires_at)) ? d.expires_at : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors -> closed words
// ---------------------------------------------------------------------------------------------------------------------

type RpcError = { code?: string | null; message?: string | null; hint?: string | null; status?: number | null } | null | undefined;

/**
 * Why a call failed, as a closed word the screen words in the person's language. The raw message is never shown.
 *  - notAvailable: the function is not granted to the caller (the request function is granted to nobody until the owner decides)
 *    or not in the database at all (0117 not applied). The expected state today, and a normal one: nothing was recorded or sent.
 */
export type RpcProblem =
  | "notAvailable"
  | "signedOut"
  | "forbidden"
  | "notFound"
  | "rateLimited"
  | "voiceSlots"
  | "orgRequired"
  | "nameLength"
  | "nameCharacters"
  | "nameRealPerson"
  | "nameLink"
  | "declarations"
  | "consentVersion"
  | "keyReused"
  | "network"
  | "failed";

const HINTS: Record<string, RpcProblem> = {
  rate_limited: "rateLimited",
  voice_slots: "voiceSlots",
  org_required: "orgRequired",
  name_length: "nameLength",
  name_characters: "nameCharacters",
  name_real_person: "nameRealPerson",
  name_link: "nameLink",
  declarations_shape: "declarations",
  declarations_unknown: "declarations",
  declarations_incomplete: "declarations",
  consent_version: "consentVersion",
};

export function classifyRpcError(error: RpcError): RpcProblem {
  if (!error) return "failed";
  const code = error.code ?? "";
  const message = error.message ?? "";
  if (code === "PGRST202" || code === "42883" || /could not find the function|function .* does not exist/i.test(message)) return "notAvailable";
  // A function that exists but is not granted to the caller ("permission denied for function ..."), or a table that is not there
  // or not readable yet (0117 not applied): the same "not available yet", never a raw message.
  if (/permission denied for (function|table|relation)/i.test(message)) return "notAvailable";
  if (code === "PGRST205" || code === "42P01" || /could not find the table|relation .* does not exist/i.test(message)) return "notAvailable";
  if (code === "PGRST301" || error.status === 401 || /jwt/i.test(message)) return "signedOut";
  const hint = error.hint ? HINTS[error.hint] : undefined;
  if (hint) return hint;
  if (code === "NS409") return "keyReused";
  if (code === "NS429") return "rateLimited";
  if (code === "42501") {
    if (/sign in first/i.test(message)) return "signedOut";
    return "forbidden";
  }
  if (code === "P0002" || /not_found/.test(message)) return "notFound";
  if (/failed to fetch|networkerror|load failed/i.test(message)) return "network";
  return "failed";
}

/** The closed words 0117 gives for a rejected profile (the worker's and the database's), grouped by what the person can do. */
export type RejectReasonKey =
  | "reasonSampleTimeout"
  | "reasonPhrase"
  | "reasonTooLong"
  | "reasonTooLarge"
  | "reasonNotAudio"
  | "reasonNotReceived"
  | "reasonNotEnabled"
  | "reasonProvider"
  | "reasonOurSide"
  | "reasonUnknown";

const REASONS: Record<string, RejectReasonKey> = {
  sample_timeout: "reasonSampleTimeout",
  verification_failed: "reasonPhrase",
  sample_too_long: "reasonTooLong",
  sample_too_large: "reasonTooLarge",
  not_audio: "reasonNotAudio",
  unreadable_audio: "reasonNotAudio",
  sample_missing: "reasonNotReceived",
  provider_not_enabled: "reasonNotEnabled",
  provider_rejected: "reasonProvider",
  provider_error: "reasonProvider",
  provider_conflict: "reasonProvider",
  bad_job: "reasonProvider",
  // Ours to fix, not the person's: a key, an outage, a tool, a lost worker.
  provider_auth: "reasonOurSide",
  provider_not_configured: "reasonOurSide",
  provider_plan_unknown: "reasonOurSide",
  provider_unavailable: "reasonOurSide",
  provider_redirect: "reasonOurSide",
  storage_error: "reasonOurSide",
  transcribe_failed: "reasonOurSide",
  transcribe_timeout: "reasonOurSide",
  audio_tool_error: "reasonOurSide",
  worker_error: "reasonOurSide",
  worker_lost: "reasonOurSide",
  voice_id_taken: "reasonOurSide",
};

/** The translated-text key for a reject word. A word this build does not know is "unknown": the raw word is never shown. */
export function rejectReasonKey(word: string | null | undefined): RejectReasonKey {
  return (word && Object.prototype.hasOwnProperty.call(REASONS, word) ? REASONS[word] : undefined) ?? "reasonUnknown";
}

/** The approve and attach functions answer {ok:false, error:word} for what is missing. */
export type ActionRefusal = "notTesting" | "notVerified" | "notTested" | "notApproved" | "voiceInUse" | "unknown";
export function actionRefusal(data: unknown): ActionRefusal | null {
  if (!data || typeof data !== "object") return "unknown";
  const d = data as Record<string, unknown>;
  if (d.ok === true) return null;
  switch (d.error) {
    case "not_testing":
      return "notTesting";
    case "not_verified":
      return "notVerified";
    case "not_tested":
      return "notTested";
    case "not_approved":
      return "notApproved";
    case "voice_in_use":
      return "voiceInUse";
    default:
      return "unknown";
  }
}

/** Is the voice in a state the poll should keep watching? Only a request still being checked changes by itself. */
export function isSettled(status: VoiceProfileView["status"]): boolean {
  return status !== "pending_verification";
}

/** The path the recording is uploaded to, from the prefix the database returned. */
export function samplePath(prefix: string, ext: string): string {
  return `${prefix}sample.${ext}`;
}
