import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { CHAT_MODELS, chatModelConfigured, isChatModelId, type ChatModelId } from "@/lib/server/brain/llm";

/** Shared pieces of the /api/brain routes: refusals, the owner-chosen model's state, a channel's workspace. */

export const NO_STORE = { "cache-control": "no-store" };

export function brainJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export const notFound = () => brainJson({ error: "not_found" }, 404);

/** A refusal raised by 0199's functions (creative_refuse: the code is the message, the SQLSTATE NSxxx), named for the panel. */
export function dbRefusal(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return null;
  if (error.code === "PGRST202" || error.code === "PGRST205" || error.code === "42P01" || error.code === "42883") return brainJson({ error: "not_enabled" }, 503);
  const code = error.message ?? "";
  if (code === "chat_daily_cap") {
    const m = /used=(\d+) limit=(\d+)/.exec(error.details ?? "");
    return brainJson({ error: "chat_daily_cap", used: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null }, 429);
  }
  // 0232: what is left of today's cap (or the trial) is held by storyboards being written; it comes back by `until`, not in a day.
  // Every number the detail cannot give is null (rule 5), never 0.
  if (code === "chat_reserved") {
    const m = /^used=(\d*) reserved=(\d*) limit=(\d*) until=(\S*)$/.exec(error.details ?? "");
    const n = (v: string | undefined) => (v ? Number(v) : null);
    const until = m && m[4] && !Number.isNaN(Date.parse(m[4])) ? m[4] : null;
    return brainJson({ error: "chat_reserved", used: n(m?.[1]), reserved: n(m?.[2]), limit: n(m?.[3]), until }, 429);
  }
  if (code === "chat_plan_required") return brainJson({ error: "chat_plan_required" }, 402);
  if (code === "chat_unavailable") return brainJson({ error: "unavailable" }, 503);
  if (code === "message_too_long" || code === "invalid_params") return brainJson({ error: code }, 400);
  if (code === "session_closed") return brainJson({ error: "session_closed" }, 409);
  if (code === "duplicate_request") {
    // The conversation the first copy of this press went to (a retried Start must find it, not the empty one it just made).
    const sid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(error.details ?? "") ? error.details : null;
    return brainJson(sid ? { error: "duplicate_request", session: { id: sid } } : { error: "duplicate_request" }, 409);
  }
  if (code === "nothing_to_retry") return brainJson({ error: "nothing_to_retry" }, 409);
  if (code === "session_not_found" || code === "channel_not_found" || code === "call_not_found") return notFound();
  if (code === "forbidden") return brainJson({ error: "forbidden" }, 403);
  // 0226: the workspace's trial and daily cap are spent only by a member (a platform admin who holds no seat reads, never chats).
  if (code === "not_a_member") return brainJson({ error: "not_a_member" }, 403);
  return brainJson({ error: "unavailable" }, 503);
}

/**
 * A database refusal's message as a `reason` the browser may see: only a machine word (creative_refuse's codes are), else
 * "unavailable". A Postgres error's own text is not one (Breach BR-FILM-05: a unique violation names the constraint and the table, a
 * cast error quotes the value), and the panel has no words for it anyway.
 */
export function machineReason(message: unknown): string {
  return typeof message === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(message) ? message : "unavailable";
}

export type ModelState = "available" | "not_on_sale" | "not_configured" | "unknown_model";

/**
 * The owner's model from ai_chat_quota's model_ref (md5 of a prefix and the id): a member never reads the id itself (it names the
 * vendor), and the server maps the reference back to one of its own models. An unknown reference is no model, never another one.
 */
export function modelFromRef(ref: unknown): ChatModelId | null {
  if (typeof ref !== "string" || !/^[0-9a-f]{32}$/.test(ref)) return null;
  for (const id of Object.keys(CHAT_MODELS)) {
    if (createHash("md5").update(`nightshift-chat-model:${id}`).digest("hex") === ref && isChatModelId(id)) return id;
  }
  return null;
}

/** The owner's chosen model: on sale on the web (sellable_models, describe) AND keyed on this server, or why not. Never another. */
export async function chosenModelState(supabase: SupabaseClient, model: unknown): Promise<{ ok: true; id: ChatModelId | null; state: ModelState } | { ok: false }> {
  if (!isChatModelId(model)) return { ok: true, id: null, state: "unknown_model" };
  const { data, error } = await supabase.rpc("sellable_models", { p_capability: "describe", p_surface: "web" });
  if (error) return { ok: false };
  const onSale = ((data ?? []) as { id?: unknown }[]).some((r) => String(r.id) === model);
  return { ok: true, id: model, state: !onSale ? "not_on_sale" : chatModelConfigured(model) ? "available" : "not_configured" };
}

export async function channelOrg(supabase: SupabaseClient, channelId: string) {
  const { data, error } = await supabase.from("channels").select("org_id,name").eq("channel_id", channelId).maybeSingle();
  if (error) return { state: "failed" as const };
  if (!data || typeof data.org_id !== "string") return { state: "missing" as const };
  return { state: "ok" as const, orgId: data.org_id as string, name: typeof data.name === "string" ? data.name : channelId };
}

/** An opaque id for the vendor's abuse tooling: the workspace, hashed as the worker does (never the person's own user id). */
export async function vendorUser(orgId: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nightshift-org:${orgId}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export { CHAT_MODELS };
