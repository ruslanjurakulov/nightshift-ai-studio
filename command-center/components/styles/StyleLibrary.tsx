"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { STYLE_LIBRARY, STYLE_TAGS, filterLibrary, type LibraryStyle, type StyleTag } from "@/lib/styles/library";
import { Chip, ChipRow } from "@/components/ui/Chip";
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
  initialOpenId = null,
}: {
  orgId: string | null;
  addState: AddState;
  /** library id -> the organization's kit id, for the styles already added. */
  initialAdded: Record<string, string>;
  /** A look the page was opened on (the Presets gallery's link): its detail starts open. */
  initialOpenId?: string | null;
}) {
  const { t, locale } = useI18n();
  const ts = t.styleLibrary;
  const router = useRouter();
  const path = useChannelPath();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<StyleTag[]>([]);
  const [openId, setOpenId] = useState<string | null>(initialOpenId);
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
    <div className="flex flex-col gap-8">
      {stateNote && (
        <p role="status" className="g2-note !max-w-none border-t border-[var(--ns-rule)] pt-4">
          {stateNote}
        </p>
      )}

      <section className="ns-desk g2-desk g2-wizard flex flex-col gap-4" aria-label={ts.searchLabel}>
        <div className="relative">
          <label htmlFor={searchId} className="sr-only">
            {ts.searchLabel}
          </label>
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-muted)]" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ts.searchPlaceholder}
            autoComplete="off"
            className="ns-field w-full !pl-10"
          />
        </div>

        <ChipRow label={ts.filterLabel} wrap>
          {STYLE_TAGS.map((tag) => (
            <Chip key={tag} pressed={tags.includes(tag)} onClick={() => toggleTag(tag)}>
              {ts.tags[tag]}
            </Chip>
          ))}
        </ChipRow>

        <div className="flex items-center justify-between gap-3 text-[13px] text-[var(--color-muted)]">
          <p aria-live="polite" className="m-0 tnum">
            {fmt(ts.count, { n: shown.length, total: STYLE_LIBRARY.length })}
          </p>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setTags([]);
              }}
              className="tap-link g2-link"
            >
              {ts.clear}
            </button>
          )}
        </div>
      </section>

      {shown.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="g2-none">{ts.noMatch}</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setTags([]);
            }}
            className="btn-quiet"
          >
            {ts.clear}
          </button>
        </div>
      ) : (
        <ul className="g2-styles" aria-label={ts.title}>
          {shown.map((style, i) => (
            <li key={style.id} className="ns-frame g2-style" data-added={added[style.id] ? "true" : undefined}>
              <button
                type="button"
                onClick={() => show(style)}
                aria-haspopup="dialog"
                aria-label={fmt(ts.open, { name: style.name[locale] })}
                className="g2-style-btn"
              >
                <span className="ns-edge" aria-hidden>
                  <span className="ns-edge-no">{String(i + 1).padStart(2, "0")}</span>
                  <span>▸</span>
                  <span>{ts.previewLabel}</span>
                </span>
                <span className="ns-frame-media">
                  <StyleTile style={style} className="aspect-[4/3] w-full" />
                </span>
                <span className="g2-style-body">
                  <span className="flex items-start justify-between gap-2">
                    <span className="g2-strong">{style.name[locale]}</span>
                    {added[style.id] && (
                      <span className="g2-added">
                        <Check aria-hidden className="size-3.5" />
                        {ts.addedBadge}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-2 text-[13px] leading-snug text-[var(--color-muted)]">{style.goodFor[locale]}</span>
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
