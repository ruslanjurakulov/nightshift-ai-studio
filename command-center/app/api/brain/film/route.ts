import { createClient, getUser } from "@/lib/supabase/server";
import { requireOrgRole } from "@/lib/auth/org-roles";
import { rejectCrossOrigin } from "@/lib/server/same-origin";
import { readJsonBodyCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";
import { readAgeState } from "@/lib/server/age";
import { getLocale } from "@/lib/i18n/server";
import { filmGateFor } from "@/lib/server/films";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { aiChatEnv, aiChatMode, aiChatOpenFor } from "@/lib/brain/flag";
import { brainJson, notFound } from "@/lib/server/brain/session";
import { filmLeaseView, filmRefusal, planFilm, planPrecheck, readPlanFilm, type PlanFilm } from "@/lib/server/brain/film-plan";
import { plain } from "@/lib/brain/logic";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The same as /api/brain/turn's `choose`: the outline and the plan's calls run inside lib/server/brain/plan.ts PLAN_BUDGET_MS, and
// 0211's lease expires after 320 s. A proxy in front of the self-hosted server must allow a request this long (Lens L2 on #933).
export const maxDuration = 300;

/**
 * The film editor's "Write the storyboard with AI" (docs/studio/NIGHTSHIFT_AI.md, "Writing a project's storyboard").
 *   GET  ?film=<id>   what the button says before a press: whether the plan can run for this project now and, if not, why (the
 *                     same refusals the press gives, in the same order); how many of today's messages it uses; which models it
 *                     would set; and a plan already running (a refresh, another tab), which the panel follows. Takes nothing.
 *   POST {film, session?}  the press: writes the storyboard into the EMPTY project, at the version read first
 *                     (lib/server/brain/film-plan). `session`: the `retry_session` of an earlier 503, when its marker write failed.
 * Off is off: with NIGHTSHIFT_AI_CHAT off, or this workspace not in it, both answer 404 before anything is read about the project.
 * Nothing here holds credits, quotes, starts or publishes (CLAUDE.md rule 3).
 */

type Ctx = { supabase: SupabaseClient; film: PlanFilm; userId: string };

async function context(filmId: unknown): Promise<{ ok: true; c: Ctx } | { ok: false; res: Response }> {
  if (aiChatMode(aiChatEnv()) === "off") return { ok: false, res: notFound() };
  const user = await getUser();
  if (!user) return { ok: false, res: brainJson({ error: "unauthorized" }, 401) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, res: notFound() };
  if (typeof filmId !== "string") return { ok: false, res: brainJson({ error: "bad_request" }, 400) };
  // Film Studio's own switches, the project's workspace included: a project the editor cannot open is not planned from here either.
  const gate = await filmGateFor(filmId);
  if (!gate.ok) return { ok: false, res: gate.response };
  const read = await readPlanFilm(supabase as unknown as SupabaseClient, filmId);
  if (!read.ok) return read;
  const film = read.film;
  if (!aiChatOpenFor(film.orgId, aiChatEnv())) return { ok: false, res: notFound() };
  // Planning is a maker's act (0199 ai_chat_start: an editor or above); the database checks again on every turn and on save_film.
  const access = await requireOrgRole({ orgId: film.orgId }, "editor");
  if (!access.ok) return { ok: false, res: access.status === 404 ? notFound() : brainJson({ error: "forbidden" }, 403) };
  // 0192: someone who said they are under 18 is not served, as on the chat and Run now.
  if ((await readAgeState()) === "minor") return { ok: false, res: brainJson({ error: "adult_only_service" }, 403) };
  return { ok: true, c: { supabase: supabase as unknown as SupabaseClient, film, userId: user.id } };
}

export async function GET(request: Request) {
  const ctx = await context(new URL(request.url).searchParams.get("film"));
  if (!ctx.ok) return ctx.res;
  const { supabase, film, userId } = ctx.c;
  const refused = filmRefusal(film);
  if (refused) return refused;
  const lease = await filmLeaseView(supabase, film, userId);
  if (!lease.ok) return lease.res;
  // A plan of this project is being written (another tab, or this one before a refresh; in any of the person's conversations marked
  // with it, the rule a press yields by): the panel waits for it. Asked before the cap, which the running plan is using up.
  if (lease.lease?.state === "running") return brainJson({ ready: false, plan: lease.lease });
  const pre = await planPrecheck(supabase, film);
  if (!pre.ok) return pre.res;
  const r = pre.ready;
  return brainJson({
    ready: true,
    turns: { about: r.turns.about, at_most: r.turns.at_most },
    left: r.left,
    scope: r.scope,
    // What the press would set on the project, by name: only a role the project has no model for (never a swap of one it has).
    // "" when the model it sets has no display name: said as "sets one", never as its raw id (Pixel 15).
    sets: { clip: r.models.setClip ? r.models.clip?.name ?? "" : null, keyframe: r.models.setKeyframe ? r.models.keyframe?.name ?? "" : null },
    plan: lease.lease,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  // The request's own clock, first (Lens L1): the plan's 300 s budget counts the precheck too, or a slow precheck leaves a window
  // started that cannot finish before the proxy cuts the request.
  const t0 = Date.now();
  if (aiChatMode(aiChatEnv()) === "off") return notFound();
  const cross = rejectCrossOrigin(request);
  if (cross) return cross;
  const body = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (!body.ok) return brainJson({ error: body.reason === "too_large" ? "payload_too_large" : "bad_request" }, body.reason === "too_large" ? 413 : 400);
  const b = (body.value ?? {}) as Record<string, unknown>;
  const ctx = await context(b.film);
  if (!ctx.ok) return ctx.res;
  const { supabase, film, userId } = ctx.c;
  // What the press is stored as in the conversation: the project's title as plain() reads it (a title of only U+3164 or zero-width
  // characters is no title, Lens L2), or the panel's own words when it has none.
  const locale = await getLocale().catch(() => "en");
  const said = plain(film.title, 100) || filmStudioStrings(locale).canvas.ai.pressed;
  // Before any turn: a project with scenes is never planned over, and its own words are read through the safety floor.
  const refused = filmRefusal(film);
  if (refused) return refused;
  const pre = await planPrecheck(supabase, film);
  if (!pre.ok) return pre.res;
  // The conversation an earlier press made and could not mark (its 503 `retry_session`), handed back by the panel.
  const retrySession = typeof b.session === "string" && UUID.test(b.session) ? b.session : null;
  return planFilm({ supabase, film, ready: pre.ready, userId, said, startedAt: t0, retrySession });
}
