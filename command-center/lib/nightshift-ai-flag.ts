/**
 * Is Nightshift AI (the S5 assistant panel, docs/studio/NIGHTSHIFT_AI.md on draft PR #844) open for this workspace?
 *
 * STAND-IN: S5's own flag function is not on main yet. This parses the same two variables exactly as that contract describes, so
 * the start box (components/prompt/StartBox.tsx) can show its Agent chip honestly today. Replace it with S5's function when #844
 * merges, and delete this file; nothing else should grow a third copy of the rule.
 *
 *   NIGHTSHIFT_AI_CHAT       off | orgs | on       anything else (unset, "yes", "ON", "1") is off: a typo never opens it
 *   NIGHTSHIFT_AI_CHAT_ORGS  comma-separated org ids, read only in `orgs` mode; an entry that is not a uuid is dropped
 *
 * Paid plans only (Plus, Pro, Business; the operator's exempt workspace counts as paid). A plan that could not be read is not
 * assumed either way: the chip stays closed and says the plan could not be checked (rule 5), never "on paid plans".
 *
 * Server-only in practice (it reads process.env by default), but pure, so tests pass their own env.
 */

export const AI_CHAT_MODES = ["off", "orgs", "on"] as const;
export type AiChatMode = (typeof AI_CHAT_MODES)[number];

/** What the server knows of the workspace's plan. */
export type AiPlan = "paid" | "free" | "unknown";

/** Why the chip is closed, in the order it is checked: the workspace first (a free workspace not on the list hears "not open"). */
export type AiClosedReason = "workspace" | "plan" | "plan_unknown";
export type NightshiftAiAccess = { open: true } | { open: false; reason: AiClosedReason };

type Env = Readonly<Record<string, string | undefined>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * S5's panel itself is not on this branch: `/studio?ai=new` has nothing to open, so the Studio page sends it to Create's prefilled
 * box instead (app/(app)/[channel]/studio/page.tsx). Turn this on in the PR that brings the panel.
 */
export const NIGHTSHIFT_AI_PANEL_AVAILABLE = false;

export function aiChatMode(env: Env = process.env): AiChatMode {
  const raw = env.NIGHTSHIFT_AI_CHAT?.trim();
  return raw === "orgs" || raw === "on" ? raw : "off";
}

export function aiChatOrgs(env: Env = process.env): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of (env.NIGHTSHIFT_AI_CHAT_ORGS ?? "").split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID_RE.test(id)) out.add(id);
  }
  return out;
}

/** The flag's half of the answer: is this workspace let in at all (before its plan is asked)? */
export function nightshiftAiWorkspaceOn(orgId: string | null, env: Env = process.env): boolean {
  if (!orgId) return false;
  const mode = aiChatMode(env);
  if (mode === "on") return true;
  if (mode === "orgs") return aiChatOrgs(env).has(orgId.toLowerCase());
  return false;
}

export function nightshiftAiAccess(orgId: string | null, plan: AiPlan, env: Env = process.env): NightshiftAiAccess {
  if (!nightshiftAiWorkspaceOn(orgId, env)) return { open: false, reason: "workspace" };
  if (plan === "paid") return { open: true };
  return { open: false, reason: plan === "free" ? "plan" : "plan_unknown" };
}

export function nightshiftAiOpen(orgId: string | null, plan: AiPlan, env: Env = process.env): boolean {
  return nightshiftAiAccess(orgId, plan, env).open;
}
