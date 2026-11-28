"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { pluralForm, pluralText } from "@/lib/plural";
import { formatCredits } from "@/lib/credits";
import type { Brief } from "@/lib/brain/logic";
import type { RefSheet, RefView, SheetView } from "@/lib/brain/ref-sheets";

/**
 * "Make character sheets" under a short film's plan (docs/studio/NIGHTSHIFT_AI.md, "Character sheets"). It talks only to
 * /api/brain/sheets: the price it shows is the one that route summed from the database's own quotes (never a number of its own),
 * nothing is held before the person's confirm, and every picture is one job on the existing creative path. The job states are read
 * again on every load, so a refresh mid-job finds the pictures where they were.
 */

type Quote = { total: number; views: { view: SheetView }[]; waiting: number };
type Gate = { open: true } | { open: false; reason: string } | null;
type Loaded = { sheets: RefSheet[]; model: { name: string | null; film_own: boolean } | null; gate: Gate; quote: Quote | null; refusal?: string };
type Problem = { code: string; available?: number | null; needed?: number | null } | null;

const POLL_MS = 4000;

export function RefSheetsPanel({ brief, sessionId, filmId, channelSlug, onFilmQuote }: {
  brief: Brief; sessionId: string; filmId: string | null; channelSlug: string;
  /** The film's new quote after the sheets were attached (its version changed): the plan's Create reads this one. */
  onFilmQuote?: (q: unknown, version: number) => void;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat.sheets;
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [attached, setAttached] = useState<number | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
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
  const making = (data?.sheets ?? []).some((s) => s.views.some((v) => v.status === "making"));
  // Followed while a picture is being made; nothing is polled once every job has ended.
  useEffect(() => {
    if (!making) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [making, load]);
  useEffect(() => { if (confirming) confirmRef.current?.focus(); }, [confirming]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/brain/sheets", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sessionId, ...(filmId ? { film: filmId } : {}), ...body }) });
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setProblem({ code: typeof d?.error === "string" ? d.error : "failed",
          available: typeof d?.available === "number" ? d.available : null, needed: typeof d?.needed === "number" ? d.needed : null });
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
    }
  }

  const make = async () => {
    if (!data?.quote) return;
    setConfirming(false);
    const d = await post({ action: "make", max_credits: data.quote.total });
    if (d) await load();
  };
  const mark = async (s: RefSheet, v: RefView, action: "approve" | "redo") => {
    const d = await post({ action, character_id: s.character_id, stage: s.stage, view: v.view });
    if (d) await load();
  };
  const attach = async () => {
    const d = await post({ action: "attach" });
    if (d && typeof d.attached === "number") {
      setAttached(d.attached);
      const f = d.film as { version?: number } | undefined;
      if (onFilmQuote && typeof f?.version === "number") onFilmQuote(d.film_quote, f.version);
    }
  };

  const name = (id: string, stage: string | null) => {
    const ch = (brief.characters ?? []).find((x) => x.id === id);
    const label = stage ? (ch?.age_stages ?? []).find((a) => a.id === stage)?.label : undefined;
    return `${ch?.name ?? id}${label ? ` (${label})` : ""}`;
  };
  const err = (code: string) => (c.errors as Record<string, string>)[code] ?? c.errors.failed;

  if (!data && !loadFailed) return <p className="text-xs text-[var(--color-muted)]" role="status">{c.loading}</p>;
  if (!data) {
    return (
      <div className="flex flex-col gap-2" role="alert" data-sheets-error={loadFailed ?? ""}>
        <p className="text-sm">{err(loadFailed ?? "failed")}</p>
        {loadFailed === "unauthorized"
          ? <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href="/login">{c.signIn}</Link>
          : <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => void load()}>{c.reload}</button>}
      </div>
    );
  }

  const views = data.sheets.flatMap((s) => s.views);
  const done = views.filter((v) => v.status === "ready" || v.status === "approved").length;
  const fronts = data.quote?.views.every((v) => v.view === "front") ?? true;
  const anyApproved = views.some((v) => v.status === "approved");
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={c.title} data-sheets>
      <h4 className="text-sm font-semibold">{c.title}</h4>
      <p className="text-xs text-[var(--color-muted)]">{c.intro}</p>
      {data.model && <p className="text-xs" data-sheets-model>{data.model.name ? fmt(data.model.film_own ? c.model : c.modelOther, { name: data.model.name }) : c.modelUnnamed}</p>}
      {/* The gate, said plainly: closed today for every key-frame model on sale, so the sheets are kept and nothing is attached. */}
      {data.gate === null || data.gate.open === false
        ? <p className="text-xs" role="note" data-gate="closed">{data.gate === null ? c.gateUnknown : c.gateClosed}</p>
        : <p className="text-xs" role="note" data-gate="open">{c.gateOpen}</p>}
      <p className="sr-only" aria-live="polite">{fmt(c.progress, { done, total: views.length })}</p>
      <ul className="flex flex-col gap-3">
        {data.sheets.map((s) => (
          <li key={`${s.character_id}:${s.stage ?? ""}`} className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-semibold">{name(s.character_id, s.stage)}</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {s.views.map((v) => (
                <li key={v.view} className="flex min-w-0 flex-col gap-1" data-view={v.view} data-status={v.status}>
                  <p className="text-xs font-semibold">{c.views[v.view]}</p>
                  {v.asset_id && <SheetImage assetId={v.asset_id} alt={fmt(c.imageAlt, { view: c.views[v.view], name: name(s.character_id, s.stage) })} unavailable={c.imageUnavailable} />}
                  <p className="text-xs" aria-live="polite">{c.status[v.status]}</p>
                  <div className="flex flex-wrap gap-2">
                    {v.status === "ready" && <button type="button" className="btn-primary min-h-11 px-3 text-sm" disabled={busy} onClick={() => void mark(s, v, "approve")}>{c.approve}</button>}
                    {(v.status === "ready" || v.status === "approved" || v.status === "failed") && (
                      <button type="button" className="btn-quiet min-h-11 px-3 text-sm" disabled={busy} title={c.redoNote}
                        onClick={() => void mark(s, v, "redo")}>{v.status === "failed" ? c.retry : c.redo}</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {data.refusal && <p className="text-sm" role="alert" data-sheets-refusal={data.refusal}>{err(data.refusal)}</p>}
      {!data.refusal && data.quote === null && <p className="text-sm" role="alert">{c.priceUnknown}</p>}
      {data.quote && data.quote.views.length > 0 && !confirming && (
        <button type="button" className="btn-primary min-h-11 self-start px-4 text-sm" disabled={busy} onClick={() => setConfirming(true)}>
          {fmt(fronts ? c.make : c.makeMore, { credits: credits(data.quote.total) })}
        </button>
      )}
      {data.quote && data.quote.waiting > 0 && <p className="text-xs text-[var(--color-muted)]">{pluralText(c.waiting, data.quote.waiting, locale)}</p>}
      {confirming && data.quote && (
        <div className="flex flex-col gap-2" role="group" aria-label={c.title}>
          <p className="text-sm">{fmt(c.confirm, { credits: credits(data.quote.total) })}</p>
          <div className="flex flex-wrap gap-2">
            <button ref={confirmRef} type="button" className="btn-primary min-h-11 px-4 text-sm" disabled={busy} onClick={() => void make()}>{c.confirmYes}</button>
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setConfirming(false)}>{c.cancel}</button>
          </div>
        </div>
      )}
      {busy && <p className="text-xs" role="status">{c.starting}</p>}
      {data.gate?.open && filmId && anyApproved && (
        <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" disabled={busy} onClick={() => void attach()}>{c.attach}</button>
      )}
      {attached !== null && <p className="text-sm" role="status">{pluralText(c.attached, attached, locale)}</p>}
      {problem && (
        <div className="flex flex-col gap-2" role="alert" data-sheets-problem={problem.code}>
          <p className="text-sm">{err(problem.code)}</p>
          {problem.code === "insufficient_credits" && (
            <Link className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#topups`}>{c.topUp}</Link>
          )}
          {problem.code === "unauthorized" && <Link className="btn-quiet inline-flex min-h-11 items-center self-start px-4 text-sm" href="/login">{c.signIn}</Link>}
        </div>
      )}
    </section>
  );
}

/** One library picture through the library's own signed link (/api/media/{id}); a picture that cannot be shown says so. */
function SheetImage({ assetId, alt, unavailable }: { assetId: string; alt: string; unavailable: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(`/api/media/${encodeURIComponent(assetId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { urls?: Record<string, string> } | null) => { if (live) setSrc(d?.urls?.thumb ?? d?.urls?.display ?? d?.urls?.original ?? null); })
      .catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [assetId]);
  if (src === undefined) return <div className="aspect-video w-full rounded bg-[var(--color-surface-2,#eee)]" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- a signed, short-lived library link, not a static asset next/image can cache
  return src ? <img src={src} alt={alt} className="aspect-video w-full rounded object-contain" /> : <p className="text-xs">{unavailable}</p>;
}
