"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { orgWide, scopeQuery, type ChannelScope } from "@/lib/channels";
import { useI18n } from "@/lib/i18n/context";
import type { Dictionary } from "@/lib/i18n";
import { relativeTime } from "@/lib/format";
import { useChannelPath } from "@/lib/channels-client";
import { uploadedOnly } from "@/lib/heldVideos";

type NavKey = keyof Dictionary["nav"];
const NAV: { href: string; key: NavKey; hotkey?: string }[] = [
  { href: "/command-center", key: "command", hotkey: "d" },
  { href: "/channels", key: "channels", hotkey: "h" },
  { href: "/videos", key: "videos", hotkey: "v" },
  { href: "/pipeline", key: "pipeline", hotkey: "p" },
  { href: "/agents", key: "agents" },
  { href: "/jobs", key: "jobs" },
  { href: "/topics", key: "topics" },
  { href: "/analytics", key: "analytics", hotkey: "a" },
  { href: "/measurement", key: "measure" },
  { href: "/portfolio", key: "portfolio" },
  { href: "/billing", key: "billing" },
  { href: "/feedback-loop", key: "feedback" },
  { href: "/intelligence-map", key: "intelligence", hotkey: "i" },
  { href: "/intelligence", key: "advisory" },
  { href: "/decisions", key: "decisions", hotkey: "c" },
  { href: "/learning", key: "learning", hotkey: "n" },
  { href: "/memory", key: "memory", hotkey: "m" },
  { href: "/autonomy", key: "autonomy", hotkey: "u" },
  { href: "/time-machine", key: "timeMachine", hotkey: "t" },
  { href: "/errors", key: "errors" },
  { href: "/logs", key: "logs", hotkey: "l" },
  { href: "/integrations", key: "integrations" },
  { href: "/getting-started", key: "onboarding" },
  { href: "/organization", key: "organization" },
  { href: "/members", key: "members" },
  { href: "/alerts", key: "alerts" },
  { href: "/audit", key: "audit" },
];

interface Item {
  id: string;
  section: "nav" | "videos" | "events";
  label: string;
  sub?: string;
  href: string;
}

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/**
 * Command palette (Cmd/Ctrl+K) + G-then-key navigation + a shortcuts help
 * panel. Searches real videos and recent events (fetched lazily on open via the
 * authenticated browser client, so RLS applies). Mounted once in the app shell.
 */
export function CommandPalette({ scope }: { scope: ChannelScope }) {
  const router = useRouter();
  const { t } = useI18n();
  // Every href below is a section path. The channel comes from the URL you are
  // already on, so a jump never quietly changes which channel you are viewing.
  const path = useChannelPath();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [videos, setVideos] = useState<Item[]>([]);
  const [events, setEvents] = useState<Item[]>([]);
  const loaded = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Search the whole current organization, whichever channel is selected —
  // never every tenant a platform admin's RLS can read. A switch of
  // organization changes the key, and the next open fetches afresh.
  const scopeKey = JSON.stringify(orgWide(scope));
  useEffect(() => {
    loaded.current = false;
    setVideos([]);
    setEvents([]);
  }, [scopeKey]);

  const loadData = useCallback(async () => {
    if (loaded.current) return;
    loaded.current = true;
    const supabase = createClient();
    if (!supabase) return;
    const current = JSON.parse(scopeKey) as ChannelScope;
    const [vid, ev] = await Promise.all([
      uploadedOnly(scopeQuery(supabase.from("videos").select("video_id,title,topic"), current)).order("published_at", { ascending: false }).limit(50),
      scopeQuery(supabase.from("system_events").select("event_key,event,agent,ts,video_id"), current, { nullIsGlobal: true }).order("ts", { ascending: false }).limit(100),
    ]);
    setVideos(
      (vid.data ?? []).map((v: { video_id: string; title: string | null; topic: string | null }) => ({
        id: `v:${v.video_id}`,
        section: "videos" as const,
        label: v.title ?? v.video_id,
        sub: v.topic ?? undefined,
        href: `/videos/${v.video_id}`,
      })),
    );
    setEvents(
      (ev.data ?? []).map((e: { event_key: string; event: string; agent: string | null; ts: string; video_id: string | null }) => ({
        id: `e:${e.event_key}`,
        section: "events" as const,
        label: e.event,
        sub: `${e.agent ?? "system"} · ${relativeTime(e.ts)}`,
        href: e.video_id ? `/videos/${e.video_id}` : "/logs",
      })),
    );
  }, [scopeKey]);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery("");
    setActive(0);
    void loadData();
  }, [loadData]);

  // Global hotkeys: Cmd/Ctrl+K, "?" for help, and G-then-key navigation.
  useEffect(() => {
    let pendingG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
        void loadData();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelp((v) => !v);
        return;
      }
      if (pendingG) {
        const target = NAV.find((n) => n.hotkey === e.key.toLowerCase());
        pendingG = false;
        if (gTimer) clearTimeout(gTimer);
        if (target) {
          e.preventDefault();
          router.push(path(target.href));
        }
        return;
      }
      if (e.key.toLowerCase() === "g") {
        pendingG = true;
        gTimer = setTimeout(() => (pendingG = false), 1400);
      }
    }
    function onOpenEvent() {
      openPalette();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("chronos:palette-open", onOpenEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("chronos:palette-open", onOpenEvent);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [loadData, openPalette, path, router]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const navItems: Item[] = useMemo(
    () => NAV.map((n) => ({ id: `n:${n.href}`, section: "nav" as const, label: t.nav[n.key], href: n.href })),
    [t],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...navItems, ...videos, ...events];
    if (!q) return navItems;
    return all.filter((i) => i.label.toLowerCase().includes(q) || (i.sub ?? "").toLowerCase().includes(q)).slice(0, 40);
  }, [query, navItems, videos, events]);

  function choose(item: Item) {
    setOpen(false);
    router.push(path(item.href));
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const sectionLabel: Record<Item["section"], string> = {
    nav: t.ops.paletteNav,
    videos: t.ops.paletteVideos,
    events: t.ops.paletteEvents,
  };

  return (
    <>
      {open && (
        <div className="scrim-enter fixed inset-0 z-[100] flex items-start justify-center bg-black/72 p-4 pt-[12vh] backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div
            className="sheet-enter w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] pr-3">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
                placeholder={t.ops.palettePlaceholder}
                className="w-full bg-transparent px-4 py-3 text-sm outline-none placeholder:text-[var(--color-muted)]"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.ops.shortcutsClose}
                className="sheet-close shrink-0"
              >
                ✕
              </button>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto p-1">
              {results.length === 0 && (
                <li className="p-4 text-center mono text-xs text-[var(--color-muted)]">{t.ops.paletteNoResults}</li>
              )}
              {results.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(item)}
                    className="btn-sky is-quiet pill w-full justify-between gap-3 border-transparent px-4 py-2.5 text-left text-sm font-light"
                    style={{ background: i === active ? "var(--color-panel-2)" : "transparent" }}
                  >
                    <span className="min-w-0 truncate text-[var(--color-fg)]">{item.label}</span>
                    <span className="shrink-0 text-[9px] uppercase tracking-[0.22em] text-[var(--color-muted)]">
                      {item.sub ?? sectionLabel[item.section]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="border-t border-[var(--color-border)] px-4 py-2 mono text-[10px] text-[var(--color-muted)]">
              {t.ops.paletteHint}
            </div>
          </div>
        </div>
      )}

      {help && (
        <div className="scrim-enter fixed inset-0 z-[100] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm" onClick={() => setHelp(false)}>
          <div className="sheet-enter w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-base font-semibold">{t.ops.shortcutsTitle}</h2>
              <button
                type="button"
                onClick={() => setHelp(false)}
                aria-label={t.ops.shortcutsClose}
                className="sheet-close -mr-1 -mt-1 shrink-0"
              >
                ✕
              </button>
            </div>
            <dl className="mt-3 flex flex-col gap-2">
              {[
                { k: "⌘/Ctrl + K", v: t.ops.shortcutsPalette },
                { k: "G → D / V / A / P / L / I / T", v: t.ops.shortcutsGoto },
                { k: "?", v: t.ops.shortcutsHelp },
                { k: "Esc", v: t.ops.shortcutsClose },
              ].map((row) => (
                <div key={row.k} className="flex items-center justify-between gap-4">
                  <dd className="text-[12px] text-[var(--color-muted)]">{row.v}</dd>
                  <dt className="mono shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-0.5 text-[10px] text-[var(--color-fg)]">
                    {row.k}
                  </dt>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </>
  );
}
