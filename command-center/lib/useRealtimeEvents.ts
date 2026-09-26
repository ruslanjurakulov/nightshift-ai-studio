"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { inSelection, type ChannelScope } from "@/lib/channels";
import type { SystemEventRow } from "@/lib/types";

/**
 * Subscribe to real `system_events` INSERTs, seeded with server-fetched rows.
 * Supabase multiplexes all channels over a single WebSocket, so each consumer
 * can hold its own named channel cheaply. Returns the live event list, the
 * connection state (null until the first subscribe callback), and the key of
 * the most recent arrival (for one-shot entrance animations).
 *
 * `scope` keeps the live stream honest about channels: while the view is
 * scoped to one channel, an event belonging to another is dropped rather than
 * appended, so a Finance event can never appear in a History view — and in the
 * all-channels view an event of another organization's channel is dropped too,
 * because Realtime delivers whatever RLS allows, which for a platform admin is
 * every tenant. Events with a null channel_id are global (heartbeats,
 * infrastructure) and stay visible where the scope includes them — that is
 * what nullIsGlobal means here.
 */
export function useRealtimeEvents(
  initial: SystemEventRow[],
  channelName: string,
  scope: ChannelScope,
) {
  const [events, setEvents] = useState<SystemEventRow[]>(initial);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const seen = useRef(new Set(initial.map((e) => e.event_key)));
  // Server props arrive as a fresh object on every refresh; resubscribe only
  // when what the scope says changes, not when its identity does.
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    const current = JSON.parse(scopeKey) as ChannelScope;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_events" },
        (payload) => {
          const row = payload.new as SystemEventRow;
          if (!inSelection(row.channel_id, current, { nullIsGlobal: true })) return;
          if (seen.current.has(row.event_key)) return;
          seen.current.add(row.event_key);
          setEvents((prev) => [row, ...prev].slice(0, 200));
          setFreshKey(row.event_key);
        },
      )
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelName, scopeKey]);

  return { events, connected, freshKey };
}
