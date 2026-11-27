"use client";

/**
 * Quick add: the "+" by a card's output opens the next steps that can take what that card puts out (lib/studio/canvas
 * KIND_SPEC accepts), and a new card can carry its own small composer.
 *
 * The composer on the card IS the Studio's composer (components/studio/GeneratePanel, layout "composer"), locked to the
 * card's tools, as the inspector's form is: the same backend quote, the same hold and idempotent create, the same short-of-
 * credits key to the top-ups. Nothing here prices, starts or uploads on its own (CLAUDE.md rule 3); no number is shown that
 * the server did not return.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { GeneratePanel, type PanelQuote } from "@/components/studio/GeneratePanel";
import { useI18n } from "@/lib/i18n/context";
import { useShell } from "@/components/shell/ShellContext";
import { KIND_SPEC, TOOL_KINDS, type CanvasNode, type CanvasState, type PortType, type ToolKind } from "@/lib/studio/canvas";
import { KIND_ICONS } from "./parts";
import { inputOf, kindOpen, upstreamWords, type JobReading } from "./nodeState";
import { nodePrefill, toolsFor, useFormToken, type PanelData } from "./Inspector";
import "@/components/studio/desk.css";
import "@/components/studio/availability.css";
import "@/components/studio/studio-home.css";

/** The kinds that can follow an output of this type: their input takes it. A prompt never follows (it has no input). */
export function nextKinds(out: PortType | null): ToolKind[] {
  if (!out) return [];
  return TOOL_KINDS.filter((k) => KIND_SPEC[k].accepts.includes(out));
}

export type QuickMenuState = {
  from: string;
  /** Where the menu opens, in the window (the "+" or the point a wire was dropped). */
  x: number;
  y: number;
  /** Where the new card goes, on the canvas: the drop point; absent, to the right of the source. */
  at?: { x: number; y: number };
  /** What opened it: focus returns here when the menu closes. */
  opener?: HTMLElement | null;
  sheet?: boolean;
};

export function QuickAddMenu({
  state,
  out,
  fromName,
  onPick,
  onClose,
}: {
  state: QuickMenuState;
  out: PortType | null;
  fromName: string;
  onPick: (k: ToolKind) => void;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const { tools: availability } = useShell();
  const kinds = nextKinds(out);
  const items = kinds.map((k) => ({ k, closed: !kindOpen(availability, k) }));
  const box = useRef<HTMLDivElement>(null);
  const opener = state.opener ?? null;
  const close = () => {
    onClose();
    opener?.focus?.();
  };
  // Focus goes to the first step that can be added; with none, to the first step (disabled ones stay focusable), and with no
  // steps at all, to the menu itself. Focus always lands inside, so Escape always closes it and nothing is trapped.
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    (b.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? b.querySelector<HTMLElement>('[role="menuitem"]') ?? b).focus();
  }, []);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const all = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!all.length) return;
      const next = e.key === "ArrowDown" ? (i + 1) % all.length : (i - 1 + all.length) % all.length;
      all[next].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };
  // On a desktop the menu sits by the "+", kept inside the window; on a phone it is a sheet from the bottom.
  const W = 300;
  const style = state.sheet
    ? undefined
    : { left: Math.max(8, Math.min(state.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - W - 8)), top: Math.max(8, Math.min(state.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 360)) };
  return (
    <>
      <div className="cv-scrim is-quick" onMouseDown={close} aria-hidden />
      <div
        ref={box}
        className={state.sheet ? "cv-quick is-sheet" : "cv-quick"}
        style={style}
        role="menu"
        aria-label={fmt(c.quick.title, { name: fromName })}
        data-quick-menu=""
        data-testid="quick-menu"
        tabIndex={-1}
        onKeyDown={onKey}
      >
        <p className="cv-pop-h">{fmt(c.quick.title, { name: fromName })}</p>
        {items.length === 0 && <p className="cv-note px-2 pb-2">{c.quick.none}</p>}
        {items.map(({ k, closed }) => {
          const Icon = KIND_ICONS[k];
          return (
            <button
              key={k}
              type="button"
              role="menuitem"
              className="cv-pal-o"
              aria-disabled={closed ? "true" : undefined}
              title={closed ? c.palette.closedWhy : undefined}
              onClick={() => {
                if (!closed) onPick(k);
              }}
              data-testid={`quick-${k}`}
            >
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-col text-left">
                <span className="cv-opt-on">{c.kinds[k].name}</span>
                <span className={closed ? "cv-opt-why" : "cv-opt-os"}>{closed ? c.node.notAvailable : c.kinds[k].desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The card's own small composer: the Studio's composer in its chat-style layout, locked to the card's tools and fed by the
 * card's wired input, exactly as the inspector's form is. "More options" opens the inspector for the full form; the words
 * typed here are the node's words (node.draft), so the inspector starts from them.
 */
export function InlineComposer({
  node,
  state,
  jobs,
  data,
  onDraft,
  onCreated,
  onMore,
  onQuote,
  creatingBy,
  onPressing,
}: {
  node: CanvasNode;
  state: CanvasState;
  jobs: ReadonlyMap<string, JobReading>;
  data: PanelData;
  onDraft: (words: string) => void;
  onCreated: (jobId: string) => void;
  onMore: () => void;
  onQuote?: (quote: PanelQuote | null) => void;
  /** The form creating this node's job right now (its token), if any. */
  creatingBy?: string;
  onPressing?: (pressing: boolean, token: string) => void;
}) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const input = inputOf(state, node, jobs);
  const [mounted] = useState(() => node.id);
  const prefill = useMemo(
    () => nodePrefill(node, input ? { type: input.type, assetId: input.assetId, text: input.text } : null, data.effects ?? [], upstreamWords(state, node)),
    // The form mounts once per input: later typing lives in the form (and in node.draft through onDraftChange).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, input?.type, input?.assetId],
  );
  // The form is not remounted on a new input while its press is in flight: a fresh one would offer Generate again.
  const liveKey = `${node.id}:${input?.type ?? ""}:${input?.assetId ?? ""}`;
  const keyRef = useRef(liveKey);
  if (creatingBy === undefined) keyRef.current = liveKey;
  const token = useFormToken(keyRef.current);
  const busy = creatingBy !== undefined;
  if (!data.orgId) return null;
  if (busy && creatingBy !== token) {
    return (
      <div className="cv-ncomp nodrag nowheel nopan" data-testid={`inline-composer-${node.id}`} aria-label={c.quick.composer}>
        <p className="cv-note" data-testid="inline-busy">
          {c.inspector.busy}
        </p>
      </div>
    );
  }
  return (
    <div className="cv-ncomp nodrag nowheel nopan" data-testid={`inline-composer-${node.id}`} aria-label={c.quick.composer}>
      <GeneratePanel
        key={keyRef.current}
        layout="composer"
        orgId={data.orgId}
        models={data.models}
        initial={prefill}
        defaultStyleKitId={data.defaultStyleKitId}
        dna={data.dna}
        plans={data.plans}
        desk={KIND_SPEC[node.kind].desk}
        only={toolsFor(node, input?.type ?? null, data.effects)}
        unavailable={data.unavailable}
        onDraftChange={onDraft}
        autoFocusPrompt
        onQuote={onQuote}
        onPressing={(on) => onPressing?.(on, token)}
        onCreated={(created) => {
          if (created) onCreated(created.id);
        }}
      />
      {/* While its press is in flight the inspector would be a second form for the same node: "More options" waits. */}
      <button type="button" className="cv-link" onClick={onMore} disabled={busy} title={busy ? c.inspector.busy : undefined} data-testid={`inline-more-${node.id}`}>
        {c.quick.more}
      </button>
    </div>
  );
}
