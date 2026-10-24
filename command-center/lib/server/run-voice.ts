import { isVoiceId } from "@/lib/ttsModels";

/**
 * "Run now" with a voice of its own: may THIS run speak with it (docs/CUSTOM_VOICE.md, "Hard gate")?
 *
 * Why the route asks. Migration 0117 guards a custom (cloned) voice where its id enters the database: a render_jobs row, a
 * creative_jobs row, a write of channels.agent_config. The Actions backend inserts no row, so the Run-now `voice_id` reached the
 * pipeline with no check at all. The answer comes from the same database function the channels guard asks,
 * channel_voice_config_problem(channel, org, old, new), which this route calls AS THE SIGNED-IN USER (0117 grants it to
 * `authenticated` and `service_role` only because that guard runs as the caller). It takes no person: it answers for the CHANNEL
 * path, so a voice is usable only when it is approved, attached to this channel (in the narrator slot) by its owner, in the
 * channel's current organization, and the owner still administers it. A voice that is in no profile answers "fine" and the run
 * goes on exactly as before. The pipeline asks again when the runner starts (modules/voice_gate.py), so a voice detached after the
 * click is still stopped, before anything is spent.
 *
 * Failing closed (CLAUDE.md rules 4 and 6): a voice id that could be a profile's (20 letters and digits, which is all the
 * dispatch ever forwards) and a check that cannot be answered is refused with its own code, never run. The only answer that lets
 * the id through unchecked is "the function does not exist" (0117 not applied: no profile can exist). Nothing here says whether
 * the id is a custom voice, who owns it or why it was refused.
 */

export type RunVoiceProblem = "voice_not_allowed" | "voice_check_unavailable";

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

/** PostgREST's answer to a function that is not there (PGRST202, HTTP 404) and Postgres's own (42883). */
const FUNCTION_ABSENT = /^(PGRST202|42883)$/;

/**
 * Null when the run may use this voice (or the voice is no custom voice, or the input will not be forwarded anyway); otherwise
 * the closed code the route answers with.
 */
export async function runVoiceProblem(
  client: { rpc: Rpc } | null,
  channelId: string,
  orgId: string | null,
  voiceId: string,
): Promise<RunVoiceProblem | null> {
  const voice = voiceId.trim();
  // The dispatch and the queue row forward a voice only in this shape (dispatchDailyVideo, buildRenderJobInsert); anything else
  // is dropped, so it cannot reach a narrator and cannot be a profile's.
  if (!voice || !isVoiceId(voice)) return null;
  if (!client) return "voice_check_unavailable";
  try {
    const { data, error } = await client.rpc("channel_voice_config_problem", {
      p_channel: channelId,
      p_org: orgId,
      p_old: {},
      p_new: { elevenlabs_voice_id: voice },
    });
    if (error) return FUNCTION_ABSENT.test(error.code ?? "") ? null : "voice_check_unavailable";
    if (data === null) return null;
    if (typeof data === "string") return "voice_not_allowed";
    return "voice_check_unavailable";
  } catch {
    return "voice_check_unavailable";
  }
}
