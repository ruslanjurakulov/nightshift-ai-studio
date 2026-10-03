"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { StepCard, StepList, type StepState } from "@/components/ui/StepCard";
import { appendExtraOff, creditUnit } from "@/lib/credits";
import {
  MAX_NARRATION,
  MAX_SCENES,
  MAX_VISUAL,
  editProblem,
  minutesLabel,
  sceneProblem,
  squash,
  storyboardErrorText,
  toScenes,
  type ReopenState,
  type SceneProblem,
  type StoryboardQuote,
  type StoryboardScene,
  type StoryboardStatus,
  type StoryboardView,
} from "@/lib/storyboardReview";

const STATUS_TONE: Record<StoryboardStatus, "ok" | "run" | "warn" | "idle"> = {
  ready: "warn",
  approved: "run",
  rendered: "ok",
  discarded: "idle",
  unknown: "idle",
};

/** One scene as it is being edited. `src` is its number in the saved
 *  revision (null for a scene added here); `key` keeps React and focus on the
 *  same card while scenes move. */
interface Draft {
  key: string;
  src: number | null;
  narration: string;
  visual: string;
}

interface Saved {
  revision: number | null;
  scenes: StoryboardScene[];
  durationS: number;
}

let draftSeq = 0;
const nextKey = () => `d${++draftSeq}`;

function draftsOf(scenes: StoryboardScene[], keys?: string[]): Draft[] {
  return scenes.map((s, i) => ({ key: keys?.[i] ?? nextKey(), src: i + 1, narration: s.narration, visual: s.visual }));
}

/** The saved scene a draft still is, text unchanged — or null. Moved text is
 *  unchanged; edited or new text is measured by the database when saved. */
function unchangedScene(d: Draft, saved: StoryboardScene[]): StoryboardScene | null {
  if (d.src === null) return null;
  const s = saved[d.src - 1];
  if (!s || squash(d.narration) !== s.narration) return null;
  return s;
}

function isDirty(draft: Draft[], saved: StoryboardScene[]): boolean {
  if (draft.length !== saved.length) return true;
  return draft.some(
    (d, i) => d.src !== i + 1 || squash(d.narration) !== saved[i].narration || squash(d.visual) !== saved[i].visual,
  );
}

function problemText(p: SceneProblem, ts: Dictionary["storyboardReview"]): string {
  switch (p) {
    case "empty":
      return ts.probEmpty;
    case "too_long":
      return ts.probTooLong;
    case "markup":
      return ts.probMarkup;
    case "characters":
      return ts.probCharacters;
    case "terms":
      return ts.probTerms;
  }
}

function isQuote(v: unknown): v is StoryboardQuote {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  if (q.kind === "paid") return typeof q.credits === "number" && Number.isFinite(q.credits);
  return q.kind === "included" || (q.kind === "unavailable" && typeof q.reason === "string");
}

/**
 * One waiting run's storyboard (migrations 0057, 0058): the scene cards, and
 * ONE price for the render in a footer that stays in reach while the cards
 * scroll. "Approve & render · N credits" is the only control here that
 * spends, and it sends the price it shows and the revision it was shown for;
 * everything else — editing, Discard, Re-open — spends nothing. All of it is
 * re-checked on the server; this screen only asks.
 *
 * Editing (someone who may start runs, while it waits, once 0058 is applied):
 * a scene's narration and visual description inline, delete (with undo for
 * this visit), move up / down, add a scene. Edits are saved explicitly; until
 * they are, the screen says "Not saved" and Approve waits, because the price
 * on the button is the server's price for the SAVED scenes — the length of an
 * edited scene is measured by the database, never guessed here.
 */
export function StoryboardReview({
  storyboard,
  quote,
  canRun,
  backHref,
  bottomBar = true,
  reopen = null,
}: {
  storyboard: StoryboardView;
  quote: StoryboardQuote;
  /** May this person start runs on the channel (the Run now rule)? Presentation only. */
  canRun: boolean;
  backHref: string;
  /** Customers have a phone tab bar the footer sits above. */
  bottomBar?: boolean;
  /** For an approved storyboard: may it go back to waiting (its render failed)? */
  reopen?: ReopenState | null;
}) {
  const { t, locale } = useI18n();
  const ts = t.storyboardReview;
  const router = useRouter();
  const [status, setStatus] = useState<StoryboardStatus>(storyboard.status);
  const [price, setPrice] = useState<StoryboardQuote>(quote);
  // What the approval held for the render (0057 credits_held): the stored row,
  // or the approve answer; null = none on record, never shown as 0.
  const [hold, setHold] = useState<{ credits: number | null; included: boolean }>({
    credits: storyboard.creditsHeld,
    included: false,
  });
  const [saved, setSaved] = useState<Saved>({
    revision: typeof storyboard.revision === "number" ? storyboard.revision : null,
    scenes: storyboard.scenes,
    durationS: storyboard.durationS,
  });
  const [draft, setDraft] = useState<Draft[]>(() => draftsOf(storyboard.scenes));
  const [removed, setRemoved] = useState<{ scene: Draft; index: number }[]>([]);
  const [busy, setBusy] = useState<"approve" | "discard" | "save" | "reopen" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const discardRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const focusables = useRef(new Map<string, HTMLElement>());
  const noteId = useId();
  const baseId = useId();

  const waiting = status === "ready";
  const editable = waiting && canRun && saved.revision !== null;
  const dirty = editable && isDirty(draft, saved.scenes);
  const problem = editable ? editProblem(draft) : null;
  const priced = price.kind === "paid" || price.kind === "included";
  const canApprove = waiting && canRun && priced && busy === null && saved.scenes.length > 0 && !dirty && !stale;
  const total = fmt(ts.total, { n: saved.scenes.length, m: minutesLabel(saved.durationS) });
  const statusLabel =
    status === "ready"
      ? ts.statusReady
      : status === "approved"
        ? ts.statusApproved
        : status === "rendered"
          ? ts.statusRendered
          : status === "discarded"
            ? ts.statusDiscarded
            : ts.statusUnknown;
  const offerReopen = status === "approved" && canRun && reopen?.reopenable === true;

  const lengths = useMemo(() => draft.map((d) => unchangedScene(d, saved.scenes)?.durationS ?? null), [draft, saved]);
  // The running length up to and including each scene; unknown from the first
  // scene whose length the database has not measured yet, never a guess.
  const running = useMemo(() => {
    let sum: number | null = 0;
    return lengths.map((l) => {
      sum = sum !== null && l !== null ? sum + l : null;
      return sum;
    });
  }, [lengths]);

  // The make as a rundown: each scene is a step that costs nothing to read,
  // then the render, whose price is the backend's one quote or nothing.
  const sceneStep: { state: StepState; label: string } =
    status === "ready"
      ? { state: "next", label: ts.stepToReview }
      : status === "approved" || status === "rendered"
        ? { state: "done", label: ts.stepApproved }
        : { state: "next", label: status === "discarded" ? ts.statusDiscarded : ts.statusUnknown };
  const renderStep: { state: StepState; label: string } =
    status === "ready"
      ? { state: "blocked", label: ts.stepAwaiting }
      : status === "approved"
        ? { state: "current", label: ts.stepRendering }
        : status === "rendered"
          ? { state: "done", label: ts.statusRendered }
          : { state: "next", label: status === "discarded" ? ts.stepNotRendered : ts.statusUnknown };
  // The Render step's figure is the price of what would render, or what was
  // held for it — never a quote for something else: while scenes are edited
  // and unsaved, the saved scenes' quote is not this render's price; once
  // approved, the hold on record is (not today's quote).
  const decided = status === "approved" || status === "rendered";
  const renderFigure: { credits: number | null; words?: string; label: string; unknown: string } = decided
    ? hold.included
      ? { credits: null, words: ts.priceIncluded, label: ts.stepHeld, unknown: ts.heldUnknown }
      : { credits: hold.credits, label: ts.stepHeld, unknown: ts.heldUnknown }
    : waiting && dirty
      ? { credits: null, words: ts.renderOnSave, label: ts.stepPrice, unknown: ts.renderOnSave }
      : waiting
        ? {
            credits: price.kind === "paid" ? price.credits : null,
            words: price.kind === "included" ? ts.priceIncluded : undefined,
            label: ts.stepPrice,
            unknown: ts.priceUnknown,
          }
        : { credits: null, label: ts.stepPrice, unknown: ts.priceUnknown };

  function register(key: string) {
    return (el: HTMLElement | null) => {
      if (el) focusables.current.set(key, el);
      else focusables.current.delete(key);
    };
  }
  // Focus moves after React has put the card where it now is (a moved, added
  // or restored scene; the Undo after a delete), never to a stale node.
  const pendingFocus = useRef<string | null>(null);
  function focusLater(key: string) {
    pendingFocus.current = key;
  }
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    if (key === "undo") undoRef.current?.focus();
    else focusables.current.get(key)?.focus();
  });

  async function post(
    action: "approve" | "discard" | "edit" | "reopen",
    payload: unknown,
  ): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
    try {
      const res = await fetch(`/api/storyboards/${storyboard.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let body: Record<string, unknown> | null = null;
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      return { ok: res.ok, body };
    } catch {
      return { ok: false, body: null };
    }
  }

  // ── editing ──────────────────────────────────────────────────────────────

  function update(key: string, patch: Partial<Pick<Draft, "narration" | "visual">>) {
    setDraft((d) => d.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= draft.length) return;
    const next = draft.slice();
    const [s] = next.splice(index, 1);
    next.splice(to, 0, s);
    setDraft(next);
    setAnnounce(fmt(ts.moved, { n: to + 1 }));
    // Focus stays on the scene that moved; at an edge, on the way it can still go.
    const dir = to === 0 ? "down" : to === next.length - 1 ? "up" : by < 0 ? "up" : "down";
    focusLater(`${s.key}:${dir}`);
  }

  function remove(index: number) {
    if (draft.length <= 1) return;
    const scene = draft[index];
    setDraft(draft.filter((_, i) => i !== index));
    setRemoved((r) => [...r, { scene, index }]);
    setAnnounce(fmt(ts.deleted, { n: index + 1 }));
    focusLater("undo");
  }

  function undoRemove() {
    const last = removed[removed.length - 1];
    if (!last || draft.length >= MAX_SCENES) return;
    const next = draft.slice();
    const at = Math.min(last.index, next.length);
    next.splice(at, 0, last.scene);
    setDraft(next);
    setRemoved(removed.slice(0, -1));
    setAnnounce(fmt(ts.restored, { n: at + 1 }));
    focusLater(`${last.scene.key}:narration`);
  }

  function add() {
    if (draft.length >= MAX_SCENES) return;
    const scene: Draft = { key: nextKey(), src: null, narration: "", visual: "" };
    setDraft([...draft, scene]);
    setAnnounce(fmt(ts.added, { n: draft.length + 1 }));
    focusLater(`${scene.key}:narration`);
  }

  function revert() {
    setDraft(draftsOf(saved.scenes, draft.length === saved.scenes.length ? draft.map((d) => d.key) : undefined));
    setRemoved([]);
    setError(null);
    setAnnounce(ts.reverted);
  }

  async function save() {
    if (!editable || !dirty || problem !== null || busy || saved.revision === null) return;
    setBusy("save");
    setError(null);
    const { ok, body } = await post("edit", {
      revision: saved.revision,
      scenes: draft.map((d) => ({ src: d.src, narration: d.narration, visual: d.visual })),
    });
    setBusy(null);
    if (ok && body && typeof body.revision === "number" && typeof body.durationS === "number") {
      const scenes = toScenes(body.scenes);
      setSaved({ revision: body.revision, scenes, durationS: body.durationS });
      setDraft(draftsOf(scenes, scenes.length === draft.length ? draft.map((d) => d.key) : undefined));
      // A delete can still be undone after saving: it comes back as a new
      // scene (its old number belongs to the revision that was replaced).
      setRemoved((r) => r.map((x) => ({ ...x, scene: { ...x.scene, src: null } })));
      setPrice(isQuote(body.quote) ? body.quote : { kind: "unavailable", reason: "read_failed" });
      setAnnounce(ts.saved);
      return;
    }
    if (body?.error === "stale_revision") setStale(true);
    if (body?.error === "storyboard_not_ready") router.refresh();
    setError(appendExtraOff(storyboardErrorText(body, ts), body, t));
  }

  // ── decisions ────────────────────────────────────────────────────────────

  async function approve() {
    if (!canApprove) return;
    setBusy("approve");
    setError(null);
    const payload: Record<string, unknown> = price.kind === "paid" ? { max_credits: price.credits } : {};
    if (saved.revision !== null) payload.revision = saved.revision;
    const { ok, body } = await post("approve", payload);
    setBusy(null);
    if (ok) {
      const reserved = body?.credits_reserved;
      setHold({
        credits: typeof reserved === "number" && Number.isFinite(reserved) ? reserved : null,
        // Approved without a price (an operator channel): nothing was held, by design.
        included: price.kind === "included",
      });
      setStatus("approved");
      setNotice(ts.approvedNote);
      router.refresh();
      return;
    }
    // A new price is shown, never pressed for the person: the next press
    // carries it, and only if they press again.
    if (body?.error === "price_changed" && typeof body.credits === "number") setPrice({ kind: "paid", credits: body.credits });
    if (body?.error === "stale_revision") setStale(true);
    if (body?.error === "storyboard_not_ready") router.refresh();
    setError(appendExtraOff(storyboardErrorText(body, ts), body, t));
  }

  async function discard() {
    if (!waiting || !canRun || busy) return;
    setBusy("discard");
    setError(null);
    const { ok, body } = await post("discard", {});
    setBusy(null);
    setConfirming(false);
    if (ok) {
      setStatus("discarded");
      setNotice(ts.discardedNote);
      router.refresh();
      return;
    }
    if (body?.error === "storyboard_not_ready") router.refresh();
    setError(appendExtraOff(storyboardErrorText(body, ts), body, t));
    discardRef.current?.focus();
  }

  async function reopenIt() {
    if (!offerReopen || busy) return;
    setBusy("reopen");
    setError(null);
    const { ok, body } = await post("reopen", {});
    setBusy(null);
    if (ok) {
      setNotice(ts.reopenedNote);
      // The page reads it again: waiting, editable, with a fresh price.
      router.refresh();
      return;
    }
    setError(appendExtraOff(storyboardErrorText(body, ts), body, t));
  }

  const dock = { "--sb-dock-offset": bottomBar ? "64px" : "0px" } as CSSProperties;
  const approveLabel =
    busy === "approve"
      ? ts.approving
      : price.kind === "paid"
        ? fmt(ts.approve, { credits: price.credits })
        : ts.approveIncluded;
  const statusNote =
    notice ??
    (status === "approved"
      ? offerReopen
        ? ts.renderFailedNote
        : ts.approvedNote
      : status === "rendered"
        ? ts.renderedNote
        : status === "discarded"
          ? ts.discardedNote
          : "");
  const lastRemoved = removed[removed.length - 1];

  return (
    <div className="flex flex-col gap-4" style={dock} data-testid="storyboard-review">
      <div>
        <Link href={backHref} className="text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)]">
          ← {ts.back}
        </Link>
      </div>

      <header className="panel flex flex-col gap-2 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusLamp tone={STATUS_TONE[status]} label={statusLabel} />
          <span className="text-xs text-[var(--color-muted)]">{total}</span>
        </div>
        <h2 className="m-0 text-[17px] font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]">
          {storyboard.title ?? storyboard.topic}
        </h2>
        {storyboard.title && storyboard.topic && (
          <p className="m-0 text-sm text-[var(--color-muted)] [overflow-wrap:anywhere]">{storyboard.topic}</p>
        )}
        {waiting && <p className="m-0 text-xs text-[var(--color-muted)]">{ts.planNote}</p>}
        {editable && <p className="m-0 text-xs text-[var(--color-muted)]">{ts.editNote}</p>}
      </header>

      <p role="status" aria-live="polite" className="m-0 text-sm text-[var(--color-ok)] empty:hidden">
        {statusNote}
      </p>
      <p className="sr-only" aria-live="polite" data-testid="storyboard-announce">
        {announce}
      </p>

      {offerReopen && (
        <div className="panel flex flex-col gap-2 p-5 sm:p-6" data-testid="storyboard-reopen">
          <p className="m-0 text-sm leading-relaxed text-[var(--color-fg)]">{ts.reopenNote}</p>
          {error && (
            <p role="alert" className="m-0 text-sm text-[var(--color-fail)]">
              {error}
            </p>
          )}
          <button type="button" className="btn-quiet self-start" onClick={reopenIt} disabled={busy !== null}>
            {busy === "reopen" ? ts.reopening : ts.reopen}
          </button>
        </div>
      )}

      {draft.length === 0 ? (
        <p className="panel m-0 p-5 sm:p-6 text-sm text-[var(--color-muted)]">{ts.noScenes}</p>
      ) : (
        <StepList label={ts.title}>
          {draft.map((d, i) => {
            const n = i + 1;
            const len = lengths[i];
            const prob = editable ? sceneProblem(d) : null;
            const narrId = `${baseId}-n-${d.key}`;
            const visId = `${baseId}-v-${d.key}`;
            const probId = `${baseId}-p-${d.key}`;
            return (
              <StepCard
                key={d.key}
                testId="storyboard-scene"
                index={n}
                title={fmt(ts.scene, { n })}
                state={sceneStep.state}
                stateLabel={sceneStep.label}
                format="duration"
                price={len}
                total={running[i]}
                totalWords={running[i] === null ? ts.totalOnSave : undefined}
                totalSpoken={running[i] !== null ? fmt(ts.seconds, { n: running[i] as number }) : undefined}
                priceSpoken={len !== null ? fmt(ts.seconds, { n: len }) : undefined}
                priceLabel={ts.length}
                totalLabel={ts.stepLengthTotal}
                unknownPrice={ts.lengthOnSave}
                locale={locale}
              >
                {editable ? (
                  <>
                    <label
                      htmlFor={narrId}
                      className="text-xs text-[var(--color-muted)]"
                    >
                      {ts.narration}
                    </label>
                    <textarea
                      id={narrId}
                      ref={register(`${d.key}:narration`)}
                      value={d.narration}
                      maxLength={MAX_NARRATION + 200}
                      rows={4}
                      onChange={(e) => update(d.key, { narration: e.target.value })}
                      aria-invalid={prob !== null && prob !== "terms"}
                      aria-describedby={prob ? probId : undefined}
                      className="w-full rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-3 py-2 text-sm leading-relaxed text-[var(--color-fg)] outline-none transition-colors focus:border-[var(--color-primary)] aria-[invalid=true]:border-[var(--color-fail)]"
                    />
                    <label
                      htmlFor={visId}
                      className="text-xs text-[var(--color-muted)]"
                    >
                      {ts.visual}
                    </label>
                    <textarea
                      id={visId}
                      value={d.visual}
                      maxLength={MAX_VISUAL + 50}
                      rows={2}
                      placeholder={ts.visualHint}
                      onChange={(e) => update(d.key, { visual: e.target.value })}
                      aria-invalid={prob === "terms"}
                      aria-describedby={prob ? probId : undefined}
                      className="w-full rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] px-3 py-2 text-sm leading-relaxed text-[var(--color-fg)] outline-none transition-colors placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] aria-[invalid=true]:border-[var(--color-fail)]"
                    />
                    {prob && (
                      <p id={probId} className="m-0 text-xs text-[var(--color-fail)]">
                        {problemText(prob, ts)}
                      </p>
                    )}
                    <div className="grid grid-cols-3 gap-2" role="group" aria-label={fmt(ts.sceneActions, { n })}>
                      <button
                        type="button"
                        ref={register(`${d.key}:up`)}
                        className="btn-quiet px-2"
                        onClick={() => move(i, -1)}
                        disabled={i === 0 || busy !== null}
                        aria-label={fmt(ts.moveUpLabel, { n })}
                      >
                        <span aria-hidden="true">↑</span> {ts.moveUp}
                      </button>
                      <button
                        type="button"
                        ref={register(`${d.key}:down`)}
                        className="btn-quiet px-2"
                        onClick={() => move(i, 1)}
                        disabled={i === draft.length - 1 || busy !== null}
                        aria-label={fmt(ts.moveDownLabel, { n })}
                      >
                        <span aria-hidden="true">↓</span> {ts.moveDown}
                      </button>
                      <button
                        type="button"
                        className="btn-quiet px-2"
                        style={{ color: "var(--color-fail)" }}
                        onClick={() => remove(i)}
                        disabled={draft.length <= 1 || busy !== null}
                        aria-label={fmt(ts.deleteLabel, { n })}
                      >
                        {ts.delete}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <div className="text-xs text-[var(--color-muted)]">{ts.narration}</div>
                      <p className="m-0 mt-1 whitespace-pre-line text-sm leading-relaxed text-[var(--color-fg)] [overflow-wrap:anywhere]">
                        {d.narration}
                      </p>
                    </div>
                    <div>
                      <div className="text-xs text-[var(--color-muted)]">{ts.visual}</div>
                      <p className="m-0 mt-1 text-sm leading-relaxed text-[var(--color-muted)] [overflow-wrap:anywhere]">
                        {d.visual || ts.noVisual}
                      </p>
                    </div>
                  </>
                )}
              </StepCard>
            );
          })}
          <StepCard
            testId="storyboard-render-step"
            index={draft.length + 1}
            title={ts.stepRender}
            state={renderStep.state}
            stateLabel={renderStep.label}
            price={renderFigure.credits}
            total={renderFigure.credits}
            priceWords={renderFigure.words}
            totalWords={renderFigure.words}
            unit={renderFigure.credits !== null ? creditUnit(renderFigure.credits, locale, t.shell.creditUnit) : undefined}
            priceLabel={renderFigure.label}
            totalLabel={ts.stepCreditsTotal}
            unknownPrice={renderFigure.unknown}
            locale={locale}
          />
        </StepList>
      )}

      {editable && (
        <div className="flex flex-col gap-2">
          {lastRemoved && (
            <div className="panel flex flex-wrap items-center justify-between gap-2 p-4 sm:p-5" data-testid="storyboard-undo">
              <span className="text-sm text-[var(--color-fg)]">{fmt(ts.deletedNote, { n: lastRemoved.index + 1 })}</span>
              <button
                ref={undoRef}
                type="button"
                className="btn-quiet"
                onClick={undoRemove}
                disabled={busy !== null || draft.length >= MAX_SCENES}
              >
                {ts.undo}
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn-quiet self-start"
            onClick={add}
            disabled={busy !== null || draft.length >= MAX_SCENES}
          >
            <span aria-hidden="true">+</span> {ts.addScene}
          </button>
        </div>
      )}

      {waiting && (
        <div className="sb-dock flex flex-col gap-2" data-testid="storyboard-dock">
          {editable && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="text-xs font-medium"
                style={{ color: dirty ? "var(--color-warn)" : "var(--color-ok)" }}
                data-testid="storyboard-save-state"
              >
                {busy === "save" ? ts.saving : dirty ? ts.notSaved : ts.saved}
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-quiet" onClick={revert} disabled={!dirty || busy !== null}>
                  {ts.revert}
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  style={
                    dirty && problem === null ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" } : undefined
                  }
                  onClick={save}
                  disabled={!dirty || problem !== null || busy !== null || stale}
                >
                  {busy === "save" ? ts.saving : ts.save}
                </button>
              </div>
            </div>
          )}
          {error && (
            <div role="alert" className="flex flex-col gap-2">
              <p className="m-0 text-sm text-[var(--color-fail)]">{error}</p>
              {stale && (
                <button type="button" className="btn-quiet self-start" onClick={() => router.refresh()}>
                  {ts.loadLatest}
                </button>
              )}
            </div>
          )}
          <p id={noteId} className="m-0 text-xs leading-relaxed text-[var(--color-muted)]">
            {!canRun
              ? ts.notAllowed
              : dirty
                ? ts.saveFirst
                : price.kind === "paid"
                  ? ts.priceNote
                  : price.kind === "included"
                    ? ts.includedNote
                    : ts.noPrice}{" "}
            {canRun && priced && !dirty ? ts.publishNote : ""}
          </p>
          {confirming ? (
            <div className="flex flex-col gap-2" role="group" aria-label={ts.discardConfirm}>
              <p className="m-0 text-sm text-[var(--color-fg)]">{ts.discardConfirm}</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  ref={keepRef}
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setConfirming(false);
                    requestAnimationFrame(() => discardRef.current?.focus());
                  }}
                  disabled={busy !== null}
                >
                  {ts.discardNo}
                </button>
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ borderColor: "var(--color-fail)", color: "var(--color-fail)" }}
                  onClick={discard}
                  disabled={busy !== null}
                >
                  {busy === "discard" ? ts.discarding : ts.discardYes}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[auto_1fr] items-stretch gap-2">
              <button
                ref={discardRef}
                type="button"
                className="btn-quiet"
                onClick={() => {
                  setConfirming(true);
                  setError(null);
                  requestAnimationFrame(() => keepRef.current?.focus());
                }}
                disabled={!canRun || busy !== null}
              >
                {ts.discard}
              </button>
              <button
                type="button"
                className="studio-cta"
                onClick={approve}
                disabled={!canApprove}
                aria-describedby={noteId}
                aria-busy={busy === "approve"}
              >
                {approveLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
