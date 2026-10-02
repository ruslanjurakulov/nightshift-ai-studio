"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { STYLE_LIBRARY, STYLE_TAGS, filterLibrary, type LibraryStyle, type StyleTag } from "@/lib/styles/library";
import { StyleTile } from "@/components/styles/StyleTile";
import { StyleDetailSheet, type SheetBusy } from "@/components/styles/StyleDetailSheet";

/** Whether this page can add styles to the open workspace, and if not, why. */
export type AddState = "ready" | "no-org" | "not-enabled" | "read-failed";

/**
 * The Style Library page: a searchable, tag-filterable grid of hand-written art
 * directions, each opening a detail sheet.
 *
 * "Add to my styles" creates an organization style kit through
 * POST /api/style-library/add — idempotent, so pressing it twice (or from two
 * tabs) is one kit. "Use in Studio" adds it first when it is not there yet and
 * then opens /create?tool=t2i&style=<kit>, which only FILLS the style chip:
 * nothing is priced, held or started until the person presses Generate.
 * Browsing needs no workspace and no database.
 */
export function StyleLibrary({
  orgId,
  addState,
  initialAdded,
}: {
  orgId: string | null;
  addState: AddState;
  /** library id -> the organization's kit id, for the styles already added. */
  initialAdded: Record<string, string>;
}) {
  const { t, locale } = useI18n();
  const ts = t.styleLibrary;
  const router = useRouter();
  const path = useChannelPath();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<StyleTag[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, string>>(initialAdded);
  const [busy, setBusy] = useState<SheetBusy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A press while another is in flight must not start a second request.
  const inFlight = useRef(false);

  const canAdd = addState === "ready" && orgId !== null;
  const shown = useMemo(
    () => filterLibrary(STYLE_LIBRARY, { query, tags }, locale, ts.tags),
    [query, tags, locale, ts.tags],
  );
  const open = openId ? (STYLE_LIBRARY.find((s) => s.id === openId) ?? null) : null;
  const filtered = query.trim() !== "" || tags.length > 0;

  function toggleTag(tag: StyleTag) {
    setTags((cur) => (cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]));
  }

  function show(style: LibraryStyle) {
    setNotice(null);
    setError(null);
    setOpenId(style.id);
  }

  function errorText(word: unknown): string {
    const e = ts.errors;
    switch (word) {
      case "bad_request":
      case "limit_reached":
      case "forbidden":
      case "unauthorized":
      case "not_available":
        return e[word];
      default:
        return e.failed;
    }
  }

  /** The organization's kit for this style, adding it first when needed. null = it failed (the error is shown). */
  async function ensureKit(style: LibraryStyle): Promise<{ id: string; created: boolean } | null> {
    const have = added[style.id];
    if (have) return { id: have, created: false };
    if (!canAdd) return null;
    try {
      const res = await fetch("/api/style-library/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library_id: style.id, locale, org_id: orgId }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: unknown; created?: unknown; error?: unknown };
      if (!res.ok || typeof body.id !== "string") {
        setError(errorText(body.error));
        return null;
      }
      setAdded((cur) => ({ ...cur, [style.id]: body.id as string }));
      return { id: body.id, created: body.created === true };
    } catch {
      setError(ts.errors.failed);
      return null;
    }
  }

  async function add(style: LibraryStyle) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("add");
    setNotice(null);
    setError(null);
    try {
      const kit = await ensureKit(style);
      if (kit) setNotice(kit.created ? ts.justAdded : ts.alreadyAdded);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function use(style: LibraryStyle) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("use");
    setNotice(null);
    setError(null);
    try {
      const kit = await ensureKit(style);
      if (kit) router.push(path(`/create?tool=t2i&style=${encodeURIComponent(kit.id)}`));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const stateNote =
    addState === "no-org" ? ts.noOrg : addState === "not-enabled" ? ts.notEnabled : addState === "read-failed" ? ts.readFailed : null;

  return (
    <div className="flex flex-col gap-4">
      {stateNote && (
        <p role="status" className="panel p-3 text-[13px] text-[var(--color-muted)]">
          {stateNote}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            {ts.searchLabel}
          </label>
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-muted)]" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ts.searchPlaceholder}
            autoComplete="off"
            className="w-full rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] py-2.5 pl-9 pr-4 text-[16px] text-[var(--color-fg)] outline-none focus-visible:border-[var(--color-primary)] sm:text-[14px]"
          />
        </div>

        <div role="group" aria-label={ts.filterLabel} className="flex flex-wrap gap-2">
          {STYLE_TAGS.map((tag) => (
            <button key={tag} type="button" aria-pressed={tags.includes(tag)} onClick={() => toggleTag(tag)} className="studio-chip">
              {ts.tags[tag]}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 text-[12px] text-[var(--color-muted)]">
          <p aria-live="polite" className="m-0">
            {fmt(ts.count, { n: shown.length, total: STYLE_LIBRARY.length })}
          </p>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setTags([]);
              }}
              className="tap-link text-[var(--color-primary)] underline"
            >
              {ts.clear}
            </button>
          )}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="m-0 max-w-[46ch] text-[13px] text-[var(--color-muted)]">{ts.noMatch}</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setTags([]);
            }}
            className="btn-sky is-quiet pill px-4 py-1.5 text-[13px]"
          >
            {ts.clear}
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((style) => (
            <li key={style.id}>
              <button
                type="button"
                onClick={() => show(style)}
                aria-haspopup="dialog"
                aria-label={fmt(ts.open, { name: style.name[locale] })}
                className="panel flex h-full w-full flex-col overflow-hidden p-0 text-left transition-colors hover:border-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
              >
                <StyleTile style={style} label={ts.previewLabel} className="aspect-[4/3] w-full" />
                <span className="flex flex-1 flex-col gap-1 p-3">
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-[14px] font-semibold text-[var(--color-fg)]">{style.name[locale]}</span>
                    {added[style.id] && (
                      <span className="pill inline-flex shrink-0 items-center gap-1 border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">
                        <Check aria-hidden className="size-3" />
                        {ts.addedBadge}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-[12px] text-[var(--color-muted)]">{style.goodFor[locale]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <StyleDetailSheet
          key={open.id}
          style={open}
          added={Boolean(added[open.id])}
          canAdd={canAdd}
          busy={busy}
          notice={notice}
          error={error}
          onAdd={() => void add(open)}
          onUse={() => void use(open)}
          onClose={() => setOpenId(null)}
          manageHref={path("/studio")}
        />
      )}
    </div>
  );
}
