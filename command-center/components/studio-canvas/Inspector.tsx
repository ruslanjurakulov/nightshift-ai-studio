"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, Unplug, X } from "lucide-react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { StatusLamp } from "@/components/ui/StatusLamp";
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
import { EFFECTS, effectPrefill, resolveEffect } from "@/lib/effects/catalog";
import { KIND_SPEC, type CanvasNode, type CanvasState, type PortType } from "@/lib/studio/canvas";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import type { LibraryPreview } from "@/components/studio/useLibraryImages";
import { inputOf, wireCandidates, type JobReading, type NodeStatus } from "./nodeState";

export interface PanelData {
  orgId: string | null;
  models: StudioModel[];
  unavailable: readonly string[];
  plans: UpsellCatalog | null;
  dna: (StudioDna & { href: string }) | null;
  defaultStyleKitId: string | null;
}

/** The tool a node's form starts on, given what is wired into it: Edit takes a picture or a clip, Voice words or a recording. */
export function startCapability(node: CanvasNode, input: PortType | null): StudioCapability | null {
  if (node.kind === "enhance") return input === "video" ? "video_upscale" : "upscale";
  if (node.kind === "voice") return input === "audio" || input === "video" ? "voice_change" : "tts";
  return KIND_SPEC[node.kind].capability;
}

/** The form's starting values: the node's tool, its words, and the wired file when the tool takes one. Fills only: no price, no spend. */
export function nodePrefill(node: CanvasNode, input: { type: PortType | null; assetId: string | null } | null, models: readonly StudioModel[]): StudioPrefill | null {
  const sourceId = input?.assetId ?? null;
  if (node.kind === "effects" && node.effectId) {
    const effect = EFFECTS.find((e) => e.id === node.effectId);
    const pick = effect ? resolveEffect(effect, models) : null;
    if (effect && pick?.state === "ready") return effectPrefill(effect, pick.modelId, "", sourceId);
  }
  const cap = startCapability(node, input?.type ?? null);
  if (!cap) return null;
  const takesFile = needsSource(cap) || needsRecording(cap) || needsVideo(cap);
  const base = prefillFromQuery(cap, takesFile && sourceId ? sourceId : undefined);
  return base ? { ...base, prompt: node.draft } : null;
}

/**
 * The selected node's inspector: its inputs (wired from the canvas, or picked here — the phone's way to wire),
 * the existing composer for its tool, and its last result. The composer IS today's GeneratePanel: the same
 * models, the same backend quote, the same hold and the same errors ("Need N more" and its top-ups included).
 * Nothing here prices or spends on its own.
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
  onClose: () => void;
  onDraft: (words: string) => void;
  onCreated: (jobId: string) => void;
  onWire: (fromId: string) => void;
  onDisconnect: () => void;
  onEffect: (effectId: string | null) => void;
  /** Drawn as the phone's bottom sheet. */
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

  // A new node, or a new effect, starts its form again from the node.
  useEffect(() => {
    setSeed({ nonce: 0, prefill: null });
    setSourceRequest(null);
    firstSource.current = input?.assetId ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.effectId]);

  // The wired file arrived or changed while the form is open: hand it in without clearing the words typed.
  const sourceId = input?.assetId ?? null;
  useEffect(() => {
    if (!sourceId || sourceId === firstSource.current) return;
    firstSource.current = sourceId;
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id: sourceId }));
  }, [sourceId]);

  const prefill = useMemo(
    () => seed.prefill ?? nodePrefill(node, input ? { type: input.type, assetId: input.assetId } : null, data.models),
    // The form mounts once per seed: later typing lives in the form (and in node.draft through onDraft).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seed, node.id, node.effectId],
  );

  const accepts = spec.accepts.map((k) => c.ports[k]).join(" / ");
  const candidates = wireCandidates(state, node);
  const effect = node.kind === "effects" && node.effectId ? EFFECTS.find((e) => e.id === node.effectId) ?? null : null;
  const dock = { "--studio-dock-offset": "0px" } as CSSProperties;
  const href = job ? resultHref(job) : null;
  const preview = job?.result_asset_ids[0] ? previews.get(job.result_asset_ids[0]) : undefined;

  return (
    <aside className={sheet ? "sc-inspector is-sheet" : "sc-inspector"} aria-label={c.inspector.label} data-testid="canvas-inspector" style={dock}>
      <header className="sc-inspector-head">
        <div className="min-w-0">
          <p className="sc-eyebrow">{c.inspector.label}</p>
          <h2 className="sc-inspector-title">{nodeName(node)}</h2>
        </div>
        <button type="button" className="sc-icon-btn" onClick={onClose} aria-label={c.inspector.close} title={c.inspector.close}>
          <X aria-hidden className="size-4" />
        </button>
      </header>

      {spec.accepts.length > 0 && (
        <section className="sc-inspector-block" aria-label={c.inspector.inputs}>
          <h3 className="sc-block-title">{c.inspector.inputs}</h3>
          {input ? (
            <div className="sc-input-row">
              <span className="sc-chip">{fmt(c.node.from, { name: nodeName(input.from) })}</span>
              <button type="button" className="sc-text-btn" onClick={onDisconnect}>
                <Unplug aria-hidden className="size-3.5" /> {c.inspector.disconnect}
              </button>
            </div>
          ) : (
            <p className={spec.required ? "sc-note is-warn" : "sc-note"} data-testid="inspector-needs">
              {spec.required ? fmt(c.node.needsInput, { kinds: accepts }) : c.inspector.inputNone}
            </p>
          )}
          {input && !input.assetId && <p className="sc-note">{c.inspector.waitingInput}</p>}
          <label className="sc-field">
            <span className="sc-field-label">{c.inspector.pick}</span>
            {candidates.length > 0 ? (
              <select
                className="sc-select"
                value={input?.from.id ?? ""}
                onChange={(e) => (e.target.value ? onWire(e.target.value) : onDisconnect())}
                data-testid="inspector-wire"
              >
                <option value="">—</option>
                {candidates.map((n) => (
                  <option key={n.id} value={n.id}>
                    {nodeName(n)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="sc-note">{fmt(c.inspector.pickNone, { kinds: accepts })}</span>
            )}
          </label>
        </section>
      )}

      {node.kind === "effects" && !closed && (
        <section className="sc-inspector-block">
          <h3 className="sc-block-title">{effect ? t.effects.items[effect.id].name : c.inspector.effectPick}</h3>
          {effect ? (
            <button type="button" className="sc-text-btn" onClick={() => onEffect(null)}>
              {c.inspector.effectChange}
            </button>
          ) : (
            <EffectList models={data.models} onPick={onEffect} />
          )}
        </section>
      )}

      {job && (
        <section className="sc-inspector-block" data-testid="inspector-result">
          <h3 className="sc-block-title">{c.inspector.resultTitle}</h3>
          <div className="sc-input-row">
            <StatusLamp tone={statusView(t, job.status).tone} label={statusView(t, job.status).label} live={statusView(t, job.status).live} />
            {href && (
              <a href={href} target="_blank" rel="noreferrer" className="sc-text-btn">
                <ExternalLink aria-hidden className="size-3.5" /> {c.inspector.openResult}
              </a>
            )}
          </div>
          {preview?.thumbUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.thumbUrl} alt="" className="sc-inspector-thumb" />
          )}
          {status === "failed" && (
            <>
              <p className="sc-note is-fail" data-testid="inspector-failure">
                {failureReason(t, job)}
              </p>
              <button
                type="button"
                className="btn-quiet min-h-11 px-4 text-sm"
                onClick={() => setSeed((s) => ({ nonce: s.nonce + 1, prefill: prefillFromJob(job) }))}
                data-testid="inspector-retry"
              >
                {c.node.retry}
              </button>
              <p className="sc-note">{c.inspector.retryHint}</p>
            </>
          )}
        </section>
      )}

      {reading?.state === "unknown" && <p className="sc-note is-warn">{c.node.unknown}</p>}

      <section className="sc-inspector-form">
        {!data.orgId ? (
          <p className="sc-note">{c.inspector.noOrg}</p>
        ) : closed ? (
          // Nothing on sale for this tool: said in words, and no form that would only end in "no model".
          <p className="sc-note is-warn" data-testid="inspector-unavailable">
            <strong>{c.node.notAvailable}.</strong> {c.inspector.unavailable}
          </p>
        ) : node.kind === "effects" && !effect ? null : prefill || node.kind !== "asset" ? (
          <GeneratePanel
            key={`${node.id}:${node.effectId ?? ""}:${seed.nonce}`}
            orgId={data.orgId}
            models={data.models}
            initial={prefill}
            defaultStyleKitId={data.defaultStyleKitId}
            dna={seed.nonce > 0 ? null : data.dna}
            sourceRequest={sourceRequest}
            plans={data.plans}
            desk={spec.desk}
            unavailable={data.unavailable}
            onDraftChange={onDraft}
            onCreated={(created) => {
              if (created) onCreated(created.id);
            }}
          />
        ) : null}
      </section>
    </aside>
  );
}

function EffectList({ models, onPick }: { models: readonly StudioModel[]; onPick: (id: string) => void }) {
  const { t } = useI18n();
  const c = t.studioCanvas;
  const list = EFFECTS.map((e) => ({ e, pick: resolveEffect(e, models) }));
  if (!list.some((x) => x.pick.state === "ready")) return <p className="sc-note">{c.inspector.effectNone}</p>;
  return (
    <ul className="sc-effects">
      {list.map(({ e, pick }) => (
        <li key={e.id}>
          <button type="button" className="sc-effect" disabled={pick.state !== "ready"} onClick={() => onPick(e.id)} data-testid={`effect-${e.id}`}>
            <span className="sc-effect-swatch" aria-hidden style={{ background: `linear-gradient(135deg, ${e.hues[0]}, ${e.hues[1]})` }} />
            <span className="flex min-w-0 flex-col text-left">
              <span className="font-semibold">{t.effects.items[e.id].name}</span>
              <span className="sc-note">{pick.state === "ready" ? c.inspector.effectReady : c.node.notAvailable}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
