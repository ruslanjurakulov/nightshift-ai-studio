"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { useOverlay } from "@/components/a11y/useOverlay";
import { Presence, PresenceItem } from "@/components/motion/Presence";
import { formatCredits } from "@/lib/credits";
import {
  INBOX_LIMIT,
  ageParts,
  badgeText,
  describeNotification,
  parseInbox,
  type InboxRow,
  type NotificationView,
} from "@/lib/notifications";

/** The table is not there (PostgREST schema-cache miss, or Postgres's own). */
function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/** Re-read while the page is open, in case a live update is missed. */
const POLL_MS = 60_000;

type Load = "loading" | "ready" | "error" | "absent";

/**
 * The customer's bell: the person's own notifications for the current
 * organization (migration 0064), with the unread count on the bell.
 *
 * Everything shown is read through the member's own session and the table's
 * row-level security — only the person's own rows come back, and a person who
 * has left the organization gets none — so there is nothing to filter here
 * beyond the organization the bell is for. The only writes are the two
 * mark-read functions. Nothing on this surface spends, renders or publishes:
 * each notification is a link to the screen where the person decides.
 *
 * It stays quiet and honest when there is nothing to show: no Supabase or no
 * organization renders nothing, a failed read says so and offers a retry
 * rather than showing an empty inbox as if it were fine.
 */
export function NotificationBell({ orgId }: { orgId: string | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [load, setLoad] = useState<Load>("loading");
  const [busy, setBusy] = useState(false);
  const [markError, setMarkError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  // One client for the life of the bell; null when Supabase is not configured.
  const supabase = useMemo(() => createClient(), []);

  const refresh = useCallback(async () => {
    if (!supabase || !orgId) return;
    const [list, count] = await Promise.all([
      supabase
        .from("notifications")
        .select("id, org_id, kind, ref, data, created_at, read_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(INBOX_LIMIT),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("org_id", orgId).is("read_at", null),
    ]);
    if (list.error || count.error) {
      // Migration 0064 not applied yet: there is no inbox to show, and an
      // "error" every customer would see forever helps nobody. Anything else
      // is a real failure, said plainly with a retry.
      setLoad(isMissingTable(list.error) || isMissingTable(count.error) ? "absent" : "error");
      return;
    }
    setRows(parseInbox(list.data));
    setUnread(count.count ?? 0);
    setLoad("ready");
  }, [supabase, orgId]);

  useEffect(() => {
    if (!supabase || !orgId) return;
    setLoad("loading");
    void refresh();
    // A new row for this person arrives live (Realtime delivers only what the
    // person's own select policy allows); the poll and the focus read cover a
    // missed message.
    const channel = supabase
      .channel(`notifications:${orgId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `org_id=eq.${orgId}` }, () => {
        void refresh();
      })
      .subscribe();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      supabase.removeChannel(channel);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [supabase, orgId, refresh]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  // Escape closes, focus moves into the panel and comes back to the bell.
  useOverlay(open, { onClose: close, container: panelRef, opener: buttonRef });

  async function markRead(id: string) {
    if (!supabase) return;
    // Optimistic: the row reads as read at once and is put back if the call fails.
    const before = { rows, unread };
    const wasUnread = rows.some((r) => r.id === id && r.read_at === null);
    setRows((prev) => prev.map((r) => (r.id === id && r.read_at === null ? { ...r, read_at: new Date().toISOString() } : r)));
    if (wasUnread) setUnread((n) => Math.max(0, n - 1));
    const { error } = await supabase.rpc("mark_notification_read", { p_id: id });
    if (error) {
      setRows(before.rows);
      setUnread(before.unread);
      setMarkError(true);
    }
  }

  async function markAll() {
    if (!supabase || !orgId || busy) return;
    setBusy(true);
    setMarkError(false);
    const { error } = await supabase.rpc("mark_all_notifications_read", { p_org: orgId });
    setBusy(false);
    if (error) {
      setMarkError(true);
      return;
    }
    await refresh();
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setMarkError(false);
      void refresh();
    }
  }

  // Nowhere to read from, or nobody to read for: no bell, not an empty one.
  if (!orgId || !supabase || load === "absent") return null;

  const badge = badgeText(unread);
  const label = unread > 0 ? fmt(t.notifications.bellUnread, { n: unread }) : t.notifications.bell;
  const views = rows.map(describeNotification);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="btn-sky is-quiet pill relative grid size-10 place-items-center"
      >
        <Bell aria-hidden className="size-4" />
        {badge && (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 grid min-w-[16px] place-items-center rounded-full px-1 text-xs font-bold text-[var(--color-on-accent)]"
            style={{ background: "var(--color-primary)" }}
          >
            {badge}
          </span>
        )}
      </button>

      <Presence>
      {open && (
        // Below sm the bar's own width is the only room there is, so the panel
        // is pinned to the screen's edges instead of anchored to the bell.
        <PresenceItem
          kind="popover"
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="fixed inset-x-3 top-full z-50 mt-3 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] outline-none sm:absolute sm:inset-x-auto sm:right-0 sm:w-96"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <span id={titleId} className="text-xs font-bold text-[var(--color-fg)]">
              {t.notifications.title}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={markAll}
                disabled={busy || unread === 0}
                className="btn-sky is-quiet pill px-3 py-1 text-xs font-light disabled:opacity-50"
              >
                {t.notifications.markAll}
              </button>
              <button type="button" onClick={close} aria-label={t.notifications.close} className="sheet-close text-[15px]">
                ✕
              </button>
            </span>
          </div>

          {markError && (
            <p role="alert" className="border-b border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-fail)]">
              {t.notifications.markError}
            </p>
          )}

          {load === "loading" && rows.length === 0 ? (
            <p role="status" className="p-4 text-center text-xs text-[var(--color-muted)]">
              {t.notifications.loading}
            </p>
          ) : load === "error" ? (
            <div role="alert" className="flex flex-col items-center gap-2 p-4 text-center">
              <p className="text-xs text-[var(--color-fail)]">{t.notifications.loadError}</p>
              <button type="button" onClick={() => void refresh()} className="btn-sky is-quiet pill px-3 py-1 text-xs">
                {t.notifications.retry}
              </button>
            </div>
          ) : views.length === 0 ? (
            <div className="p-5 text-center">
              <p className="text-sm text-[var(--color-fg)]">{t.notifications.empty}</p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">{t.notifications.emptyHint}</p>
            </div>
          ) : (
            <ul tabIndex={0} aria-label={t.notifications.title} className="scroll-focus max-h-[60vh] overflow-y-auto overscroll-contain">
              {views.map((v) => (
                <li key={v.id} className="border-b border-[var(--color-border)]/60 last:border-0">
                  <Item view={v} href={path(v.section)} locale={locale} onOpen={() => (v.unread ? void markRead(v.id) : undefined)} onClose={close} />
                </li>
              ))}
            </ul>
          )}
        </PresenceItem>
      )}
      </Presence>
    </div>
  );
}

function Item({
  view,
  href,
  locale,
  onOpen,
  onClose,
}: {
  view: NotificationView;
  href: string;
  locale: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.notifications[view.copy];
  const age = ageParts(view.createdAt);
  const when =
    age.unit === "now"
      ? t.notifications.ageNow
      : fmt({ m: t.notifications.ageM, h: t.notifications.ageH, d: t.notifications.ageD }[age.unit], { n: age.n });
  const amount = view.amount ? fmt(t.notifications[view.amount.key], { n: formatCredits(view.amount.n, locale) }) : null;
  return (
    <Link
      href={href}
      onClick={() => {
        onOpen();
        onClose();
      }}
      className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-[var(--color-fg)]/5 focus-visible:bg-[var(--color-fg)]/5"
    >
      {view.unread ? (
        <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: "var(--color-primary)" }}>
          <span className="sr-only">{t.notifications.unread}</span>
        </span>
      ) : (
        <span aria-hidden className="mt-1.5 size-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className={`block text-sm text-[var(--color-fg)] ${view.unread ? "font-semibold" : ""}`}>{copy.title}</span>
        <span className="block text-xs text-[var(--color-muted)]">{copy.body}</span>
        {amount && <span className="tnum block text-xs text-[var(--color-muted)]">{amount}</span>}
      </span>
      <span className="tnum shrink-0 text-xs text-[var(--color-muted)]">{when}</span>
    </Link>
  );
}
