import "server-only";
import { NextResponse } from "next/server";
import { rateRefusal, takeWebRate, type RateRule } from "@/lib/server/web-rate";
import { readJsonBodyCapped, SMALL_BODY_BYTES } from "@/lib/server/json-body";

/**
 * What every mutating editor route does before it spends anything on a
 * request (validation CPU, a database call): the per-person rate limit, and a
 * body read with a hard byte cap. The numbers are in web-rate.ts.
 */

/** null = go on; otherwise the 429 (rate_limited, retry-after) or 503 to send. */
export async function editorRateLimited(
  userId: string,
  rule: RateRule,
): Promise<NextResponse | null> {
  const decision = await takeWebRate(userId, rule);
  if (decision === "ok") return null;
  const r = rateRefusal(decision, rule);
  return NextResponse.json(r.body, { status: r.status, headers: r.headers });
}

/**
 * The JSON body of a small request (ids, a title): the parsed value, or the
 * response to send. A body over the cap is a 413; anything unreadable is the
 * same `undefined` the routes already turn into a 400.
 */
export async function readSmallBody(
  request: Request,
): Promise<{ body: unknown } | { refusal: NextResponse }> {
  const read = await readJsonBodyCapped(request, SMALL_BODY_BYTES);
  if (read.ok) return { body: read.value };
  if (read.reason === "too_large")
    return {
      refusal: NextResponse.json({ error: "bad_request" }, { status: 413 }),
    };
  return { body: undefined };
}
