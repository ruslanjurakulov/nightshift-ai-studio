"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Unplug, X } from "lucide-react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
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
import { EFFECTS, effectPrefill, resolveEffect } from "@/lib/effects/catalog";
import { KIND_SPEC, type CanvasNode, type CanvasState, type PortType } from "@/lib/studio/canvas";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import type { LibraryPreview } from "@/components/studio/useLibraryImages";
import { LAMP, inputOf, wireCandidates, type JobReading, type NodeStatus } from "./nodeState";
import { KIND_ICONS, Lamp } from "./parts";
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
}

/**
 * The tools a node's form may offer: its kind's, and nothing that would contradict it (an Image → Video node never
 * turns into a clip from words). Edit · Upscale offers the picture or the clip operations by what is wired in; Voice
 * offers speech from words, or the recording tools when a recording is wired in.
 */
export function toolsFor(node: CanvasNode, input: PortType | null): StudioCapability[] {
  switch (node.kind) {
    case "image":
      return ["t2i"];
    case "video":
      return ["t2v"];
    case "animate":
      return ["i2v"];
    case "effects": {
      const effect = node.effectId ? EFFECTS.find((e) => e.id === node.effectId) : undefined;
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
export function startCapability(node: CanvasNode, input: PortType | null): StudioCapability | null {
  return toolsFor(node, input)[0] ?? null;
}

/** The form's starting values: the node's tool, its words (or the wired prompt's), and the wired file. Fills only: no price, no spend. */
export function nodePrefill(
  node: CanvasNode,
  input: { type: PortType | null; assetId: string | null; text?: string | null } | null,
  models: readonly StudioModel[],
): StudioPrefill | null {
  const sourceId = input?.assetId ?? null;
  const words = node.draft || input?.text || "";
  if (node.kind === "effects" && node.effectId) {
    const effect = EFFECTS.find((e) => e.id === node.effectId);
    const pick = effect ? resolveEffect(effect, models) : null;
    if (effect && pick?.state === "ready") return effectPrefill(effect, pick.modelId, "", sourceId);
  }
  const cap = startCapability(node, input?.type ?? null);
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
export function Inspector({
  node,
  state,
  jobs,
  status,
  closed,
  data,
  previews,
  nodeName,
  retrySignal,
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
  retrySignal: number;
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

  // The node's Retry chip: a fresh form from that job.
  const retryFrom = useRef(retrySignal);
  useEffect(() => {
    if (retrySignal === retryFrom.current) return;
    retryFrom.current = retrySignal;
    if (job) setSeed((s) => ({ nonce: s.nonce + 1, prefill: prefillFromJob(job) }));
  }, [retrySignal, job]);

  // The wired file arrived or changed while the form is open: hand it in without clearing the words typed.
  const sourceId = input?.assetId ?? null;
  useEffect(() => {
    if (!sourceId || sourceId === firstSource.current) return;
    firstSource.current = sourceId;
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id: sourceId }));
  }, [sourceId]);

  const only = toolsFor(node, input?.type ?? null);
  const prefill = useMemo(
    () => seed.prefill ?? nodePrefill(node, input ? { type: input.type, assetId: input.assetId, text: input.text } : null, data.models),
    // The form mounts once per seed: later typing lives in the form (and in node.draft through onDraft).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed, node.id, node.effectId, input?.type],
  );

  const accepts = spec.accepts.map((k) => c.ports[k]).join(" / ");
  const candidates = wireCandidates(state, node);
  const effect = node.kind === "effects" && node.effectId ? EFFECTS.find((e) => e.id === node.effectId) ?? null : null;
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
              <EffectList models={data.models} onPick={onEffect} />
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
          ) : node.kind === "effects" && !effect ? null : (
            <GeneratePanel
              key={`${node.id}:${node.effectId ?? ""}:${input?.type ?? ""}:${seed.nonce}`}
              orgId={data.orgId}
              models={data.models}
              initial={prefill}
              defaultStyleKitId={data.defaultStyleKitId}
              dna={seed.nonce > 0 ? null : data.dna}
              sourceRequest={sourceRequest}
              plans={data.plans}
              desk={spec.desk}
              only={only}
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

function EffectList({ models, onPick }: { models: readonly StudioModel[]; onPick: (id: string) => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const list = EFFECTS.map((e) => ({ e, pick: resolveEffect(e, models) }));
  if (!list.some((x) => x.pick.state === "ready")) return <p className="cv-note">{c.inspector.effectNone}</p>;
  return (
    <ul className="cv-effects">
      {list.map(({ e, pick }) => (
        <li key={e.id}>
          <button type="button" className="cv-effect" disabled={pick.state !== "ready"} onClick={() => onPick(e.id)} data-testid={`effect-${e.id}`}>
            <span className="cv-effect-sw" aria-hidden style={{ background: `linear-gradient(135deg, ${e.hues[0]}, ${e.hues[1]})` }} />
            <span className="flex min-w-0 flex-col text-left">
              <span className="font-semibold">{t.effects.items[e.id].name}</span>
              <span className="cv-note">{pick.state === "ready" ? c.inspector.effectReady : c.node.notAvailable}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
