"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { apiErrorMessage } from "@/lib/creative/studio";
import { formatCredits } from "@/lib/credits";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { BeforeAfter } from "@/components/studio/BeforeAfter";
import { RegionCanvas } from "@/components/regionEdit/RegionCanvas";
import { RegionFields } from "@/components/regionEdit/RegionFields";
import { VersionPanel, type VersionsState } from "@/components/regionEdit/VersionPanel";
import { useRegionQuote } from "@/components/regionEdit/useRegionQuote";
import {
  DEFAULT_FEATHER,
  FEATHER_MAX,
  FEATHER_MIN,
  MAX_REGIONS,
  MIN_REGION_PX,
  addRegion,
  clampRect,
  defaultRect,
  moveRect,
  nextRegionNumber,
  removeRegion,
  resizeBy,
  runnableRegions,
  updateRegion,
  type EditorRegion,
  type Rect,
  type Size,
} from "@/lib/regionEdit/geometry";
import { REGION_ERRORS } from "@/lib/regionEdit/request";
import { buildChain } from "@/lib/regionEdit/versions";

export interface EditModelOption {
  id: string;
  displayName: string;
}

type Picture =
  | { status: "none" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "nosize" }
  | { status: "ready"; id: string; url: string; size: Size };

async function readPicture(id: string): Promise<Exclude<Picture, { status: "none" } | { status: "loading" }>> {
  try {
    const res = await fetch(`/api/media/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return { status: "failed" };
    const body = (await res.json()) as {
      asset?: { width?: number | null; height?: number | null; kind?: string };
      urls?: Record<string, string>;
      served?: boolean;
    };
    const url = body.urls?.display ?? body.urls?.original;
    if (!body.served || !url || body.asset?.kind !== "image") return { status: "failed" };
    const w = body.asset.width;
    const h = body.asset.height;
    if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) return { status: "nosize" };
    return { status: "ready", id, url, size: { width: w, height: h } };
  } catch {
    return { status: "failed" };
  }
}

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(16).slice(2)}`);

/**
 * The region editor (NIGHTSHIFT_REGION_EDITOR, default off): pick a library picture, draw 1 to 5 rectangular
 * regions, give each a name and its own words, see the price before anything runs, and move through the picture's
 * versions. Running the edits is NOT connected in this version (see docs/REGION_EDITOR.md): the button says so and
 * nothing is held or charged. The changed parts of a result are AI-generated and the screen says that.
 */
export function RegionEditor({ orgId, models, libraryHref }: { orgId: string; models: EditModelOption[]; libraryHref: string }) {
  const { t, fmt, locale } = useI18n();
  const r = t.regionEdit;
  const keysId = useId();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [picture, setPicture] = useState<Picture>({ status: "none" });
  const [regions, setRegions] = useState<EditorRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [feather, setFeather] = useState(DEFAULT_FEATHER);
  // One model is preselected only when it is the only choice; with several the person picks (no hidden default).
  const [model, setModel] = useState(models.length === 1 ? models[0].id : "");
  const [live, setLive] = useState("");
  const [versions, setVersions] = useState<VersionsState>({ status: "idle" });
  const [original, setOriginal] = useState<{ id: string; url: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const size = picture.status === "ready" ? picture.size : null;

  // Load the picture (and read its versions) when another one is chosen.
  useEffect(() => {
    if (!sourceId) {
      setPicture({ status: "none" });
      setVersions({ status: "idle" });
      return;
    }
    let dead = false;
    setPicture({ status: "loading" });
    setVersions({ status: "loading" });
    setOriginal(null);
    void readPicture(sourceId).then((p) => !dead && setPicture(p));
    void (async () => {
      try {
        const res = await fetch(`/api/region-edit/versions?asset=${encodeURIComponent(sourceId)}`, { cache: "no-store" });
        if (dead) return;
        if (res.status === 503) return setVersions({ status: "unavailable" });
        if (!res.ok) return setVersions({ status: "failed" });
        const body = (await res.json()) as { chain?: ReturnType<typeof buildChain> };
        if (dead) return;
        if (!body.chain) return setVersions({ status: "failed" });
        setVersions({ status: "ready", chain: body.chain });
        const root = body.chain.items[0];
        if (body.chain.at > 0 && root) {
          const o = await readPicture(root.id);
          if (!dead && o.status === "ready") setOriginal({ id: root.id, url: o.url });
        }
      } catch {
        if (!dead) setVersions({ status: "failed" });
      }
    })();
    return () => {
      dead = true;
    };
  }, [sourceId, reloadKey]);

  // The regions belong to one picture's pixels: another picture starts with none.
  useEffect(() => {
    setRegions([]);
    setSelectedId(null);
    setDrawing(false);
  }, [sourceId]);

  const quote = useRegionQuote({ orgId, sourceId: size ? sourceId : null, model, feather, regions });
  const selected = regions.find((x) => x.id === selectedId) ?? null;
  const atLimit = regions.length >= MAX_REGIONS;

  const announce = (text: string) => setLive(text);

  // Plain function over the current state (not an updater): an updater must be pure, and this announces and selects.
  const add = (rect?: Rect) => {
    if (!size) return;
    const name = fmt(r.defaultName, { n: nextRegionNumber(regions) });
    const res = addRegion(regions, rect ?? defaultRect({ x: size.width / 2, y: size.height / 2 }, size), { id: newId(), name }, size);
    setDrawing(false);
    if (!res.ok) return;
    setRegions(res.regions);
    setSelectedId(res.added.id);
    announce(fmt(r.announceAdded, { name }));
  };

  const patch = (id: string, change: Partial<Omit<EditorRegion, "id">>) => {
    if (size) setRegions((list) => updateRegion(list, id, change, size));
  };

  const onKey = (a: Parameters<React.ComponentProps<typeof RegionCanvas>["onKey"]>[0]) => {
    if (!size) return;
    if (a.type === "cycle") {
      if (regions.length === 0) return;
      const i = regions.findIndex((x) => x.id === selectedId);
      const next = regions[(i + a.dir + regions.length) % regions.length];
      setSelectedId(next.id);
      announce(fmt(r.announceSelected, { name: next.name }));
      return;
    }
    if (!selected) return;
    if (a.type === "remove") {
      announce(fmt(r.announceRemoved, { name: selected.name }));
      setRegions((list) => removeRegion(list, selected.id));
      setSelectedId(null);
      return;
    }
    const next = a.type === "move" ? moveRect(selected, a.dx, a.dy, size) : resizeBy(selected, a.dx, a.dy, size);
    patch(selected.id, next);
    announce(fmt(r.announceMoved, { name: selected.name, x: next.x, y: next.y, w: next.w, h: next.h }));
  };

  const quoteView = useMemo(() => {
    if (quote.status === "ready") {
      const q = quote.quote;
      return (
        <div className="flex flex-col gap-1" role="status">
          <p className="text-base font-semibold">{fmt(r.quoteTotal, { credits: formatCredits(q.total, locale) })}</p>
          <ul className="text-sm text-[var(--color-muted)]">
            {q.lines.map((l) => (
              <li key={l.index}>{fmt(r.quoteLine, { name: l.name, credits: formatCredits(l.credits, locale) })}</li>
            ))}
          </ul>
          {q.skipped.length > 0 ? <p className="text-xs text-[var(--color-muted)]">{fmt(r.quoteSkipped, { n: q.skipped.length })}</p> : null}
        </div>
      );
    }
    if (quote.status === "quoting") return <p className="text-sm text-[var(--color-muted)]" role="status">{r.quoting}</p>;
    if (quote.status === "error") {
      const own = (REGION_ERRORS as readonly string[]).includes(quote.code);
      const text = own
        ? fmt((r.errors as Record<string, string>)[quote.code] ?? r.errors.failed, { max: MAX_REGIONS, min: MIN_REGION_PX })
        : apiErrorMessage(t, quote.code);
      const where = quote.region !== null ? ` (${regions[quote.region]?.name ?? quote.region + 1})` : "";
      return <p className="text-sm text-[var(--color-fail)]" role="alert">{`${text}${where}`}</p>;
    }
    return <p className="text-sm text-[var(--color-muted)]">{r.quoteIdle}</p>;
  }, [quote, fmt, locale, r, t, regions]);

  return (
    <div className="flex flex-col gap-6">
      <p className="g3-note">{r.previewNote}</p>

      <section aria-labelledby="re-pick" className="flex flex-col gap-2">
        <h2 id="re-pick" className="t-panel">{r.pickTitle}</h2>
        <p className="text-sm text-[var(--color-muted)]">{r.pickHint}</p>
        <SourcePicker orgId={orgId} value={sourceId} onChange={setSourceId} libraryHref={libraryHref} />
      </section>

      {picture.status === "loading" ? <p className="text-sm text-[var(--color-muted)]" role="status">{r.imageLoading}</p> : null}
      {picture.status === "failed" || picture.status === "nosize" ? (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-sm text-[var(--color-fail)]">{picture.status === "nosize" ? r.imageNoSize : r.imageFailed}</p>
          {picture.status === "failed" ? (
            <button type="button" className="btn-quiet" onClick={() => setReloadKey((n) => n + 1)}>{r.retry}</button>
          ) : null}
        </div>
      ) : null}

      {picture.status === "ready" ? (
        <>
          <section aria-labelledby="re-regions" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="re-regions" className="t-panel">{r.regionsTitle}</h2>
              <p className="text-sm text-[var(--color-muted)]" aria-live="polite">{fmt(r.count, { n: regions.length, max: MAX_REGIONS })}</p>
            </div>
            <RegionCanvas
              key={picture.id}
              imageUrl={picture.url}
              imageSize={picture.size}
              regions={regions}
              selectedId={selectedId}
              drawing={drawing}
              disabled={false}
              label={fmt(r.canvasLabel, { n: regions.length, max: MAX_REGIONS })}
              keysId={keysId}
              onSelect={(id) => {
                setSelectedId(id);
                const hit = regions.find((x) => x.id === id);
                if (hit) announce(fmt(r.announceSelected, { name: hit.name }));
              }}
              onChange={(id, rect) => patch(id, rect)}
              onDraw={(rect) => (atLimit ? setDrawing(false) : add(rect))}
              onKey={onKey}
              onImageError={() => setPicture({ status: "failed" })}
            />
            <p id={keysId} className="text-xs text-[var(--color-muted)]">{r.canvasKeys}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={atLimit} onClick={() => add()}>
                {r.add}
              </button>
              <button type="button" className="btn-quiet" disabled={atLimit} aria-pressed={drawing} onClick={() => setDrawing((d) => !d)}>
                {drawing ? r.drawOff : r.drawOn}
              </button>
            </div>
            {drawing ? <p className="text-xs text-[var(--color-muted)]">{r.drawHint}</p> : null}
            {atLimit ? <p className="text-xs text-[var(--color-muted)]">{fmt(r.limit, { max: MAX_REGIONS })}</p> : null}
            <p className="sr-only" role="status" aria-live="polite">{live}</p>
            {regions.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">{r.noRegions}</p>
            ) : (
              <ul className="flex flex-col gap-3" aria-label={r.regionsTitle}>
                {regions.map((region) => (
                  <RegionFields
                    key={region.id}
                    region={region}
                    selected={region.id === selectedId}
                    imageSize={picture.size}
                    disabled={false}
                    onSelect={() => setSelectedId(region.id)}
                    onName={(v) => patch(region.id, { name: v })}
                    onPrompt={(v) => patch(region.id, { prompt: v })}
                    onRect={(p) => patch(region.id, clampRect({ ...region, ...p }, picture.size))}
                    onRemove={() => {
                      announce(fmt(r.announceRemoved, { name: region.name }));
                      setRegions((list) => removeRegion(list, region.id));
                      if (selectedId === region.id) setSelectedId(null);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="re-edge" className="flex flex-col gap-2">
            <label id="re-edge" htmlFor="re-feather" className="studio-label">{r.feather}</label>
            <input
              id="re-feather"
              type="range"
              min={FEATHER_MIN}
              max={FEATHER_MAX}
              step={1}
              value={feather}
              onChange={(e) => setFeather(Number(e.target.value))}
              aria-valuetext={`${feather} px`}
              className="h-11 w-full"
            />
            <p className="text-xs text-[var(--color-muted)]">{fmt(r.featherHint, { n: feather, min: FEATHER_MIN, max: FEATHER_MAX })}</p>
          </section>
        </>
      ) : null}

      <section aria-labelledby="re-model" className="flex flex-col gap-2">
        <h2 id="re-model" className="t-panel">{r.modelTitle}</h2>
        {models.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{r.modelNone}</p>
        ) : (
          <>
            <label htmlFor="re-model-select" className="studio-label">{r.modelLabel}</label>
            <div className="studio-field">
              <select
                id="re-model-select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="min-h-11 w-full bg-transparent px-3 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
              >
                {models.length > 1 ? <option value="">{r.errors.model_required}</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-[var(--color-muted)]">{r.modelNote}</p>
          </>
        )}
      </section>

      <section aria-labelledby="re-price" className="flex flex-col gap-2">
        <h2 id="re-price" className="t-panel">{r.quoteTitle}</h2>
        <p className="text-xs text-[var(--color-muted)]">{r.quoteUnit}</p>
        {runnableRegions(regions).length === 0 || !model ? (
          <p className="text-sm text-[var(--color-muted)]">{!model && models.length > 0 ? r.errors.model_required : r.quoteIdle}</p>
        ) : (
          quoteView
        )}
        <button type="button" className="btn-primary w-fit" disabled aria-disabled="true" aria-describedby="re-run-why">
          {r.run}
        </button>
        <p id="re-run-why" className="text-xs text-[var(--color-muted)]">{r.runWhy}</p>
      </section>

      <section aria-labelledby="re-lock" className="flex flex-col gap-2">
        <h2 id="re-lock" className="t-panel">{r.lockTitle}</h2>
        <p className="text-sm">{fmt(r.lockBody, { n: feather })}</p>
        <p className="text-sm text-[var(--color-muted)]">{r.aiLabel}</p>
      </section>

      <section aria-labelledby="re-versions" className="flex flex-col gap-3">
        <h2 id="re-versions" className="t-panel">{r.versionsTitle}</h2>
        <VersionPanel state={versions} current={sourceId} onOpen={setSourceId} />
        {versions.status === "ready" && versions.chain.at > 0 && original && picture.status === "ready" ? (
          <div className="flex flex-col gap-2">
            <h3 className="studio-label">{r.compareTitle}</h3>
            <BeforeAfter before={original.url} after={picture.url} alt={r.compareOriginal} />
          </div>
        ) : versions.status === "ready" && versions.chain.at === 0 && versions.chain.items.length > 1 ? (
          <p className="text-sm text-[var(--color-muted)]">{r.compareNeed}</p>
        ) : null}
      </section>
    </div>
  );
}
