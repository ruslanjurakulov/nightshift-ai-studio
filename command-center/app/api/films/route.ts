import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { FILM_CREATE_RATE } from "@/lib/server/web-rate";
import {
  NO_STORE,
  currentFilmOrg,
  filmAnswer,
  filmFail,
  filmGate,
  filmRate,
  filmRefusal,
  listFilms,
  readFilmBody,
} from "@/lib/server/films";
import { CREATE_LIMITS, FILM_ASPECTS, FILM_LANGUAGES, IDEM_RE, SOURCE_KINDS } from "@/lib/films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A 40,000-character script is at most ~160 KB of UTF-8; the rest of the body is a few short fields. */
const CREATE_BODY_BYTES = 200_000;

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const chars = (s: string) => [...s].length;

/**
 * GET: the open workspace's projects (`?archived=1` for the archived ones), read through RLS as the member. Nothing is written.
 */
export async function GET(request: Request) {
  const gate = await filmGate();
  if (!gate.ok) return gate.response;
  const org = await currentFilmOrg();
  if (!org) return filmFail("org_required", 400);
  const archived = new URL(request.url).searchParams.get("archived") === "1";
  const read = await listFilms(gate.supabase, org.id, archived);
  if (!read.ok) return read.error === "not_available" ? filmFail("not_available", 503) : filmFail("failed", 502);
  return NextResponse.json({ films: read.films }, { headers: NO_STORE });
}

/**
 * POST: a new draft (0166's create_film_draft) in the open workspace:
 * `{ source_kind, source_text, title, language, aspect, target_seconds, channel_id, idem }`.
 * Spends nothing and starts nothing. The database checks the editor role, that the channel is this workspace's, the open-draft and
 * total limits, its own hourly limit, and the idempotency key: a replayed key answers the first draft, so a double press makes one.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const gate = await filmGate();
  if (!gate.ok) return gate.response;
  const b = await readFilmBody(request, CREATE_BODY_BYTES);
  if (!b) return filmFail("bad_request", 400);
  const kind = b.source_kind;
  const max = kind === "script" ? CREATE_LIMITS.max_script_chars : CREATE_LIMITS.max_topic_chars;
  const target = b.target_seconds;
  if (
    !oneOf(SOURCE_KINDS, kind) ||
    typeof b.source_text !== "string" ||
    chars(b.source_text.trim()) < 1 ||
    chars(b.source_text) > max ||
    typeof b.title !== "string" ||
    chars(b.title.trim()) < 1 ||
    chars(b.title) > CREATE_LIMITS.max_title_chars ||
    !oneOf(FILM_LANGUAGES, b.language) ||
    !oneOf(FILM_ASPECTS, b.aspect) ||
    typeof target !== "number" ||
    !Number.isInteger(target) ||
    target < CREATE_LIMITS.target_seconds_min ||
    target > CREATE_LIMITS.target_seconds_max ||
    !(b.channel_id === null || (typeof b.channel_id === "string" && b.channel_id.length > 0 && b.channel_id.length <= 128)) ||
    typeof b.idem !== "string" ||
    !IDEM_RE.test(b.idem)
  ) {
    return filmFail("bad_request", 400);
  }
  const org = await currentFilmOrg();
  if (!org) return filmFail("org_required", 400);
  const limited = await filmRate(gate.userId, FILM_CREATE_RATE);
  if (limited) return limited;
  const { data, error } = await gate.supabase.rpc("create_film_draft", {
    p_org: org.id,
    p_channel: b.channel_id,
    p_source_kind: kind,
    p_source_text: b.source_text,
    p_settings: { title: b.title.trim(), language: b.language, aspect: b.aspect, target_seconds: target },
    p_idempotency_key: b.idem,
  });
  if (error) return filmRefusal(error);
  return filmAnswer(data, 201);
});
