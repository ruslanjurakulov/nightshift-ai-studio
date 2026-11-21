"use client";

import { useI18n } from "@/lib/i18n/context";
import { nextId, previousId, type Chain } from "@/lib/regionEdit/versions";

export type VersionsState = { status: "idle" } | { status: "loading" } | { status: "ready"; chain: Chain } | { status: "failed" } | { status: "unavailable" };

/**
 * The picture's versions, oldest (the original) first. Each region edit is a new file linked to its parent, so
 * "previous version" is only a move to the parent: nothing is deleted and the original is never overwritten.
 */
export function VersionPanel({ state, current, onOpen }: { state: VersionsState; current: string | null; onOpen: (id: string) => void }) {
  const { t, fmt } = useI18n();
  const r = t.regionEdit;
  if (!current || state.status === "idle") return null;
  if (state.status === "loading") return <p className="text-sm text-[var(--color-muted)]" role="status">{r.versionsLoading}</p>;
  if (state.status === "failed") return <p className="text-sm text-[var(--color-fail)]" role="alert">{r.versionsFailed}</p>;
  if (state.status === "unavailable") return <p className="text-sm text-[var(--color-muted)]">{r.versionsUnavailable}</p>;
  const { chain } = state;
  const prev = previousId(chain);
  const next = nextId(chain);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-quiet" disabled={!prev} onClick={() => prev && onOpen(prev)}>
          {r.undo}
        </button>
        <button type="button" className="btn-quiet" disabled={!next} onClick={() => next && onOpen(next)}>
          {r.redo}
        </button>
      </div>
      {chain.items.length === 1 ? (
        <p className="text-sm text-[var(--color-muted)]">{r.versionsNone}</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label={r.versionsTitle}>
          {chain.items.map((v, i) => (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onOpen(v.id)}
                aria-current={i === chain.at ? "true" : undefined}
                className={`btn-quiet w-full justify-between ${i === chain.at ? "!border-[var(--color-primary)]" : ""}`}
              >
                <span>{i === 0 ? r.versionOriginal : fmt(r.versionN, { n: v.version })}</span>
                {i === chain.at ? <span className="text-xs text-[var(--color-muted)]">{r.versionViewing}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
