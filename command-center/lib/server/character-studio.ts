import "server-only";
import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { MEDIA_ASSET_COLUMNS, coerceAssets } from "@/lib/media";
import { mediaDir, mediaUrlSecret, withUrls } from "@/lib/server/media";
import { parseJsonCapped } from "@/lib/server/json-body";
import { likenessRefusal } from "@/lib/likeness-policy";
import {
  JOB_COLUMNS,
  SAMPLE_COLUMNS,
  TEMPLATE_COLUMNS,
  characterStudioEnabled,
  coerceJobs,
  coerceTemplates,
  mapSwapError,
  parseId,
  type PickItem,
  type StudioState,
  type SwapError,
} from "@/lib/characterStudio/model";

/**
 * Character Studio's server side (migration 0137; docs/CHARACTER_STUDIO.md). Every call is the signed-in member's own Supabase client
 * (anon key + session): RLS reads and 0137's four member functions, never the service key, never a vendor. Behind
 * NIGHTSHIFT_CHARACTER_STUDIO: off = 404 before the session is read, so a switched-off route does not tell a visitor whether they are
 * signed in.
 */

export const NO_STORE = { "cache-control": "no-store" };

export function csFail(error: SwapError, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

/**
 * The payment-terms refusal (lib/likeness-policy.ts), first in every route that reads, quotes or starts a swap: before the studio's own
 * switch, the session and any database call, so nothing is quoted or held. The cancel route does not call it: cancelling a job that was
 * queued before the switch went off is how its hold comes back.
 */
export function studioPolicyRefusal(): NextResponse | null {
  const refused = likenessRefusal();
  return refused ? NextResponse.json(refused.body, { status: refused.status, headers: NO_STORE }) : null;
}

type Client = NonNullable<Awaited<ReturnType<typeof createClient>>>;
export type StudioGate = { ok: true; supabase: Client; userId: string } | { ok: false; response: NextResponse };

/** The first lines of every /api/character-studio route, in this order: the switch, the session, the client. */
export async function characterStudioGate(): Promise<StudioGate> {
  if (!characterStudioEnabled()) return { ok: false, response: csFail("not_found", 404) };
  const user = await getUser();
  if (!user) return { ok: false, response: csFail("unauthorized", 401) };
  const supabase = await createClient();
  if (!supabase) return { ok: false, response: csFail("not_configured", 503) };
  return { ok: true, supabase, userId: user.id };
}

/** The request's JSON body, or undefined when it is not JSON or is too large (a 400, not a 500). */
export async function readStudioBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await parseJsonCapped(request);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `org_id` when given (must be a uuid), else the organization the app has open. */
export async function resolveStudioOrg(asked: unknown): Promise<{ org: string | null; bad: boolean }> {
  if (asked !== null && asked !== undefined && asked !== "") {
    const org = parseId(asked);
    return { org, bad: !org };
  }
  const ctx = await getOrgContext();
  return { org: ctx.current?.id ?? null, bad: false };
}

/** A database refusal as the route's answer: a closed word, a status, and the number the database named, when it named one. */
export function studioRefusal(error: { code?: string; message?: string; details?: string }) {
  const m = mapSwapError(error);
  const extra: Record<string, unknown> = {};
  if (m.charge !== undefined) extra.charge = m.charge;
  if (m.hold !== undefined) extra.hold = m.hold;
  return csFail(m.error, m.status, extra);
}

const LATEST_JOBS = 10;
const PICK_LIMIT = 60;

/** The gallery's cards with their samples, the organization's latest swaps, and the library items the studio can pick. */
export async function loadStudio(supabase: Client, orgId: string, opts: { urls?: boolean } = {}): Promise<StudioState> {
  const empty: StudioState = { available: false, templates: [], jobs: [], videos: [], pictures: [] };
  if (!parseId(orgId)) return empty;
  try {
    const [templates, samples, jobs, videos, pictures] = await Promise.all([
      supabase.from("character_swap_templates").select(TEMPLATE_COLUMNS).order("position", { ascending: true }).limit(50),
      supabase.from("character_swap_template_samples").select(SAMPLE_COLUMNS).limit(200),
      supabase.from("character_swap_jobs").select(JOB_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(LATEST_JOBS),
      supabase
        .from("media_assets")
        .select(MEDIA_ASSET_COLUMNS)
        .eq("org_id", orgId)
        .eq("kind", "video")
        .in("mime", ["video/mp4", "video/quicktime"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PICK_LIMIT),
      supabase
        .from("media_assets")
        .select(MEDIA_ASSET_COLUMNS)
        .eq("org_id", orgId)
        .eq("kind", "image")
        .in("mime", ["image/png", "image/jpeg", "image/webp"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(PICK_LIMIT),
    ]);
    const errors = [templates.error, samples.error, jobs.error, videos.error, pictures.error].filter(Boolean) as { code?: string }[];
    if (errors.length) {
      return errors.some((e) => mapSwapError(e).error === "not_available") ? empty : { ...empty, available: true, error: "read_failed" };
    }
    const secret = opts.urls ? mediaUrlSecret() : null;
    const served = Boolean(opts.urls && mediaDir());
    const pick = (data: unknown, kind: "video" | "image"): PickItem[] =>
      coerceAssets(data)
        .filter((a) => a.kind === kind)
        .map((a) => {
          const signed = withUrls(a, secret, served);
          return { id: a.id, kind, name: a.name ?? null, thumbUrl: signed.thumbUrl ?? null, durationS: a.durationS, source: a.source };
        });
    return {
      available: true,
      templates: coerceTemplates(templates.data, samples.data),
      jobs: coerceJobs(jobs.data),
      videos: pick(videos.data, "video"),
      pictures: pick(pictures.data, "image"),
    };
  } catch {
    return { ...empty, available: true, error: "read_failed" };
  }
}
