import { NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { requireSameOrigin } from "@/lib/server/same-origin";
import { YOUTUBE_CHECK_RATE, rateLimitRefusal } from "@/lib/server/secret-write";
import { parseJsonCapped } from "@/lib/server/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Prove a channel was opened correctly, using the key the operator just typed.
 *
 * The YouTube Data API key arrives in the request body, is used for exactly one
 * upstream call, and is dropped when the handler returns. It is not stored, not
 * cached, not logged, and not echoed back — the response carries only public
 * channel facts (title, avatar, counts) that anyone could read from the channel
 * page anyway.
 *
 * The point of the round trip is that a green result proves *both* halves at
 * once: the key works, and the channel id or handle names a real channel. A
 * typo in either one fails here rather than at 15:00 UTC inside a workflow.
 */
export const POST = requireSameOrigin(async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Not operator-only on purpose: a customer organization's admin adds a channel with the same wizard and types
  // THEIR OWN key. The route is not an open relay: the host is fixed (googleapis.com), the key in the request is the
  // caller's own (their quota, not ours), nothing is stored and only public channel facts come back. It is limited
  // per person, same-origin only and capped in size (ledger BR-S-018, BR-S-019, BR-S-020).
  const limited = rateLimitRefusal(user.id, YOUTUBE_CHECK_RATE);
  if (limited) return limited;

  let body: { apiKey?: string; channelId?: string; handle?: string };
  try {
    body = await parseJsonCapped(request);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const apiKey = (body.apiKey ?? "").trim();
  const channelId = (body.channelId ?? "").trim();
  const handle = (body.handle ?? "").trim().replace(/^@/, "");
  if (apiKey.length > 512 || channelId.length > 64 || handle.length > 64)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "missing_key" }, { status: 400 });
  if (!channelId && !handle)
    return NextResponse.json({ error: "missing_channel" }, { status: 400 });

  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,brandingSettings");
  if (channelId) url.searchParams.set("id", channelId);
  else url.searchParams.set("forHandle", handle);
  url.searchParams.set("key", apiKey);

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "youtube_unreachable" }, { status: 502 });
  }

  if (res.status === 400 || res.status === 403) {
    // The key itself was rejected. Google's message names the key's own
    // restrictions, so it is classified rather than forwarded.
    return NextResponse.json({ error: "key_rejected" }, { status: 400 });
  }
  if (!res.ok) return NextResponse.json({ error: "youtube_unavailable" }, { status: 502 });

  const data = (await res.json()) as {
    items?: {
      id: string;
      snippet?: {
        title?: string;
        description?: string;
        customUrl?: string;
        publishedAt?: string;
        country?: string;
        thumbnails?: Record<string, { url?: string }>;
      };
      statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
    }[];
  };

  const item = data.items?.[0];
  if (!item) return NextResponse.json({ error: "channel_not_found" }, { status: 404 });

  const thumbs = item.snippet?.thumbnails ?? {};
  return NextResponse.json({
    channelId: item.id,
    title: item.snippet?.title ?? "",
    customUrl: item.snippet?.customUrl ?? "",
    description: (item.snippet?.description ?? "").slice(0, 300),
    country: item.snippet?.country ?? "",
    publishedAt: item.snippet?.publishedAt ?? "",
    thumbnail:
      thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? "",
    subscribers: item.statistics?.subscriberCount ?? null,
    videos: item.statistics?.videoCount ?? null,
    views: item.statistics?.viewCount ?? null,
  });
});
