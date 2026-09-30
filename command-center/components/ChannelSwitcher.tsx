"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import {
  CHANNEL_COOKIE,
  selectionSlug,
  type ChannelSelection,
} from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * Channel selector for the header.
 *
 * Choosing a channel NAVIGATES: it swaps the channel segment of the current
 * URL and keeps you on the same screen, so /chronos/analytics becomes
 * /extinct-world/analytics. That is what makes the address bar the truth —
 * the URL says which channel you are looking at, so it survives a paste into a
 * message, a second tab, and the browser's back button.
 *
 * The cookie is still written, but only as a memory: it is what a channelless
 * URL ("/", or an old /videos link) is resolved against. It never decides what
 * a URL that already names a channel is showing.
 *
 * Filtering here is a view control, not a security boundary — RLS is what
 * decides what may be read at all.
 *
 * There is no "All channels" entry: the app is one workspace, one channel at
 * a time. The every-channel roll-up is still reachable by URL for the platform
 * operator (a non-operator is redirected off it by the layout), and while you
 * are on it the button says so.
 *
 * Renders nothing when there is one channel or none: a switcher with a single
 * option is noise, and this is what a single-channel deployment sees.
 */
export function ChannelSwitcher({
  channels,
  selection,
}: {
  channels: ChannelRow[];
  selection: ChannelSelection;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (channels.length < 2) return null;

  const current = channels.find((c) => c.channel_id === selection);
  const label = current ? current.name : t.channels.allChannels;

  function choose(next: string) {
    setOpen(false);
    const slug = selectionSlug(next, channels);
    // One year, path-wide, Lax: a view preference, not a credential.
    document.cookie = `${CHANNEL_COOKIE}=${encodeURIComponent(slug)}; path=/; max-age=31536000; samesite=lax`;
    // Same screen, different channel: replace only the first segment.
    const rest = pathname.split("/").slice(2).join("/");
    router.push(`/${slug}${rest ? "/" + rest : "/command-center"}`);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.channels.switcherLabel}
        className="btn-sky is-quiet pill h-10 max-w-[104px] gap-2 px-3 sm:max-w-[220px] sm:gap-3 sm:px-4"
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{
            background: current
              ? current.status === "ACTIVE"
                ? "var(--color-ok)"
                : "var(--color-idle)"
              : "var(--color-primary)",
          }}
        />
        <span className="truncate text-[14px] font-light">{label}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0 text-[var(--color-muted)]">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="drawer-enter fixed inset-x-3 top-full z-50 mt-3 overflow-hidden sm:absolute sm:inset-x-auto sm:right-0 sm:w-64 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-[var(--shadow-elevated)]"
        >
          {channels.map((c) => (
            <li key={c.channel_id}>
              <Option
                label={c.name}
                sub={c.niche || c.channel_id}
                tone={c.status === "ACTIVE" ? "ok" : "idle"}
                active={selection === c.channel_id}
                onSelect={() => choose(c.channel_id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Option({
  label,
  sub,
  active,
  tone,
  onSelect,
}: {
  label: string;
  sub?: string;
  active: boolean;
  tone?: "ok" | "idle";
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className="btn-sky is-quiet pill w-full justify-start gap-2.5 border-transparent px-4 py-2.5 text-left"
      style={{ background: active ? "var(--color-panel-2)" : "transparent" }}
    >
      {tone && (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: tone === "ok" ? "var(--color-ok)" : "var(--color-idle)" }}
        />
      )}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[14px] font-light"
          style={{ color: active ? "var(--color-primary)" : "var(--color-fg)" }}
        >
          {label}
        </span>
        {sub && <span className="mono block truncate text-[10px] text-[var(--color-muted)]">{sub}</span>}
      </span>
    </button>
  );
}
