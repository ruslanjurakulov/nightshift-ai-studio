import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { AVATAR_WRITE_RATE, rateRefusal, takeWebRate } from "@/lib/server/web-rate";
import { AVATAR_BUCKET, AVATAR_MAX_BYTES, avatarPath, type AvatarErrorCode } from "@/lib/avatar";
import { looksLikeWebp, validateAvatarWebp } from "@/lib/avatar-validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed-in person's profile photo (migration 0097: private bucket
 * `avatars`, one object per person, `<uid>/avatar.webp`).
 *
 *   GET     the photo, 404 when there is none
 *   POST    replace it (raw image/webp body, not multipart)
 *   DELETE  remove it (nothing to remove is also success)
 *
 * Every call runs as the person (anon key + their session), so the bucket's
 * row-level security is the last word, and the service key is never used. The
 * object path is built from the SESSION's user id, never from the query: the
 * `?v=` on a GET is only a cache-buster and is not read at all. Errors are the
 * fixed codes of lib/avatar.ts, never a storage message.
 *
 * Storage checks the Content-Type HEADER of an upload, not its bytes, so POST
 * checks the bytes itself (lib/avatar-validate.ts): size, WebP container,
 * still image, side 64..512. The browser re-encodes every photo to 256x256
 * before sending (lib/avatar-image.ts), which also drops EXIF/GPS; this route
 * does not rely on that and refuses metadata chunks anyway.
 */
const NO_STORE = { "cache-control": "no-store" };

function fail(error: AvatarErrorCode | "not_found" | "not_configured" | "storage_failed" | "bad_request", status: number, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

export async function GET() {
  const user = await getUser();
  if (!user) return fail("unauthorized", 401);
  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);

  // No object, no access and a storage error all read the same: 404.
  let blob: Blob | null = null;
  try {
    const { data, error } = await supabase.storage.from(AVATAR_BUCKET).download(avatarPath(user.id));
    blob = error ? null : data;
  } catch {
    blob = null;
  }
  if (!blob) return fail("not_found", 404);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Only ever serve back something that is a WebP: the bucket's mime check trusts a header.
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES || !looksLikeWebp(bytes)) return fail("not_found", 404);

  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/webp",
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      // Private: the browser may keep it for an hour, a shared cache may not. The ?v= in the URL changes on every upload.
      "cache-control": "private, max-age=3600",
      vary: "Cookie",
    },
  });
}

/** Both writes: a signed-in person, our own page, a few edits an hour. Returns the response to send, or the user. */
async function guardWrite(request: Request) {
  const user = await getUser();
  if (!user) return { refusal: fail("unauthorized", 401) };
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return { refusal: fail("forbidden", 403) };
  return { user };
}

async function limited(userId: string) {
  const rate = await takeWebRate(userId, AVATAR_WRITE_RATE);
  if (rate === "ok") return null;
  const r = rateRefusal(rate, AVATAR_WRITE_RATE);
  // 429 carries the fixed code; the 503 "limiter unavailable" is a plain failure to the page.
  return NextResponse.json(rate === "limited" ? { error: "rate_limited" } : { error: "failed" }, {
    status: r.status,
    headers: { ...NO_STORE, ...r.headers },
  });
}

/** The body, read in pieces and abandoned the moment it passes the limit. null = over the limit. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function POST(request: Request) {
  const guard = await guardWrite(request);
  if (!guard.user) return guard.refusal;
  const { user } = guard;

  // Cheap refusals first, before anything is counted or read.
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/webp") return fail("not_webp", 415);
  const declaredRaw = request.headers.get("content-length");
  let declared: number | null = null;
  if (declaredRaw !== null) {
    declared = /^\d{1,12}$/.test(declaredRaw) ? Number(declaredRaw) : NaN;
    if (!Number.isFinite(declared)) return fail("bad_request", 400);
    if (declared > AVATAR_MAX_BYTES) return fail("too_large", 413);
  }

  const refused = await limited(user.id);
  if (refused) return refused;

  // The declared length is a claim: what counts is what actually arrives.
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(request, AVATAR_MAX_BYTES);
  } catch {
    return fail("bad_request", 400);
  }
  if (bytes === null) return fail("too_large", 413);
  if (declared !== null && declared !== bytes.length) return fail("bad_request", 400);

  const check = validateAvatarWebp(bytes);
  if (!check.ok) return fail(check.code, check.code === "too_large" ? 413 : 400);

  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);
  try {
    const { error } = await supabase.storage
      .from(AVATAR_BUCKET)
      .upload(avatarPath(user.id), bytes, { contentType: "image/webp", upsert: true, cacheControl: "3600" });
    if (error) return fail("storage_failed", 502);
  } catch {
    return fail("storage_failed", 502);
  }
  // The version is a cache-buster the page then records in the person's metadata.
  return NextResponse.json({ ok: true, version: Date.now() }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const guard = await guardWrite(request);
  if (!guard.user) return guard.refusal;
  const { user } = guard;

  const refused = await limited(user.id);
  if (refused) return refused;

  const supabase = await createClient();
  if (!supabase) return fail("not_configured", 503);
  try {
    // remove() of a name that is not there is not an error: removing twice is fine.
    const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([avatarPath(user.id)]);
    if (error) return fail("storage_failed", 502);
  } catch {
    return fail("storage_failed", 502);
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
