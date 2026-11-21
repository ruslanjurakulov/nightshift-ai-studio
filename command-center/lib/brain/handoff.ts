/**
 * Client-side pieces of Nightshift AI's hand-offs. Nothing here spends: the run and the film were started by the person's own press
 * on their own screens. These only tell the conversation what happened, and the database reads the job's hold and the film's
 * scenes itself (0199's ai_chat_record_handoff).
 */

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation a Run-now page was opened from (`?brain=<session>`, lib/brain/logic runLink), or null. */
export function brainSessionFromUrl(search: string): string | null {
  const id = new URLSearchParams(search).get("brain");
  return id && SESSION_ID.test(id) ? id : null;
}

/**
 * After Run now queued a job from a Brain plan: record it on the conversation (best effort; a failure here never touches the run,
 * which is already queued and priced).
 */
export async function recordRunHandoff(session: string, channelId: string, jobId: unknown, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!SESSION_ID.test(session) || !channelId) return false;
  try {
    const res = await fetchImpl("/api/brain/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "handoff",
        session,
        handoff: { kind: "run", channel_id: channelId, dispatched_at: new Date().toISOString(), ...(jobId != null ? { job_id: String(jobId) } : {}) },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The landing page's idea (S4): localStorage `ns.idea.v1` = {text, at}. Read once, then removed; older than 2 hours is dropped. */
export const IDEA_KEY = "ns.idea.v1";
export const IDEA_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function takeLandingIdea(store: Pick<Storage, "getItem" | "removeItem"> | null, now = Date.now(), maxChars = 2000): string | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(IDEA_KEY);
    store.removeItem(IDEA_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { text?: unknown; at?: unknown };
    const at = typeof v.at === "number" ? v.at : typeof v.at === "string" ? Date.parse(v.at) : NaN;
    if (typeof v.text !== "string" || !Number.isFinite(at) || at > now + 60_000 || now - at > IDEA_MAX_AGE_MS) return null;
    const text = v.text.trim();
    return text ? Array.from(text).slice(0, maxChars).join("") : null;
  } catch {
    return null;
  }
}
