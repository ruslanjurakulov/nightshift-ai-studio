"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { pluralForm, pluralText } from "@/lib/plural";
import { formatCredits } from "@/lib/credits";
import type { Brief } from "@/lib/brain/logic";
import type { RefSheet, RefView, SheetView } from "@/lib/brain/ref-sheets";

/**
 * "Make character sheets" under a short film's plan (docs/studio/NIGHTSHIFT_AI.md, "Character sheets"). It talks only to
 * /api/brain/sheets: the price it shows is the one that route summed from the database's own quotes (never a number of its own),
 * nothing is held before the person's confirm, and the confirm carries the token of exactly the set that was shown, so a quote that
 * changed meanwhile is refused rather than bought. Job states are read again on every load, so a refresh mid-job loses nothing.
 */

type Quote = { total: number; views: { view: SheetView }[]; waiting: number; token: string };
type Gate = { open: true } | { open: false; reason: string } | null;
type Loaded = { sheets: RefSheet[]; model: { name: string | null; film_own: "same" | "none" | "unable" } | null; gate: Gate; quote: Quote | null; refusal?: string };
type Problem = { code: string; started?: number; scene?: number | null; limit?: number | null; available?: number | null; needed?: number | null } | null;

const POLL_MS = 4000;
/** What a poll compares: which views are in which state (a cheap states-only read), so the quote is asked again only on a change. */
const statesOf = (sheets: RefSheet[]) => sheets.map((s) => `${s.character_id}:${s.stage ?? ""}:${s.views.map((v) => `${v.view}=${v.status}`).join(",")}`).join("|");
const viewId = (s: RefSheet, v: RefView) => `${s.character_id}:${s.stage ?? ""}:${v.view}`;

export function RefSheetsPanel({ brief, sessionId, filmId, channelSlug, onFilmQuote }: {
  brief: Brief; sessionId: string; filmId: string | null; channelSlug: string;
  /** The film's new quote after the sheets were attached (its version changed): the plan's Create reads this one. */
  onFilmQuote?: (q: unknown, version: number) => void;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat.sheets;
  const pathname = usePathname();
  const signIn = `/login?next=${encodeURIComponent(pathname || "/")}`;
  const noteId = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  /** The quote the person pressed Make on: what the confirm says and sends back, never a later one. */
  const [pending, setPending] = useState<Quote | null>(null);
  const [repriced, setRepriced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [attached, setAttached] = useState<number | null>(null);
  /** How many views were approved when the sheets were last attached: Attach comes back only after a new approval. */
  const [attachedAt, setAttachedAt] = useState<number | null>(null);
  /** The approved view whose "Make another" asked first (an approved picture is never thrown away in one click). */
  const [replacing, setReplacing] = useState<string | null>(null);
  /** Views whose picture could not be shown: no Approve for a picture nobody saw (Pixel 4). */
  const [unseen, setUnseen] = useState<Set<string>>(new Set());
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const makeRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const credits = (n: number) => fmt(pluralForm(t.aiChat.price, n, locale), { n: formatCredits(n, locale) });
  const query = `session=${encodeURIComponent(sessionId)}${filmId ? `&film=${encodeURIComponent(filmId)}` : ""}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/brain/sheets?${query}`, { cache: "no-store" });
      const d = (await res.json().catch(() => null)) as (Loaded & { error?: string }) | null;
      if (!res.ok || !d || !Array.isArray(d.sheets)) { setLoadFailed(d?.error ?? "failed"); return; }
      setLoadFailed(null);
      setData(d);
    } catch {
      setLoadFailed("failed");
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);
  // A quote that changed while the confirm is open (a poll, a redo in another tab): the box closes and the new price is said.
  useEffect(() => {
    if (pending && data?.quote?.token !== pending.token) {
      setPending(null);
      setRepriced(true);
    }
  }, [data, pending]);
  const making = (data?.sheets ?? []).some((s) => s.views.some((v) => v.status === "making"));
  const shownStates = data ? statesOf(data.sheets) : "";
  // Followed while a picture is being made, with the cheap states-only read; the full read (and its quotes) only on a change.
  useEffect(() => {
    if (!making) return;
    const id = window.setInterval(() => {
      void fetch(`/api/brain/sheets?${query}&states=1`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { sheets?: RefSheet[] } | null) => { if (d?.sheets && statesOf(d.sheets) !== shownStates) void load(); })
        .catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [making, load, query, shownStates]);
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);

  /** After a press the pressed button may be gone: focus goes to the section's heading, never to <body> (Pixel 1). */
  const focusHeading = () => window.requestAnimationFrame(() => headingRef.current?.focus());
  const cancelConfirm = () => {
    setPending(null);
    window.requestAnimationFrame(() => makeRef.current?.focus());
  };

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sessionId, ...(filmId ? { film: filmId } : {}), ...body }) });
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const num = (v: unknown) => (typeof v === "number" ? v : null);
        setProblem({ code: typeof d?.error === "string" ? d.error : "failed", started: num(d?.started) ?? 0, scene: num(d?.scene), limit: num(d?.limit),
                     available: num(d?.available), needed: num(d?.needed) });
        // A new price (price_changed), or jobs queued before a refusal: shown as the server read them.
        await load();
        return null;
      }
      return d;
    } catch {
      setProblem({ code: "failed" });
      return null;
    } finally {
      setBusy(false);
      focusHeading();
    }
  }

  const make = async () => {
    const q = pending;
    if (!q) return;
    setPending(null);
    const d = await post({ action: "make", max_credits: q.total, quote_token: q.token });
    if (d) await load();
  };
  const mark = async (s: RefSheet, v: RefView, action: "approve" | "redo") => {
    setReplacing(null);
    const d = await post({ action, character_id: s.character_id, stage: s.stage, view: v.view });
    if (d) await load();
  };
  const approvedCount = (data?.sheets ?? []).flatMap((s) => s.views).filter((v) => v.status === "approved").length;
  const attach = async () => {
    const d = await post({ action: "attach" });
    if (d && typeof d.attached === "number") {
      setAttached(d.attached);
      setAttachedAt(approvedCount);
      const f = d.film as { version?: number } | undefined;
      if (onFilmQuote && typeof f?.version === "number") onFilmQuote(d.film_quote, f.version);
    }
  };

  const name = (id: string, stage: string | null) => {
    const ch = (brief.characters ?? []).find((x) => x.id === id);
    const label = stage ? (ch?.age_stages ?? []).find((a) => a.id === stage)?.label : undefined;
    return `${ch?.name ?? id}${label ? ` (${label})` : ""}`;
  };
  const err = (p: { code: string; scene?: number | null; limit?: number | null }) =>
    fmt((c.errors as Record<string, string>)[p.code] ?? c.errors.failed, { scene: p.scene ?? "?", limit: p.limit ?? "?" });

  if (!data && !loadFailed) return <p className="text-xs text-[var(--color-muted)]" role="status">{c.loading}</p>;
  if (!data) {
    return (
      <section className="flex flex-col gap-2" aria-label={c.title} data-sheets-error={loadFailed ?? ""}>
        <h4 className="text-sm font-semibold">{c.title}</h4>
        <p className="text-sm" role="alert">{err({ code: loadFailed ?? "failed" })}</p>
        {loadFailed === "unauthorized"
          ? <Link className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href={signIn}>{c.signIn}</Link>
          : <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void load()}>{c.reload}</button>}
      </section>
    );
  }

  const views = data.sheets.flatMap((s) => s.views);
  const done = views.filter((v) => v.status === "ready" || v.status === "approved").length;
  const quoted = data.quote?.views ?? [];
  const fronts = quoted.filter((v) => v.view === "front").length;
  // The label says what the press makes: fronts, the side and back views, or a mix of both (counted).
  const label = (q: Quote) => fronts === quoted.length ? fmt(c.make, { credits: credits(q.total) })
    : fronts === 0 ? fmt(c.makeMore, { credits: credits(q.total) })
    : fmt(pluralForm(c.makeMixed, quoted.length, locale), { n: quoted.length, credits: credits(q.total) });
  const modelLine = !data.model ? null : !data.model.name ? c.modelUnnamed
    : fmt(data.model.film_own === "same" ? c.model : data.model.film_own === "none" ? c.modelNone : c.modelOther, { name: data.model.name });
  const noModel = data.refusal === "no_sheet_model";
  const gateClosed = data.gate === null || data.gate.open === false;
  // With no model to draw with, only the sheets that already hold a picture are worth a row (Pixel: no nine empty rows).
  const shown = noModel ? data.sheets.filter((s) => s.views.some((v) => v.asset_id || v.status !== "planned")) : data.sheets;
  return (
    <section className="@container flex min-w-0 flex-col gap-2" aria-label={c.title} data-sheets>
      <h4 ref={headingRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none focus-visible:underline">{c.title}</h4>
      <p className="text-xs text-[var(--color-muted)]">{c.intro}</p>
      {modelLine && <p className="text-xs" data-sheets-model>{modelLine}</p>}
      {/* The gate, said plainly: closed today for every key-frame model on sale, so the sheets are kept and nothing is attached. */}
      {!noModel && (gateClosed
        ? <p className="text-xs" role="note" data-gate="closed">{data.gate === null ? c.gateUnknown : c.gateClosed}</p>
        : <p className="text-xs" role="note" data-gate="open">{c.gateOpen}</p>)}
      {!noModel && data.gate === null && <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void load()}>{c.reload}</button>}
      {/* The one live region: progress, said as pictures arrive (Pixel: not one per view). */}
      <p className="sr-only" aria-live="polite">{fmt(c.progress, { done, total: views.length })}</p>
      <p id={noteId} className="text-xs text-[var(--color-muted)]">{c.redoNote}</p>
      <ul className="flex flex-col gap-3">
        {shown.map((s) => {
          const untouched = s.views.every((v) => v.status === "planned" && !v.asset_id);
          return (
            <li key={`${s.character_id}:${s.stage ?? ""}`} className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-semibold">{name(s.character_id, s.stage)}</p>
              {untouched ? <p className="text-xs" data-collapsed>{c.allPlanned}</p> : (
                <ul className="grid grid-cols-1 gap-2 @[20rem]:grid-cols-2">
                  {s.views.map((v) => {
                    const id = viewId(s, v);
                    const big = enlarged === id;
                    const view = c.views[v.view];
                    return (
                      <li key={v.view} className={`flex min-w-0 flex-col gap-1 ${big ? "col-span-full" : ""}`} data-view={v.view} data-status={v.status}>
                        <p className="text-xs font-semibold">{view}</p>
                        {v.asset_id && (
                          <SheetImage assetId={v.asset_id} alt={fmt(c.imageAlt, { view: c.viewsLower[v.view], name: name(s.character_id, s.stage) })}
                            unavailable={c.imageUnavailable} reloadLabel={c.reloadImage} big={big}
                            toggleLabel={fmt(big ? c.shrink : c.enlarge, { view })} onToggle={() => setEnlarged(big ? null : id)}
                            onShown={(ok) => setUnseen((u) => {
                              const n = new Set(u);
                              if (ok) n.delete(id); else n.add(id);
                              return n.size === u.size && [...n].every((x) => u.has(x)) ? u : n;
                            })} />
                        )}
                        <p className="text-xs">
                          {v.status === "making" && <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-current motion-safe:animate-pulse" />}
                          {c.status[v.status]}
                        </p>
                        {replacing === id ? (
                          <div className="flex flex-col gap-1" role="group" aria-label={c.replaceAsk}>
                            <p className="text-xs">{c.replaceAsk}</p>
                            <div className="flex flex-wrap gap-2">
                              <button type="button" className="btn-primary min-h-11 whitespace-normal px-3 text-sm" disabled={busy} onClick={() => void mark(s, v, "redo")}>{c.replaceYes}</button>
                              <button type="button" className="btn-quiet min-h-11 whitespace-normal px-3 text-sm" onClick={() => setReplacing(null)}>{c.keep}</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {v.status === "ready" && !unseen.has(id) && (
                              <button type="button" className="btn-primary min-h-11 whitespace-normal px-3 text-sm" disabled={busy} onClick={() => void mark(s, v, "approve")}>{c.approve}</button>
                            )}
                            {(v.status === "ready" || v.status === "approved" || v.status === "failed") && (
                              <button type="button" className="btn-quiet min-h-11 whitespace-normal break-words px-3 text-left text-sm" disabled={busy} aria-describedby={noteId}
                                onClick={() => (v.status === "approved" ? setReplacing(id) : void mark(s, v, "redo"))}>{v.status === "failed" ? c.retry : c.redo}</button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {data.refusal && <p className="text-sm" role="alert" data-sheets-refusal={data.refusal}>{err({ code: data.refusal })}</p>}
      {!data.refusal && data.quote === null && (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-sm">{c.priceUnknown}</p>
          <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void load()}>{c.reload}</button>
        </div>
      )}
      {repriced && data.quote && <p className="text-sm" role="status" data-repriced>{fmt(c.repriced, { credits: credits(data.quote.total) })}</p>}
      {data.quote && quoted.length > 0 && !pending && (
        <button ref={makeRef} type="button" className="btn-primary min-h-11 self-start whitespace-normal px-4 text-left text-sm" disabled={busy}
          onClick={() => { setRepriced(false); setPending(data.quote); }}>{label(data.quote)}</button>
      )}
      {data.quote && data.quote.waiting > 0 && <p className="text-xs text-[var(--color-muted)]">{pluralText(c.waiting, data.quote.waiting, locale)}</p>}
      {pending && (
        <div className="flex flex-col gap-2" role="group" aria-label={fmt(c.confirm, { credits: credits(pending.total) })}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); cancelConfirm(); } }}>
          <p className="text-sm">{fmt(c.confirm, { credits: credits(pending.total) })}</p>
          {gateClosed && <p className="text-xs">{c.confirmGateClosed}</p>}
          <div className="flex flex-wrap gap-2">
            <button ref={confirmRef} type="button" className="btn-primary min-h-11 px-4 text-sm" disabled={busy} onClick={() => void make()}>{c.confirmYes}</button>
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={cancelConfirm}>{c.cancel}</button>
          </div>
        </div>
      )}
      {busy && <p className="text-xs" role="status">{c.starting}</p>}
      {data.gate?.open && filmId && approvedCount > 0 && attachedAt !== approvedCount && (
        <button type="button" className="btn-quiet min-h-11 self-start whitespace-normal px-4 text-left text-sm" disabled={busy} onClick={() => void attach()}>{c.attach}</button>
      )}
      {attached !== null && <p className="text-sm" role="status">{pluralText(c.attached, attached, locale)}</p>}
      {problem && (
        <div className="flex flex-col gap-2" role="alert" data-sheets-problem={problem.code}>
          <p className="text-sm">{err(problem)}</p>
          {problem.code === "insufficient_credits" && typeof problem.available === "number" && typeof problem.needed === "number" && (
            <p className="text-sm">{fmt(c.insufficientNumbers, { have: credits(problem.available), need: credits(problem.needed) })}</p>
          )}
          {/* Something was held for pictures that did start: said, never hidden behind "nothing was held" (Lens M1). */}
          {(problem.started ?? 0) > 0 && problem.code !== "sheets_not_saved" && <p className="text-sm">{pluralText(c.started, problem.started!, locale)}</p>}
          {problem.code === "insufficient_credits" && (
            <Link className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#topups`}>{c.topUp}</Link>
          )}
          {problem.code === "unauthorized" && <Link className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href={signIn}>{c.signIn}</Link>}
          {problem.code === "sheets_not_saved" && <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={() => void load()}>{c.reload}</button>}
        </div>
      )}
    </section>
  );
}

/**
 * One library picture through the library's own signed link (/api/media/{id}). Tapping it shows it across the panel's width (a
 * 16:9 white-background figure is small in a 300 px dock). One that cannot be shown says so, offers a reload, and tells the panel,
 * which then offers no Approve for it.
 */
function SheetImage({ assetId, alt, unavailable, reloadLabel, big, toggleLabel, onToggle, onShown }: {
  assetId: string; alt: string; unavailable: string; reloadLabel: string; big: boolean; toggleLabel: string; onToggle: () => void; onShown: (ok: boolean) => void;
}) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    fetch(`/api/media/${encodeURIComponent(assetId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { urls?: Record<string, string> } | null) => { if (live) setSrc(d?.urls?.display ?? d?.urls?.thumb ?? d?.urls?.original ?? null); })
      .catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [assetId, attempt]);
  useEffect(() => { if (src !== undefined) onShown(src !== null); }, [src, onShown]);
  if (src === undefined) return <div className="aspect-video w-full rounded-[var(--ns-r-frame)] bg-[var(--color-panel-2)]" aria-hidden />;
  if (!src) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs">{unavailable}</p>
        <button type="button" className="btn-quiet min-h-11 self-start whitespace-normal px-3 text-sm" onClick={() => setAttempt((n) => n + 1)}>{reloadLabel}</button>
      </div>
    );
  }
  return (
    <button type="button" className="block w-full rounded-[var(--ns-r-frame)] p-0" aria-expanded={big} aria-label={toggleLabel} onClick={onToggle}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link, not a static asset next/image can cache */}
      <img src={src} alt={alt} onError={() => setSrc(null)} className="aspect-video w-full rounded-[var(--ns-r-frame)] bg-[var(--color-panel-2)] object-contain" />
    </button>
  );
}
