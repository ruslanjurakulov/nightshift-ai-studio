"use client";

/**
 * PLACEHOLDER. S5's `<LiveNode>` (`@/components/live`, branch claude/nsai-s5-live-nodes, plan item #4) replaces this file: the props
 * below are its contract, so the swap is an import change. Kept deliberately plain (legible, S5's tokens and type roles, nothing
 * bespoke): the card body's look, its states and motion are S5's.
 *
 * The card's title button is its one tab stop (the board sets nodesFocusable={false}); keys carry `nodrag nopan`. Width comes from
 * --live-node-w (248 px by default, at most the cell): the board sets it per grid column.
 */
import { memo, type CSSProperties } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { CardState } from "@/lib/studio/planGrid";

export interface LiveNodeProps {
  id: string;
  /** "scene" folds a scene's picture and clip into one card; the other kinds are the plan's steps (liveGraph LiveNodeKind). */
  kind: string;
  /** A scene's place in the plan, 1-based: read as "SCENE 04". */
  scene?: number | null;
  state: CardState;
  title: string;
  summary?: string | null;
  durationS?: number | null;
  durationBasis?: "measured" | "requested" | "planned";
  cast?: string[];
  selected?: boolean;
  /** ONE stable function for every card. */
  onOpen?: (id: string) => void;
  /** The card's place in an arriving group (the stagger); absent: it does not arrive, it is there. */
  order?: number;
  instant?: boolean;
  headingLevel?: 2 | 3 | 4;
  phase?: string;
  startedAt?: string | null;
  failureCause?: string | null;
  failureRemedy?: string | null;
  reason?: string | null;
  /** Shown but not final yet (a scene still being checked): labelled "Checking". */
  provisional?: boolean;
  /** While the film is being made: the state in words, so it is never told by the border alone (Pixel M3). */
  stateWord?: string | null;
}

export const PlanSceneCard = memo(function PlanSceneCard(p: LiveNodeProps) {
  const { t } = useI18n();
  const w = t.studioLive.plan.card;
  const label = p.kind === "scene" && typeof p.scene === "number" ? fmt(w.scene, { n: String(p.scene).padStart(2, "0") }) : null;
  // A length only with its basis, and never 0: an unknown is not a number (CLAUDE.md rule 5).
  const dur =
    typeof p.durationS === "number" && p.durationS > 0 && p.durationBasis
      ? fmt(w.duration[p.durationBasis], { n: Math.round(p.durationS * 10) / 10 })
      : null;
  const arriving = p.order !== undefined && !p.instant;
  const H = (`h${p.headingLevel ?? 3}` as "h2" | "h3" | "h4");
  return (
    <article
      className={`psc is-${p.state}${p.selected ? " is-selected" : ""}${arriving ? " ds-reveal" : ""}`}
      style={arriving ? ({ "--i": p.order } as CSSProperties) : undefined}
      data-state={p.state}
      data-kind={p.kind}
    >
      <H className="psc-head">
        <button
          type="button"
          className="psc-key nodrag nopan"
          data-node-id={p.id}
          data-testid={`plan-card-${p.id}`}
          aria-pressed={p.selected ?? false}
          onClick={() => p.onOpen?.(p.id)}
        >
          {label ? <span className="ds-t-label psc-label">{label}</span> : null}
          <span className="ds-t-body-sm psc-title">{p.title}</span>
        </button>
      </H>
      {p.summary ? <p className="ds-t-body-sm psc-summary">{p.summary}</p> : null}
      {p.provisional ? <p className="ds-t-label psc-flag">{w.checking}</p> : null}
      {p.stateWord ? <p className="ds-t-caption psc-flag psc-state" data-testid={`plan-card-state-${p.id}`}>{p.stateWord}</p> : null}
      {p.state === "unknown" ? <p className="ds-t-caption psc-flag">{p.reason ? `${w.unknown} · ${p.reason}` : w.unknown}</p> : null}
      {p.state === "disabled" && p.reason ? <p className="ds-t-caption psc-flag">{p.reason}</p> : null}
      {p.state === "failed" && (p.failureCause || p.failureRemedy) ? (
        <p className="ds-t-caption psc-flag">{[p.failureCause, p.failureRemedy].filter(Boolean).join(" ")}</p>
      ) : null}
      {dur || p.cast?.length ? (
        <ul className="psc-chips" aria-label={dur && p.cast?.length ? w.castLabel : dur ? w.lengthLabel : w.castOnlyLabel}>
          {dur ? <li className="ds-t-caption psc-chip">{dur}</li> : null}
          {(p.cast ?? []).map((name) => (
            <li key={name} className="ds-t-caption psc-chip">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
});
