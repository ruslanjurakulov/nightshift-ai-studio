/**
 * Whether Nightshift AI is open for a workspace. Off unless the server says otherwise:
 *   NIGHTSHIFT_AI_CHAT=off   (or unset) — nowhere: the panel is not rendered and the route answers 404;
 *   NIGHTSHIFT_AI_CHAT=orgs  — only the workspaces listed in NIGHTSHIFT_AI_CHAT_ORGS (comma-separated ids: the owner's and the demo's);
 *   NIGHTSHIFT_AI_CHAT=on    — every workspace.
 * Anything else reads as off: a typo never opens a feature that spends the platform's money.
 */

export type AiChatMode = "off" | "orgs" | "on";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function aiChatMode(env: Record<string, string | undefined>): AiChatMode {
  const v = (env.NIGHTSHIFT_AI_CHAT ?? "").trim().toLowerCase();
  return v === "on" || v === "orgs" ? v : "off";
}

export function aiChatOrgs(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env.NIGHTSHIFT_AI_CHAT_ORGS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => UUID.test(s)),
  );
}

/** The two flag variables, read by literal names (tests/test_deploy_self_host.py): pass this, never the whole environment. */
export function aiChatEnv(): Record<string, string | undefined> {
  return { NIGHTSHIFT_AI_CHAT: process.env.NIGHTSHIFT_AI_CHAT, NIGHTSHIFT_AI_CHAT_ORGS: process.env.NIGHTSHIFT_AI_CHAT_ORGS };
}

export function aiChatOpenFor(orgId: string | null | undefined, env: Record<string, string | undefined>): boolean {
  if (!orgId) return false;
  const mode = aiChatMode(env);
  if (mode === "on") return true;
  if (mode === "orgs") return aiChatOrgs(env).has(orgId.toLowerCase());
  return false;
}
