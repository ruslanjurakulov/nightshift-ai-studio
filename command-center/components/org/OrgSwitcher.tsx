"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { ALL_CHANNELS_SLUG, CHANNEL_COOKIE } from "@/lib/channels";
import type { OrgSummary } from "@/lib/orgs";

/**
 * Organization selector for the header.
 *
 * Switching asks the server (/api/org/select), which checks the choice against
 * the caller's memberships before remembering it — and every page re-checks
 * that memory anyway. It then lands on "all channels" of the new org: the
 * channel in the current URL belongs to the org being left.
 *
 * Renders nothing with one organization or none, exactly like the channel
 * switcher: a single-org operator sees the header they always saw.
 */
export function OrgSwitcher({ orgs, currentId }: { orgs: OrgSummary[]; currentId: string | null }) {
  const router = useRouter();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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

  if (orgs.length < 2) return null;
  const current = orgs.find((o) => o.id === currentId) ?? null;

  async function choose(id: string) {
    setOpen(false);
    if (id === currentId || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/org/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: id }),
      });
      if (!res.ok) throw new Error(String(res.status));
      // The remembered channel belongs to the org being left.
      document.cookie = `${CHANNEL_COOKIE}=${ALL_CHANNELS_SLUG}; path=/; max-age=31536000; samesite=lax`;
      router.push(`/${ALL_CHANNELS_SLUG}/command-center`);
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t.org.switcherLabel}
        title={error ? t.org.switchFailed : undefined}
        disabled={busy}
        className="btn-sky is-quiet pill h-9 max-w-[104px] gap-2 px-3 disabled:opacity-60 sm:h-10 sm:max-w-[200px] sm:gap-3 sm:px-4"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5 shrink-0 text-[var(--color-muted)]">
          <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
          <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
        </svg>
        <span className="truncate text-[14px] font-light" style={{ color: error ? "var(--color-fail)" : undefined }}>
          {current?.name ?? t.org.switcherLabel}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-3.5 shrink-0 text-[var(--color-muted)]">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={t.org.switcherLabel}
          className="drawer-enter absolute right-0 z-50 mt-3 w-64 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-[var(--shadow-elevated)]"
        >
          {orgs.map((o) => {
            const active = o.id === currentId;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(o.id)}
                  className="btn-sky is-quiet pill w-full justify-start gap-2.5 border-transparent px-4 py-2.5 text-left"
                  style={{ background: active ? "var(--color-panel-2)" : "transparent" }}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-[14px] font-light"
                      style={{ color: active ? "var(--color-primary)" : "var(--color-fg)" }}
                    >
                      {o.name}
                    </span>
                    <span className="mono block truncate text-[10px] text-[var(--color-muted)]">
                      {o.slug}
                      {o.is_default ? ` · ${t.org.defaultBadge}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
