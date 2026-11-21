import "server-only";
import { NextResponse } from "next/server";
import { isSameOriginPost } from "@/lib/auth-confirm";
import { publicOrigin } from "@/lib/server/public-origin";
import { rateRefusal, takeWebRate, type RateRule } from "@/lib/server/web-rate";
import type { ChannelError } from "@/lib/notify-channels";

/** Shared by the notification-channel routes: a signed-in person, our own page, fixed error codes, never cached. */
const NO_STORE = { "cache-control": "no-store" };

export function notifyFail(error: ChannelError, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

export function notifyOk(body: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...body }, { status: 200, headers: NO_STORE });
}

/** After the route has asked who is calling (getUser): our own page only, and the rate rule if there is one.
 *  Returns the refusal to send, or null. */
export async function guardNotifyWrite(request: Request, user: { id: string }, rule?: RateRule) {
  const ours = [publicOrigin(request), new URL(request.url).origin];
  if (!isSameOriginPost(request.headers, ours)) return notifyFail("forbidden", 403);
  if (rule) {
    const rate = await takeWebRate(user.id, rule);
    if (rate !== "ok") {
      const r = rateRefusal(rate, rule);
      return notifyFail(rate === "limited" ? "rate_limited" : "failed", r.status, r.headers);
    }
  }
  return null;
}

/** A small JSON object body, or null. */
export async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 2048) return null;
  try {
    const text = await request.text();
    if (text.length > 2048) return null;
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The database's reason as a fixed code: a missing function (migration not applied) is "not_configured". */
export function rpcFailure(error: { code?: string; message?: string }): { error: ChannelError; status: number } {
  const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
  if (missing) return { error: "not_configured", status: 503 };
  if (error.code === "42501") return { error: "forbidden", status: 403 };
  return { error: "failed", status: 502 };
}
