import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";
import { getChannelSelection } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent pipeline events for the selected channel — the Create page polls this
 * after it dispatches a run, so the operator watches the run move through its
 * stages (research → script → audio → media → render → publish) instead of
 * guessing. Read-only, auth-gated; nothing here spends or publishes. It reads
 * exactly the system_events the Jobs and lifecycle views already read.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ events: [] });

  const selection = await getChannelSelection();
  const res = await scopeQuery(
    supabase.from("system_events").select("ts,agent,event,status,video_id"),
    selection,
    { nullIsGlobal: true },
  )
    .order("ts", { ascending: false })
    .limit(40);

  const rows = (res.data as Pick<SystemEventRow, "ts" | "agent" | "event" | "status" | "video_id">[] | null) ?? [];
  return NextResponse.json({ events: rows });
}
