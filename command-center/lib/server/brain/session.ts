import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CHAT_MODELS, chatModelConfigured, isChatModelId, type ChatModelId } from "@/lib/server/brain/llm";

/** Shared pieces of the /api/brain routes: refusals, the owner-chosen model's state, a channel's workspace. */

export const NO_STORE = { "cache-control": "no-store" };

export function brainJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export const notFound = () => brainJson({ error: "not_found" }, 404);

/** A refusal raised by 0209's functions (creative_refuse: the code is the message, the SQLSTATE NSxxx), named for the panel. */
export function dbRefusal(error: { code?: string; message?: string; details?: string } | null) {
  if (!error) return null;
  if (error.code === "PGRST202" || error.code === "PGRST205" || error.code === "42P01" || error.code === "42883") return brainJson({ error: "not_enabled" }, 503);
  const code = error.message ?? "";
  if (code === "chat_daily_cap") {
    const m = /used=(\d+) limit=(\d+)/.exec(error.details ?? "");
    return brainJson({ error: "chat_daily_cap", used: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : null }, 429);
  }
  if (code === "chat_plan_required") return brainJson({ error: "chat_plan_required" }, 402);
  if (code === "chat_unavailable") return brainJson({ error: "unavailable" }, 503);
  if (code === "message_too_long" || code === "invalid_params") return brainJson({ error: code }, 400);
  if (code === "session_closed") return brainJson({ error: "session_closed" }, 409);
  if (code === "session_not_found" || code === "channel_not_found" || code === "call_not_found") return notFound();
  if (code === "forbidden") return brainJson({ error: "forbidden" }, 403);
  return brainJson({ error: "unavailable" }, 503);
}

export type ModelState = "available" | "not_on_sale" | "not_configured" | "unknown_model";

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

export { CHAT_MODELS };
