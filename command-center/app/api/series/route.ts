import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/roles";
import { AUTOMATION_LEVELS, PLATFORM_OPTIONS } from "@/lib/series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Series CRUD for the Command Center.
 *
 * Every request is gated on an authenticated user; the writes land in the
 * `content_series` table under RLS (authenticated insert/update). This never
 * publishes, renders, or spends anything — a series is configuration. A new
 * series is created PAUSED, matching the table default and the channels
 * posture: a human activates it.
 */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function cleanPlatforms(value: unknown): string[] {
  if (!Array.isArray(value)) return ["youtube"];
  const allowed = new Set<string>(PLATFORM_OPTIONS);
  const out = value.filter((v): v is string => typeof v === "string" && allowed.has(v));
  return out.length ? Array.from(new Set(out)) : ["youtube"];
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Creating a content series is an editorial action (editor and up).
  if (!(await requireRole("editor"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const channelId = String(body.channel_id ?? "").trim() || "default";
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });

  const automation = AUTOMATION_LEVELS.includes(body.automation_level as never)
    ? (body.automation_level as string)
    : "manual";

  // A stable, slug-based id with a short random suffix so two series with the
  // same name on the same channel don't collide.
  const seriesId = `${slugify(name) || "series"}-${Math.random().toString(36).slice(2, 8)}`;

  const cadence: Record<string, number> = {};
  const longPerWeek = Number(body.long_per_week);
  const shortsPerDay = Number(body.shorts_per_day);
  if (Number.isFinite(longPerWeek) && longPerWeek > 0) cadence.long_per_week = longPerWeek;
  if (Number.isFinite(shortsPerDay) && shortsPerDay > 0) cadence.shorts_per_day = shortsPerDay;

  const row = {
    series_id: seriesId,
    channel_id: channelId,
    name,
    description: String(body.description ?? "").trim(),
    niche: String(body.niche ?? "").trim(),
    language: String(body.language ?? "English").trim() || "English",
    format: String(body.format ?? "").trim(),
    content_type: String(body.content_type ?? "mixed").trim() || "mixed",
    visual_style: String(body.visual_style ?? "").trim(),
    voice_style: String(body.voice_style ?? "").trim(),
    cadence,
    platforms: cleanPlatforms(body.platforms),
    automation_level: automation,
    status: "PAUSED",
  };

  const { error } = await supabase.from("content_series").insert(row);
  if (error) {
    // A missing table (migration 0006 not applied) is the common first-run
    // case; say so specifically rather than a generic failure.
    const missing = /content_series/.test(error.message) && /relation|exist/i.test(error.message);
    return NextResponse.json(
      { error: missing ? "table_missing" : "insert_failed", detail: error.message },
      { status: missing ? 503 : 500 },
    );
  }
  return NextResponse.json({ ok: true, series_id: seriesId });
}

export async function PATCH(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await requireRole("editor"))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const seriesId = String(body.series_id ?? "").trim();
  if (!seriesId) return NextResponse.json({ error: "series_id_required" }, { status: 400 });

  // Only the status is updatable here, and only to a known value — the one
  // control the list offers (Activate / Pause / Archive). Content edits are a
  // later, richer editor.
  const status = String(body.status ?? "").toUpperCase();
  if (!["ACTIVE", "PAUSED", "ARCHIVED"].includes(status))
    return NextResponse.json({ error: "bad_status" }, { status: 400 });

  const { error } = await supabase
    .from("content_series")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("series_id", seriesId);
  if (error) return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
