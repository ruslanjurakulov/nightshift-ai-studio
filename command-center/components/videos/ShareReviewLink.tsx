"use client";

import { useCallback, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { ReviewLinkDictionary } from "@/lib/i18n/review-link/en";
import { CopyButton } from "@/components/feedback/CopyButton";
import {
  REVIEW_LINK_DAYS,
  REVIEW_LINK_DEFAULT_DAYS,
  coerceReviewLinks,
  reviewLinkState,
  type ReviewLinkDays,
  type ReviewLinkRow,
} from "@/lib/review-link";

type ErrorKey = keyof ReviewLinkDictionary["errors"];

const DAY_LABEL: Record<ReviewLinkDays, "d1" | "d3" | "d7" | "d14" | "d30"> = { 1: "d1", 3: "d3", 7: "d7", 14: "d14", 30: "d30" };

/**
 * "Share a preview" (migration 0101): a private, view-only link to this video's
 * review copy for someone with no account.
 *
 * It makes, lists and turns off links through /api/review-links, which run as
 * the signed-in person, so the database decides who may. The address is shown
 * once, when it is made (the database keeps only its hash). Nothing here
 * publishes, approves or spends: a link only lets a visitor watch the preview.
 * The language the link opens in is the one this person is using now.
 */
export function ShareReviewLink({ videoId }: { videoId: string }) {
  const { t, locale } = useI18n();
  const r = t.reviewLink;
  const [days, setDays] = useState<ReviewLinkDays>(REVIEW_LINK_DEFAULT_DAYS);
  const [links, setLinks] = useState<ReviewLinkRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"create" | string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetch(`/api/review-links?video_id=${encodeURIComponent(videoId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { links?: unknown };
      setLinks(coerceReviewLinks(body.links));
    } catch {
      setLinks(null);
      setLoadFailed(true);
    }
  }, [videoId]);

  useEffect(() => {
    void load();
  }, [load]);

  function errorKey(code: unknown): ErrorKey {
    return typeof code === "string" && code in r.errors ? (code as ErrorKey) : "failed";
  }

  async function create() {
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/review-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ video_id: videoId, days, locale }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (!res.ok || typeof body.url !== "string") {
        setError(errorKey(body.error));
      } else {
        setFresh(body.url);
        await load();
      }
    } catch {
      setError("failed");
    }
    setBusy(null);
  }

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/review-links/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(errorKey(body.error));
      }
      await load();
    } catch {
      setError("failed");
    }
    setBusy(null);
  }

  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <section className="section-card flex flex-col gap-4" aria-labelledby="share-review-title">
      <div className="flex items-start gap-3">
        <Link2 aria-hidden className="mt-1 size-5 shrink-0 text-[var(--color-muted)]" />
        <div className="min-w-0">
          <h2 id="share-review-title" className="m-0 text-lg font-semibold">
            {r.title}
          </h2>
          <p className="m-0 mt-2 text-sm leading-relaxed text-[var(--color-muted)]">{r.intro}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {r.expiryLabel}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as ReviewLinkDays)}
            disabled={busy !== null}
            className="min-h-11 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)]"
          >
            {REVIEW_LINK_DAYS.map((d) => (
              <option key={d} value={d}>
                {r.days[DAY_LABEL[d]]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={create} disabled={busy !== null} className="btn-sky pill px-4 py-2 text-sm disabled:opacity-50">
          {busy === "create" ? r.creating : r.create}
        </button>
      </div>

      {error && (
        <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
          {r.errors[error]}
        </p>
      )}

      {fresh && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-[var(--color-border)] p-3" role="status">
          <div className="text-sm font-semibold">{r.newTitle}</div>
          <p className="m-0 text-xs text-[var(--color-muted)]">{r.newNote}</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={fresh}
              aria-label={r.linkField}
              onFocus={(e) => e.currentTarget.select()}
              className="mono min-h-11 min-w-0 flex-1 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs"
            />
            <CopyButton value={fresh} label={r.linkField} />
          </div>
          <button type="button" onClick={() => setFresh(null)} className="btn-sky ghost pill self-start px-4 py-1.5 text-xs">
            {r.dismiss}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-sm font-semibold">{r.listTitle}</div>
        {loadFailed ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted)]">
            <span>{r.loadFailed}</span>
            <button type="button" onClick={() => void load()} className="btn-sky ghost pill px-4 py-1.5 text-xs">
              {r.retry}
            </button>
          </div>
        ) : links === null ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{r.loading}</p>
        ) : links.length === 0 ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{r.empty}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {links.map((l) => {
              const state = reviewLinkState(l);
              return (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--color-border)] px-3 py-2">
                  <div className="min-w-0 text-xs text-[var(--color-muted)]">
                    <span className="font-semibold" style={{ color: state === "live" ? "var(--color-ok)" : "var(--color-muted)" }}>
                      {r.state[state]}
                    </span>
                    {" · "}
                    {fmt(r.made, { when: fmtDate(l.createdAt) })}
                    {" · "}
                    {fmt(r.until, { when: fmtDate(l.expiresAt) })}
                    {" · "}
                    {fmt(r.views, { n: l.views })}
                  </div>
                  {state === "live" && (
                    <button
                      type="button"
                      onClick={() => void revoke(l.id)}
                      disabled={busy !== null}
                      aria-label={fmt(r.revokeLabel, { when: fmtDate(l.createdAt) })}
                      className="btn-sky ghost pill px-4 py-1.5 text-xs disabled:opacity-50"
                    >
                      {busy === l.id ? r.revoking : r.revoke}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
