"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { inSelection, orgWide, scopeQuery, type ChannelScope } from "@/lib/channels";
import { buildNotifications, type Notification, type NotificationKind } from "@/lib/intelligence";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import type { FeedbackSignalRow, SystemEventRow } from "@/lib/types";
import { relativeTime, storedMs } from "@/lib/format";
import { useOverlay } from "@/components/a11y/useOverlay";

const SEEN_KEY = "chronos_notif_seen";
const CLEARED_KEY = "chronos_notif_cleared";

const KIND_LABEL: Record<NotificationKind, keyof Dictionary["ops"]> = {
  published: "notifPublished",
  error: "notifError",
  learning: "notifLearning",
  anomaly: "notifAnomaly",
  storyboard: "notifStoryboard",
};
const KIND_COLOR: Record<NotificationKind, string> = {
  published: "var(--color-primary)",
  error: "var(--color-fail)",
  learning: "var(--color-ok)",
  anomaly: "var(--color-warn)",
  storyboard: "var(--color-primary)",
};

/**
 * Header notifications derived from real rows only — published videos,
 * failures, and HIGH_/LOW_ learning signals. Live via Realtime; unread is
 * tracked against a per-device "last seen" timestamp, and Clear hides
 * everything up to now (also per-device). Nothing is fabricated.
 */
export function NotificationsCenter({ scope }: { scope: ChannelScope }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<SystemEventRow[]>([]);
  const [signals, setSignals] = useState<FeedbackSignalRow[]>([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<number>(0);
  const [cleared, setCleared] = useState<number>(0);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const knownKeys = useRef<Set<string>>(new Set());
  // The whole current organization, whichever channel is selected. Realtime
  // delivers whatever RLS allows — for a platform admin, every tenant — so
  // live rows are filtered by the same scope as the initial read.
  const scopeKey = JSON.stringify(orgWide(scope));

  useEffect(() => {
    const current = JSON.parse(scopeKey) as ChannelScope;
    try {
      setSeen(Number(localStorage.getItem(SEEN_KEY) ?? 0));
      setCleared(Number(localStorage.getItem(CLEARED_KEY) ?? 0));
    } catch {
      // ignore
    }
    const supabase = createClient();
    if (!supabase) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const [ev, sg] = await Promise.all([
        scopeQuery(supabase.from("system_events").select("*"), current, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(100),
        scopeQuery(supabase.from("feedback_signals").select("*"), current).order("analyzed_date", { ascending: false }).limit(100),
      ]);
      const rows = (ev.data as SystemEventRow[]) ?? [];
      rows.forEach((r) => knownKeys.current.add(r.event_key));
      setEvents(rows);
      setSignals((sg.data as FeedbackSignalRow[]) ?? []);

      channel = supabase
        .channel("chronos_notifications")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "system_events" }, (payload) => {
          const row = payload.new as SystemEventRow;
          if (!inSelection(row.channel_id, current, { nullIsGlobal: true })) return;
          if (knownKeys.current.has(row.event_key)) return;
          knownKeys.current.add(row.event_key);
          setEvents((prev) => [row, ...prev].slice(0, 200));
        })
        .subscribe();
    })();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [scopeKey]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Escape closes, focus moves into the panel and comes back to the bell.
  useOverlay(open, { onClose: () => setOpen(false), container: panelRef, opener: buttonRef });

  const notifications = useMemo(
    () => buildNotifications(events, signals, 30).filter((n) => (storedMs(n.ts) ?? 0) > cleared),
    [events, signals, cleared],
  );
  const unread = useMemo(() => notifications.filter((n) => (storedMs(n.ts) ?? 0) > seen).length, [notifications, seen]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      const now = Date.now();
      setSeen(now);
      try {
        localStorage.setItem(SEEN_KEY, String(now));
      } catch {
        // ignore
      }
    }
  }

  function clearAll() {
    const now = Date.now();
    setCleared(now);
    try {
      localStorage.setItem(CLEARED_KEY, String(now));
    } catch {
      // ignore
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={t.ops.notifTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="btn-sky is-quiet pill relative grid size-10 place-items-center"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            className="absolute -right-1 -top-1 grid min-w-[16px] place-items-center rounded-full px-1 text-xs font-bold text-[var(--color-on-accent)]"
            style={{ background: "var(--color-primary)" }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        // Below sm the header's own width is the only room there is: the bell is
        // not at the right edge, so an anchored w-80 panel started off-screen.
        // The header's backdrop-filter is the containing block for `fixed`.
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label={t.ops.notifTitle}
          tabIndex={-1}
          className="drawer-enter fixed inset-x-3 top-full z-50 mt-3 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] outline-none sm:absolute sm:inset-x-auto sm:right-0 sm:w-80"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <span className="text-xs font-bold text-[var(--color-fg)]">{t.ops.notifTitle}</span>
            <span className="flex items-center gap-1">
              {notifications.length > 0 && (
                <button type="button" onClick={clearAll} className="btn-sky is-quiet pill px-3 py-1 text-xs font-light">
                  {t.ops.notifClear}
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.ops.shortcutsClose}
                className="sheet-close text-[15px]"
              >
                ✕
              </button>
            </span>
          </div>
          <ul
            tabIndex={notifications.length > 0 ? 0 : undefined}
            aria-label={t.ops.notifTitle}
            className="scroll-focus max-h-[60vh] overflow-y-auto overscroll-contain"
          >
            {notifications.length === 0 ? (
              <li className="p-4 text-center tnum text-xs text-[var(--color-muted)]">{t.ops.notifEmpty}</li>
            ) : (
              notifications.map((n: Notification) => (
                <li key={n.id} className="flex items-start gap-2.5 border-b border-[var(--color-border)]/60 px-3 py-2 last:border-0">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-[var(--color-fg)]">{String(t.ops[KIND_LABEL[n.kind]])}</div>
                    <div className="tnum truncate text-xs text-[var(--color-muted)]">{n.subject}</div>
                  </div>
                  <span className="tnum shrink-0 text-xs text-[var(--color-muted)]">{relativeTime(n.ts)}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
