"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Unplug, X } from "lucide-react";
import { GeneratePanel, type PanelQuote } from "@/components/studio/GeneratePanel";
import { useI18n } from "@/lib/i18n/context";
import {
  failureReason,
  needsRecording,
  needsSource,
  needsVideo,
  prefillFromJob,
  prefillFromQuery,
  resultHref,
  statusView,
  type StudioCapability,
  type StudioModel,
  type StudioPrefill,
} from "@/lib/creative/studio";
import { DESK_TOOLS } from "@/lib/creative/desks";
import { withEffectSource, type CanvasEffect } from "@/lib/effects/shared";
import { KIND_SPEC, type CanvasNode, type CanvasState, type PortType } from "@/lib/studio/canvas";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import type { LibraryPreview } from "@/components/studio/useLibraryImages";
import { LAMP, inputOf, upstreamWords, wireCandidates, type JobReading, type NodeStatus } from "./nodeState";
import { KIND_ICONS, Lamp } from "./parts";
import { SceneActionContext } from "./SceneActionContext";
// The composer's desk layout and its "not available" styles: the same sheets /create loads for it.
import "@/components/studio/desk.css";
import "@/components/studio/availability.css";

export interface PanelData {
  orgId: string | null;
  models: StudioModel[];
  unavailable: readonly string[];
  plans: UpsellCatalog | null;
  dna: (StudioDna & { href: string }) | null;
  defaultStyleKitId: string | null;
  /** The effects, each with its composer prefill where one of its models is offered here, resolved on the server
   *  (lib/effects/catalog.ts canvasEffects): the effects' model order and prompts are not in the canvas's chunk. */
  effects: readonly CanvasEffect[];
}

/**
 * The tools a node's form may offer: its kind's, and nothing that would contradict it (an Image → Video node never
 * turns into a clip from words). Edit · Upscale offers the picture or the clip operations by what is wired in; Voice
 * offers speech from words, or the recording tools when a recording is wired in.
 */
export function toolsFor(node: CanvasNode, input: PortType | null, effects: readonly CanvasEffect[]): StudioCapability[] {
  switch (node.kind) {
    case "image":
      return ["t2i"];
    case "video":
      return ["t2v"];
    case "animate":
      return ["i2v"];
    case "effects": {
      const effect = node.effectId ? effects.find((e) => e.id === node.effectId) : undefined;
      return [effect?.capability ?? "t2v"];
    }
    case "enhance":
      return DESK_TOOLS.enhance.filter((c) => (input === "video" ? needsVideo(c) : !needsVideo(c)));
    case "voice":
      return input === "audio" || input === "video" ? ["voice_change", "dub"] : ["tts"];
    default:
      return [];
  }
}

/** The tool a node's form starts on. */
export function startCapability(node: CanvasNode, input: PortType | null, effects: readonly CanvasEffect[]): StudioCapability | null {
  return toolsFor(node, input, effects)[0] ?? null;
}

/** The form's starting values: the node's tool, its words (or the wired prompt's), and the wired file. Fills only: no price, no spend. */
export function nodePrefill(
  node: CanvasNode,
  input: { type: PortType | null; assetId: string | null; text?: string | null } | null,
  /** The effects as the server resolved them for this workspace (PanelData.effects). */
  effects: readonly CanvasEffect[],
  /** The chain's words (nodeState upstreamWords): only an animation starts from them, the other file tools keep their own. */
  chainWords: string | null = null,
): StudioPrefill | null {
  const sourceId = input?.assetId ?? null;
  const cap0 = startCapability(node, input?.type ?? null, effects);
  const words = node.draft || input?.text || (cap0 === "i2v" ? chainWords ?? "" : "");
  if (node.kind === "effects" && node.effectId) {
    const effect = effects.find((e) => e.id === node.effectId);
    if (effect?.prefill) return withEffectSource(effect.prefill, sourceId);
  }
  const cap = startCapability(node, input?.type ?? null, effects);
  if (!cap) return null;
  const takesFile = needsSource(cap) || needsRecording(cap) || needsVideo(cap);
  const base = prefillFromQuery(cap, takesFile && sourceId ? sourceId : undefined);
  return base ? { ...base, prompt: words } : null;
}

/**
 * The selected node's inspector, scoped to that node: its inputs, its last result, and the existing composer locked to
 * the node's own tools (`only`). The composer IS today's GeneratePanel — the same models, the same backend quote, the
 * same hold and the same errors ("Add credits · need N more" included). Nothing here prices or spends on its own.
 */
/**
 * A token for one mounted form (one key of it): a new form for the same node, after a close and reopen, a swap from the card's
 * composer, or a remount on a new input, gets a new token. While a press is in flight only the form holding its token may still
 * show Generate; every other form for that node says it is busy, so one node never pays for two jobs at once.
 */
export function useFormToken(formKey: string): string {
  const ref = useRef<{ key: string; token: string } | null>(null);
  if (!ref.current || ref.current.key !== formKey) ref.current = { key: formKey, token: `${formKey}#${Math.random().toString(36).slice(2)}` };
  return ref.current.token;
}

export function Inspector({
  node,
  state,
  jobs,
  status,
  closed,
  data,
  previews,
  nodeName,
  retryNow = false,
  onRetried,
  onQuote,
  creatingBy,
  onPressing,
  onClose,
  onDraft,
  onCreated,
  onWire,
  onDisconnect,
  onEffect,
  sheet = false,
}: {
  node: CanvasNode;
  state: CanvasState;
  jobs: ReadonlyMap<string, JobReading>;
  status: NodeStatus;
  closed: boolean;
  data: PanelData;
  previews: ReadonlyMap<string, LibraryPreview>;
  nodeName: (n: CanvasNode) => string;
  /** Bumped by the node's Retry chip: the form refills from the failed job, and is priced again before it starts. */
  /** The node's Retry chip was pressed: refill the form from the failed job once (also when the inspector opens for it). */
  retryNow?: boolean;
  onRetried?: () => void;
  /** The composer's server quote for this node (credits, or null), for the dock's key. */
  onQuote?: (quote: PanelQuote | null) => void;
  /** The form that is creating this node's job right now (its token), if any: no other form may offer Generate meanwhile. */
  creatingBy?: string;
  /** A press of this form's Generate started or ended its POST (with this form's token). */
  onPressing?: (pressing: boolean, token: string) => void;
  onClose: () => void;
  onDraft: (words: string) => void;
  onCreated: (jobId: string) => void;
  onWire: (fromId: string) => void;
  onDisconnect: () => void;
  onEffect: (effectId: string | null) => void;
  /** Drawn as the phone's bottom sheet, where wiring happens from the Inputs list. */
  sheet?: boolean;
}) {
  const { t, fmt } = useI18n();
  const c = t.studioCanvas;
  const spec = KIND_SPEC[node.kind];
  const input = inputOf(state, node, jobs);
  const reading = node.jobId ? jobs.get(node.jobId) : undefined;
  const job = reading?.state === "ok" ? reading.job : null;
  const [seed, setSeed] = useState<{ nonce: number; prefill: StudioPrefill | null }>(() => ({ nonce: 0, prefill: null }));
  const panelKey = `${node.id}:${node.effectId ?? ""}:${input?.type ?? ""}:${seed.nonce}`;
  const token = useFormToken(panelKey);
  const [sourceRequest, setSourceRequest] = useState<{ nonce: number; id: string } | null>(null);
  const firstSource = useRef(input?.assetId ?? null);
  const box = useRef<HTMLElement>(null);

  // A new node, or a new effect, starts its form again from the node, and opens at the top: inputs and result first.
  useEffect(() => {
    setSeed({ nonce: 0, prefill: null });
    setSourceRequest(null);
    firstSource.current = input?.assetId ?? null;
    const id = window.setTimeout(() => box.current?.scrollTo?.(0, 0), 60);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.effectId]);

  // The node's Retry chip: a fresh form from that job, once, as soon as the job has been read.
  useEffect(() => {
    if (!retryNow || !job) return;
    setSeed((s) => ({ nonce: s.nonce + 1, prefill: prefillFromJob(job) }));
    onRetried?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNow, job]);

  // The wired file arrived or changed while the form is open: hand it in without clearing the words typed.
  const sourceId = input?.assetId ?? null;
  useEffect(() => {
    if (!sourceId || sourceId === firstSource.current) return;
    firstSource.current = sourceId;
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id: sourceId }));
  }, [sourceId]);

  const effects = data.effects;
  const only = toolsFor(node, input?.type ?? null, effects);
  const prefill = useMemo(
    () =>
      seed.prefill ??
      nodePrefill(node, input ? { type: input.type, assetId: input.assetId, text: input.text } : null, effects, upstreamWords(state, node)),
    // The form mounts once per seed: later typing lives in the form (and in node.draft through onDraft).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed, node.id, node.effectId, input?.type],
  );

  const accepts = spec.accepts.map((k) => c.ports[k]).join(" / ");
  const candidates = wireCandidates(state, node);
  const effect = node.kind === "effects" && node.effectId ? effects.find((e) => e.id === node.effectId) ?? null : null;
  // The composer's Generate key sticks to the bottom of what scrolls it (globals.css .studio-dock): here, this panel.
  const dock = { "--studio-dock-offset": "0px" } as CSSProperties;
  const href = job ? resultHref(job) : null;
  const preview = job?.result_asset_ids[0] ? previews.get(job.result_asset_ids[0]) : undefined;
  const Icon = KIND_ICONS[node.kind];

  return (
    <aside ref={box} className={sheet ? "cv-insp is-sheet" : "cv-insp"} aria-label={c.inspector.label} data-testid="canvas-inspector" style={dock}>
      <header className="cv-ih">
        <span aria-hidden className={`cv-ty k-${node.kind}`}>
          <Icon className="size-4" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="cv-ih-k">{c.kinds[node.kind].name}</p>
          <h2 className="cv-ih-t">{nodeName(node)}</h2>
        </div>
        <button type="button" className="cv-icon" onClick={onClose} aria-label={c.inspector.close} title={c.inspector.close}>
          <X aria-hidden className="size-4" />
        </button>
      </header>

      <div className="cv-ib">
        {spec.accepts.length > 0 && (
          <section className="cv-block" aria-label={c.inspector.inputs}>
            <h3 className="cv-lbl">{c.inspector.inputs}</h3>
            {input ? (
              <div className="cv-row">
                <span className="cv-chip">{input.type === "text" ? fmt(c.inspector.fromWords, { name: nodeName(input.from) }) : fmt(c.node.from, { name: nodeName(input.from) })}</span>
                <button type="button" className="cv-link" onClick={onDisconnect}>
                  <Unplug aria-hidden className="size-3.5" /> {c.inspector.disconnect}
                </button>
              </div>
            ) : (
              <p className={spec.required ? "cv-note is-warn" : "cv-note"} data-testid="inspector-needs">
                {spec.required ? fmt(c.node.needsInput, { kinds: accepts }) : c.inspector.inputNone} {!sheet && c.inspector.wireHint}
              </p>
            )}
            {input && input.type !== "text" && !input.assetId && <p className="cv-note">{c.inspector.waitingInput}</p>}
            {/* On a phone there is no wire to drag: the Inputs list is the way to wire. On a desktop the wire is the input. */}
            {sheet && (
              <label className="cv-fld">
                <span className="cv-lbl">{c.inspector.pick}</span>
                {candidates.length > 0 ? (
                  <select className="cv-inp" value={input?.from.id ?? ""} onChange={(e) => (e.target.value ? onWire(e.target.value) : onDisconnect())} data-testid="inspector-wire">
                    <option value="">—</option>
                    {candidates.map((n) => (
                      <option key={n.id} value={n.id}>
                        {nodeName(n)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="cv-note">{fmt(c.inspector.pickNone, { kinds: accepts })}</span>
                )}
              </label>
            )}
          </section>
        )}

        {node.kind === "effects" && !closed && (
          <section className="cv-block">
            <h3 className="cv-lbl">{effect ? t.effects.items[effect.id].name : c.inspector.effectPick}</h3>
            {effect ? (
              <button type="button" className="cv-link" onClick={() => onEffect(null)}>
                {c.inspector.effectChange}
              </button>
            ) : (
              <EffectList effects={effects} onPick={onEffect} />
            )}
          </section>
        )}

        {job && (
          <section className="cv-block" data-testid="inspector-result">
            <h3 className="cv-lbl">{c.inspector.resultTitle}</h3>
            <div className="cv-row">
              <Lamp tone={LAMP[status]} live={status === "working"} label={statusView(t, job.status).label} />
              {href && (
                <a href={href} target="_blank" rel="noreferrer" className="cv-link">
                  <ExternalLink aria-hidden className="size-3.5" /> {c.inspector.openResult}
                </a>
              )}
            </div>
            {preview?.thumbUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.thumbUrl} alt="" className="cv-insp-art" />
            )}
            {status === "failed" && (
              <div className="cv-alert" role="alert">
                <p className="m-0" data-testid="inspector-failure">
                  {failureReason(t, job)}
                </p>
                <button type="button" className="cv-key" onClick={() => setSeed((s) => ({ nonce: s.nonce + 1, prefill: prefillFromJob(job) }))} data-testid="inspector-retry">
                  {c.node.retry}
                </button>
                <p className="cv-note">{c.inspector.retryHint}</p>
              </div>
            )}
          </section>
        )}

        {reading?.state === "unknown" && <p className="cv-note is-warn">{c.node.unknown}</p>}

        <SceneActionContext capabilities={only} source={input ? { type: input.type, assetId: input.assetId } : null} />

        <section className="cv-form">
          {node.kind === "prompt" ? (
            <label className="cv-fld">
              <span className="cv-lbl">{c.inspector.promptLabel}</span>
              <textarea
                className="cv-inp cv-words"
                value={node.draft}
                onChange={(e) => onDraft(e.target.value.slice(0, 4000))}
                placeholder={c.firstRun.askPlaceholder}
                data-testid="prompt-words"
              />
              <span className="cv-note">{c.inspector.promptHint}</span>
            </label>
          ) : node.kind === "asset" ? null : !data.orgId ? (
            <p className="cv-note">{c.inspector.noOrg}</p>
          ) : closed ? (
            // Nothing on sale for this tool: said in words, and no form that would only end in "no model".
            <p className="cv-note is-warn" data-testid="inspector-unavailable">
              <strong>{c.node.notAvailable}.</strong> {c.inspector.unavailable}
            </p>
          ) : status === "working" || status === "queued" || status === "loading" || (creatingBy !== undefined && creatingBy !== token) ? (
            // One job per node at a time: a second press would start (and pay for) another and drop this one off the canvas.
            <p className="cv-note" data-testid="inspector-busy">
              {status === "loading" ? c.node.reading : c.inspector.busy}
            </p>
          ) : node.kind === "effects" && !effect ? null : (
            <GeneratePanel
              key={panelKey}
              orgId={data.orgId}
              models={data.models}
              initial={prefill}
              defaultStyleKitId={data.defaultStyleKitId}
              dna={seed.nonce > 0 ? null : data.dna}
              sourceRequest={sourceRequest}
              plans={data.plans}
              desk={spec.desk}
              only={only}
              onePerQuote
              onQuote={onQuote}
              onPressing={(on) => onPressing?.(on, token)}
              unavailable={data.unavailable}
              onDraftChange={onDraft}
              // The inspector opens on its inputs and the node's last result; the words box does not grab focus and scroll them away.
              autoFocusPrompt={false}
              onCreated={(created) => {
                if (created) onCreated(created.id);
              }}
            />
          )}
        </section>
      </div>
    </aside>
  );
}

function EffectList({ effects, onPick }: { effects: readonly CanvasEffect[]; onPick: (id: string) => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  // Ready = one of the effect's models is offered here: the server sent its prefill (canvasEffects), and only then.
  if (!effects.some((e) => e.prefill !== null)) return <p className="cv-note">{c.inspector.effectNone}</p>;
  return (
    <ul className="cv-effects">
      {effects.map((e) => (
        <li key={e.id}>
          <button type="button" className="cv-effect" disabled={e.prefill === null} onClick={() => onPick(e.id)} data-testid={`effect-${e.id}`}>
            <span className="cv-effect-sw" aria-hidden style={{ background: `linear-gradient(135deg, ${e.hues[0]}, ${e.hues[1]})` }} />
            <span className="flex min-w-0 flex-col text-left">
              <span className="font-semibold">{t.effects.items[e.id].name}</span>
              <span className="cv-note">{e.prefill !== null ? c.inspector.effectReady : c.node.notAvailable}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
