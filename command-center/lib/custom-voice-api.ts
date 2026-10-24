/**
 * Custom voice: the calls the screen makes, as the signed-in person, in ONE module (slice V3, docs/CUSTOM_VOICE.md).
 *
 * Why one module. The database functions of migration 0117 are named here and nowhere else in the application: a test
 * (tests/test_voice_profiles_migration.py) fails if any other file under command-center/ names them, so a second caller cannot
 * appear by accident, and the internal functions (the worker's, the purge, the ownership rule) are named by nobody in the
 * application at all. Every call is made with the person's own browser session (the anon key and their login), never the service
 * key: row-level security and the functions' own `auth.uid()` checks decide, and this module only asks and reports.
 *
 * The request function is granted to NOBODY (0117, "Hard gate"). Until the owner ships that grant the first call here answers a
 * permission error, which `classifyRpcError` turns into "notAvailable"; nothing is created, queued or uploaded before it. The
 * recording is uploaded only after it succeeded, into the private bucket path the database itself returned.
 *
 * Nothing here reads a provider voice id, the owner reference, a hash or a path out of the database for display: the table reads
 * select the explicit columns of lib/custom-voice.ts and no others.
 */
import {
  ATTACHMENT_COLUMNS,
  CONSENT_TEXT_VERSION,
  DECLARATION_KEYS,
  PROFILE_COLUMNS,
  SAMPLE_BUCKET,
  actionRefusal,
  classifyRpcError,
  coerceAttachments,
  coerceProfiles,
  parseStartedRequest,
  samplePath,
  type ActionRefusal,
  type ActiveAttachment,
  type RpcProblem,
  type StartedRequest,
  type VoiceProfileView,
} from "@/lib/custom-voice";

type DbError = { code?: string | null; message?: string | null; hint?: string | null; status?: number | null } | null;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError }>;
type Select = {
  select: (columns: string) => {
    order?: (column: string, opts: { ascending: boolean }) => PromiseLike<{ data: unknown; error: DbError }>;
    eq?: (column: string, value: string) => PromiseLike<{ data: unknown; error: DbError }>;
  };
};
type StorageError = { message?: string | null; statusCode?: string | number | null; status?: number | null } | null;
type Storage = {
  from: (bucket: string) => {
    upload: (path: string, body: Blob, opts: { contentType: string; upsert: boolean }) => PromiseLike<{ data: unknown; error: StorageError }>;
  };
};

/** The slice of the browser Supabase client this module uses; a fake in the tests is this shape. */
export type VoiceClient = { rpc: Rpc; from: (table: string) => Select; storage: Storage };

export type Done<T> = ({ ok: true } & T) | { ok: false; problem: RpcProblem };

async function call(client: VoiceClient, fn: string, args: Record<string, unknown>): Promise<{ data: unknown } | { problem: RpcProblem }> {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error) return { problem: classifyRpcError(error) };
    return { data };
  } catch {
    // A thrown fetch is a network problem, never a success and never an unknown state of the database.
    return { problem: "network" };
  }
}

export type DeclarationAnswers = Record<(typeof DECLARATION_KEYS)[number], boolean>;

/** Ask for a voice. The five declarations are sent as given; the database refuses unless all five are true. */
export async function startVoiceRequest(
  client: VoiceClient,
  input: { name: string; declarations: DeclarationAnswers; orgId: string | null; idem: string },
): Promise<Done<{ started: StartedRequest }>> {
  const res = await call(client, "request_voice_clone", {
    p_name: input.name,
    p_declarations: input.declarations,
    p_consent_version: CONSENT_TEXT_VERSION,
    // v1 offers no choice: the recording is deleted right after the voice is made (the default of docs/CUSTOM_VOICE.md).
    p_keep_sample: false,
    p_idem: input.idem,
    p_org: input.orgId,
  });
  if ("problem" in res) return { ok: false, problem: res.problem };
  const started = parseStartedRequest(res.data);
  // An answer with no usable phrase or prefix is not a started request: the person cannot be asked to record without them.
  return started ? { ok: true, started } : { ok: false, problem: "failed" };
}

export type UploadProblem = "expired" | "exists" | "tooLarge" | "network" | "failed";

/**
 * Put the recording in the private bucket at the path the database returned, with the person's own session. The bucket accepts
 * an insert only for a profile of theirs that is still waiting for its sample and only once (upsert would need an update right the
 * bucket does not grant), so "exists" means a recording was already sent for this request.
 */
export async function uploadSample(
  client: VoiceClient,
  started: StartedRequest,
  blob: Blob,
  sample: { type: string; ext: string },
): Promise<{ ok: true } | { ok: false; problem: UploadProblem }> {
  try {
    const { error } = await client.storage
      .from(SAMPLE_BUCKET)
      .upload(samplePath(started.prefix, sample.ext), blob, { contentType: sample.type, upsert: false });
    if (!error) return { ok: true };
    const status = Number(error.statusCode ?? error.status ?? 0);
    const message = error.message ?? "";
    if (status === 409 || /already exists|duplicate/i.test(message)) return { ok: false, problem: "exists" };
    if (status === 413 || /maximum allowed size|too large/i.test(message)) return { ok: false, problem: "tooLarge" };
    // The bucket's rule refuses a profile that is no longer waiting (lapsed after 2 hours, rejected, deleted).
    if (status === 400 || status === 401 || status === 403 || /row-level security|unauthorized|not authorized/i.test(message)) {
      return { ok: false, problem: "expired" };
    }
    if (/failed to fetch|networkerror|load failed/i.test(message)) return { ok: false, problem: "network" };
    return { ok: false, problem: "failed" };
  } catch {
    return { ok: false, problem: "network" };
  }
}

/** The signed-in person's own voices, newest first. Row-level security limits it to their own rows. */
export async function readProfiles(client: VoiceClient): Promise<Done<{ profiles: VoiceProfileView[] }>> {
  try {
    const q = client.from("voice_profiles").select(PROFILE_COLUMNS);
    const { data, error } = await q.order!("created_at", { ascending: false });
    if (error) return { ok: false, problem: classifyRpcError(error) };
    return { ok: true, profiles: coerceProfiles(data) };
  } catch {
    return { ok: false, problem: "network" };
  }
}

/** Where the person's own voices are attached right now (their own rows only). */
export async function readAttachments(client: VoiceClient): Promise<Done<{ attachments: ActiveAttachment[] }>> {
  try {
    const q = client.from("voice_channel_attachments").select(ATTACHMENT_COLUMNS);
    const { data, error } = await q.eq!("status", "active");
    if (error) return { ok: false, problem: classifyRpcError(error) };
    return { ok: true, attachments: coerceAttachments(data) };
  } catch {
    return { ok: false, problem: "network" };
  }
}

export type ActionResult = { ok: true } | { ok: false; problem: RpcProblem } | { ok: false; refusal: ActionRefusal };

async function act(client: VoiceClient, fn: string, args: Record<string, unknown>): Promise<ActionResult> {
  const res = await call(client, fn, args);
  if ("problem" in res) return { ok: false, problem: res.problem };
  const refusal = actionRefusal(res.data);
  return refusal ? { ok: false, refusal } : { ok: true };
}

/** Approve a voice after the owner heard it. The database checks the verification and the completed Studio test. */
export const approveVoice = (client: VoiceClient, profileId: string) => act(client, "approve_voice", { p_profile: profileId });

/** Put an approved voice on a channel as its narrator. The database requires an administrator of the channel's workspace. */
export const attachVoice = (client: VoiceClient, profileId: string, channelId: string) =>
  act(client, "attach_voice_to_channel", { p_profile: profileId, p_channel: channelId, p_slot: "narrator" });

export const detachVoice = (client: VoiceClient, profileId: string, channelId: string) =>
  act(client, "detach_voice_from_channel", { p_profile: profileId, p_channel: channelId });

/** Delete a voice: unusable at once; the copy at the provider and the recording are removed in the background. */
export const deleteVoice = (client: VoiceClient, profileId: string) => act(client, "delete_voice", { p_profile: profileId });

/** Ask for the recording to be deleted (the voice itself is untouched). */
export const deleteVoiceSample = (client: VoiceClient, profileId: string) => act(client, "delete_voice_sample", { p_profile: profileId });
