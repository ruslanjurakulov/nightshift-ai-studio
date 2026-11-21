import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";
import { fetchTopicScores, getChannelScope } from "@/lib/channels-server";
import { scopeQuery } from "@/lib/channels";
import type { DemandSignalRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Ideas" — content-topic suggestions for a channel, from data the pipeline
 * already gathered. Two honest sources, merged and de-duplicated:
 *   - demand_signals.topic_phrase — what this audience has actually asked for
 *     (mined from comments), newest first;
 *   - topic_performance.topic — topics that have measurably done well here.
 * Read-only, any signed-in user; nothing here spends money. The Run button
 * turns a chosen idea into a real run by passing it as the run's topic.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ ideas: [] });

  const scope = await getChannelScope();

  const [proven, demandRes] = await Promise.all([
    fetchTopicScores(supabase, scope).catch(() => []),
    scopeQuery(supabase.from("demand_signals").select("*"), scope)
      .order("polled_date", { ascending: false })
      .limit(40),
  ]);

  const demand = ((demandRes.data as DemandSignalRow[] | null) ?? [])
    .map((d) => d.topic_phrase?.trim())
    .filter((s): s is string => Boolean(s));

  type Idea = { label: string; source: "demand" | "proven" };
  const seen = new Set<string>();
  const ideas: Idea[] = [];

  // Audience demand leads — it is the freshest signal of what people want.
  for (const label of demand) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ideas.push({ label, source: "demand" });
    if (ideas.length >= 6) break;
  }
  // Fill the rest with proven high-scoring topics, best first.
  for (const tp of [...proven].sort((a, b) => b.score - a.score)) {
    if (ideas.length >= 10) break;
    const label = tp.topic?.trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ideas.push({ label, source: "proven" });
  }

  return NextResponse.json({ ideas });
}
