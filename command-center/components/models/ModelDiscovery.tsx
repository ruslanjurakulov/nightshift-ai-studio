"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowRight, Search, SlidersHorizontal, TriangleAlert, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { nextFocusIndex } from "@/lib/feedback";
import { Chip, ChipRow } from "@/components/ui/Chip";
import { ContactSheet, Frame } from "@/components/ui/ContactSheet";
import { Panel } from "@/components/ui/Panel";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Timecode, formatTimecode } from "@/components/ui/Timecode";
import { TierMarks } from "@/components/studio/TierMarks";
import {
  DISCOVERY_STATES,
  INPUT_KINDS,
  NO_FILTERS,
  OUTPUT_KINDS,
  TASKS,
  frameAspect,
  longestDuration,
  matchesFilters,
  promptLimit,
  providerName,
  shapesOf,
  showsProvider,
  widestShape,
  queryFor,
  soundChoice,
  rateText,
  dayOf,
  sortModels,
  sourceRule,
  taskCounts,
  tasksOf,
  linksFor,
  type DiscoveryModel,
  type DiscoveryState,
  type Filters,
  type OutputKind,
  type PriceView,
  type Reason,
  type RegistryCapability,
  type TaskId,
  type UseLink,
} from "@/lib/models-discovery";
import styles from "./ModelDiscovery.module.css";

const LAMP: Record<DiscoveryState, LampTone> = { available: "ok", plan_gated: "info", needs_probe: "warn", unavailable: "off" };
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const TEXT_CAPS: readonly RegistryCapability[] = ["t2i", "edit", "t2v", "i2v", "tts", "sfx"];

type Copy = ReturnType<typeof useI18n>["t"]["modelDiscovery"];

/**
 * The Models catalog: every model this person may use (a customer: what
 * sellable_models() returns; the operator: the whole registry), by task, with
 * search and filters, each model a frame on a proof sheet printed with its own
 * facts, and one lifted pane that reads the picked model in full — what it
 * takes and makes, the settings the registry declares, its rate from the live
 * price list, its availability and why, and "Use in Studio".
 *
 * Read only. "Use in Studio" opens /create with the tool and the model chosen:
 * it fills the form, and nothing is priced or spent until Generate is pressed.
 */
export function ModelDiscovery({
  models,
  operator,
  pricesRead,
  probesRead,
  initialFilters = NO_FILTERS,
  initialModel = null,
}: {
  models: DiscoveryModel[];
  operator: boolean;
  pricesRead: boolean;
  probesRead: boolean;
  initialFilters?: Filters;
  initialModel?: string | null;
}) {
  const { t, fmt } = useI18n();
  const c = t.modelDiscovery;
  const searchId = useId();
  const resultsId = useId();
  const filtersId = useId();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [picked, setPicked] = useState<string | null>(models.some((m) => m.id === initialModel) ? initialModel : null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // Who makes a model is the operator's business; a customer sees the display name, as in the Studio.
  const withProvider = showsProvider(operator);

  // The words a person might search in, in their language: task names and what the model makes.
  const words = useCallback(
    (m: DiscoveryModel): string[] => [...tasksOf(m.capabilities).map((id) => c.tasks[id]), m.spec.output ? c.outputs[m.spec.output] : ""],
    [c],
  );
  const shown = useMemo(
    () => sortModels(models.filter((m) => matchesFilters(m, filters, words(m), withProvider))),
    [models, filters, words, withProvider],
  );
  const counts = useMemo(() => taskCounts(models, filters, words, withProvider), [models, filters, words, withProvider]);
  const allCount = useMemo(
    () => models.filter((m) => matchesFilters(m, { ...filters, task: "all" }, words(m), withProvider)).length,
    [models, filters, words, withProvider],
  );
  // A customer is not shown keys for tasks nothing in their catalog does (the picked one always stays).
  const offered = useMemo(() => taskCounts(models, NO_FILTERS), [models]);
  const tasks = TASKS.filter((task) => operator || offered[task.id] > 0 || filters.task === task.id);
  const current = models.find((m) => m.id === picked) ?? null;
  const activeFilters = (["input", "output", "state"] as const).filter((k) => filters[k] !== "all").length;
  const filtered = filters.q.trim() !== "" || activeFilters > 0;

  // The URL carries the filters and the picked model, so a view can be shared
  // or reloaded. replaceState: no server round trip, no history entry per key.
  useEffect(() => {
    try {
      const url = window.location.pathname + queryFor(filters, picked);
      if (url !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, "", url);
    } catch {
      // A sandboxed frame may refuse; the page works the same without it.
    }
  }, [filters, picked]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  // A link can open the page on a task far along the row: bring its key into view once.
  useEffect(() => {
    const on = chipsRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    const row = on?.parentElement;
    if (on && row && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, on.offsetLeft - row.offsetLeft - 16);
  }, []);

  // The task keys are one tab stop: ←/→ (Home/End) move along them and choose, as in a radio group.
  function onChipKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const keys = Array.from(chipsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (at + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (at - 1 + keys.length) % keys.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = keys.length - 1;
    if (to < 0) return;
    e.preventDefault();
    keys[to].focus();
    keys[to].click();
  }

  function pick(id: string, from: HTMLElement) {
    setPicked(id);
    // From lg up the pane beside the sheet shows it; below, a sheet opens over the page.
    const wide = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches;
    if (!wide) {
      opener.current = from;
      setSheetOpen(true);
    }
  }

  const groups = useMemo(() => {
    const order: (OutputKind | null)[] = [...OUTPUT_KINDS, null];
    return order
      .map((kind) => ({ kind, items: shown.filter((m) => m.spec.output === kind) }))
      .filter((g) => g.items.length > 0);
  }, [shown]);

  const stateOptions = DISCOVERY_STATES.filter((s) => operator || models.some((m) => m.state === s));
  const taskHint = filters.task === "all" ? null : c.taskHints[filters.task];
  const emptyTask = filters.task !== "all" && offered[filters.task] === 0 && !filtered;
  let frameNo = 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <a href={`#${resultsId}`} className={styles.skip}>
        {c.skipToModels}
      </a>
      <div className={styles.controls}>
        <div className={styles.filter}>
          <label htmlFor={searchId} className={styles.filterLabel}>
            {c.searchLabel}
          </label>
          <div className={styles.searchWrap}>
            <Search aria-hidden className={`${styles.searchIcon} size-4`} />
            <input
              id={searchId}
              type="search"
              value={filters.q}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              placeholder={withProvider ? c.searchPlaceholderOperator : c.searchPlaceholder}
              onChange={(e) => set("q", e.target.value)}
              className={`${styles.field} ${styles.search}`}
            />
            {filters.q && (
              <button type="button" className={styles.clearSearch} onClick={() => set("q", "")} aria-label={c.clearSearch}>
                <X aria-hidden className="size-4" />
              </button>
            )}
          </div>
        </div>

        {/* On a phone the filters fold behind one key, so the models start on the first screen. */}
        <button
          type="button"
          className={styles.filtersToggle}
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          onClick={() => setFiltersOpen((o) => !o)}
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          {c.filtersLabel}
          {activeFilters > 0 && <span className="ns-tc text-[var(--ns-amber-ink)]">{activeFilters}</span>}
        </button>
        <fieldset id={filtersId} className={styles.filters} data-open={filtersOpen ? "true" : "false"}>
          <legend className="sr-only">{c.filtersLabel}</legend>
          <FilterSelect label={c.inputLabel} value={filters.input} onChange={(v) => set("input", v as Filters["input"])} options={INPUT_KINDS.map((k) => ({ value: k, label: c.inputs[k] }))} any={c.any} />
          <FilterSelect label={c.outputLabel} value={filters.output} onChange={(v) => set("output", v as Filters["output"])} options={OUTPUT_KINDS.map((k) => ({ value: k, label: c.outputs[k] }))} any={c.any} />
          <FilterSelect label={c.stateLabel} value={filters.state} onChange={(v) => set("state", v as Filters["state"])} options={stateOptions.map((s) => ({ value: s, label: c.states[s] }))} any={c.any} />
        </fieldset>
      </div>

      <div ref={chipsRef} className="min-w-0" onKeyDown={onChipKey}>
        <ChipRow label={c.tasksLabel} wrap>
          <Chip pressed={filters.task === "all"} tabIndex={filters.task === "all" ? 0 : -1} onClick={() => set("task", "all")} count={allCount}>
            {c.allTasks}
          </Chip>
          {tasks.map((task) => (
            <Chip
              key={task.id}
              pressed={filters.task === task.id}
              tabIndex={filters.task === task.id ? 0 : -1}
              count={counts[task.id]}
              onClick={() => set("task", task.id)}
            >
              {c.tasks[task.id]}
            </Chip>
          ))}
        </ChipRow>
      </div>

      <div className={styles.summary}>
        <p aria-live="polite">
          <span className="ns-tc">{fmt(c.resultCount, { n: shown.length, total: models.length })}</span>
          {taskHint && <span> · {taskHint}</span>}
        </p>
        {/* A customer still has each base rate (sellable_models() joins it); the operator's view has none. */}
        {!pricesRead && <p className="text-[var(--color-warn)]">{operator ? c.pricesUnread : c.pricesPartial}</p>}
        {operator && !probesRead && <p className="text-[var(--color-warn)]">{c.probesUnread}</p>}
      </div>

      <div className={styles.layout}>
        <div id={resultsId} tabIndex={-1} className={styles.groups}>
          {shown.length === 0 ? (
            <div className={`ns-panel ${styles.empty}`} data-tone="sunken">
              <p>{emptyTask ? (operator ? c.emptyTask : c.emptyTaskCustomer) : c.emptyFiltered}</p>
              <button type="button" className={styles.secondary} onClick={() => setFilters(NO_FILTERS)}>
                {c.clearFilters}
              </button>
            </div>
          ) : (
            groups.map((g) => {
              const name = g.kind ? c.outputs[g.kind] : c.any;
              const pictured = g.kind === "image" || g.kind === "video";
              return (
                <section key={g.kind ?? "other"} aria-label={`${name} · ${g.items.length}`}>
                  <div className={styles.groupHead}>
                    <h2 className={styles.groupTitle}>{name}</h2>
                    <span className={styles.groupCount}>{g.items.length}</span>
                  </div>
                  {/* Film is film in both themes: its print reads on the dark rebate. Pictures and clips
                      keep each model's own shape, so their frames are ragged, as on a real proof sheet. */}
                  <div data-theme-scope="dark">
                    <ContactSheet label={`${c.resultsLabel}: ${name}`} min={pictured ? 232 : 176} ragged={pictured}>
                      {g.items.map((m) => {
                        frameNo += 1;
                        return (
                          <ModelFrame
                            key={m.id}
                            model={m}
                            number={frameNo}
                            selected={m.id === picked}
                            task={filters.task}
                            showProvider={withProvider}
                            onPick={(el) => pick(m.id, el)}
                          />
                        );
                      })}
                    </ContactSheet>
                  </div>
                </section>
              );
            })
          )}
        </div>

        <aside className={`hidden lg:block ${styles.aside}`} aria-label={c.details}>
          <Panel tone="lifted" padded>
            {current ? (
              <ModelDetail model={current} task={filters.task} operator={operator} />
            ) : (
              <p className={styles.pickHint}>{c.pickHint}</p>
            )}
          </Panel>
        </aside>
      </div>

      {sheetOpen && current && (
        <DetailSheet title={current.displayName} onClose={() => setSheetOpen(false)} returnTo={opener}>
          <ModelDetail model={current} task={filters.task} operator={operator} />
        </DetailSheet>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  any,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  any: string;
}) {
  const id = useId();
  return (
    <div className={styles.filter}>
      <label htmlFor={id} className={styles.filterLabel}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${styles.field} ${styles.select}`}>
        <option value="all">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── a frame ──────────────────────────────────────────────────────────────────

function ModelFrame({
  model: m,
  number,
  selected,
  task,
  showProvider,
  onPick,
}: {
  model: DiscoveryModel;
  number: number;
  selected: boolean;
  task: TaskId | "all";
  showProvider: boolean;
  onPick: (el: HTMLElement) => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.modelDiscovery;
  const path = useChannelPath();
  const longest = longestDuration(m.spec);
  const per = m.spec.unit ? c.edgePer[m.spec.unit] : "";
  const ratios = shapesOf(m.spec);
  // Only a model the Studio would take gets a link: one it would refuse (not open, hidden, unproven) gets none.
  const link = usable(m) ? (linksFor(m, task).find((l) => l.kind !== "none") ?? null) : null;
  return (
    <Frame
      number={String(number).padStart(2, "0")}
      selected={selected}
      // The frame's own facts, as film prints them: the shape it is drawn in, its longest clip, its release stage.
      edge={[widestShape(m.spec), longest !== null ? formatTimecode(longest, "duration") : null, c.stages[m.stage].toUpperCase()]}
      caption={
        <span className={styles.caption}>
          <span>{tasksOf(m.capabilities).map((id) => c.tasks[id]).join(" · ")}</span>
          {link && (
            <Link
              href={path(link.href)}
              className={styles.captionLink}
              prefetch={false}
              // Every frame has one: the name says which model, starting with the words on the key.
              aria-label={`${link.kind === "editor" ? c.openEditor : c.useInStudio}: ${m.displayName}`}
            >
              {link.kind === "editor" ? c.openEditor : c.useInStudio}
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </span>
      }
    >
      <button
        type="button"
        className={styles.slate}
        // Drawn in the widest shape the model makes, on the slate (not the frame): a long name grows it rather than being cut.
        style={{ aspectRatio: frameAspect(m) }}
        data-guides={ratios.length > 0 ? "true" : undefined}
        aria-pressed={selected}
        aria-label={fmt(c.open, { model: m.displayName })}
        onClick={(e) => onPick(e.currentTarget)}
      >
        <FramingGuides ratios={ratios} />
        <span className={styles.slateText}>
          {showProvider && <span className={styles.slateProvider}>{providerName(m.provider)}</span>}
          <span className={styles.slateName}>{m.displayName}</span>
        </span>
        <span className={styles.slateFoot}>
          <StatusLamp tone={LAMP[m.state]} label={c.states[m.state]} />
          <span className={styles.slateRate}>
            <RateFigure price={m.price} unit={null} compact per={per} />
          </span>
        </span>
      </button>
    </Frame>
  );
}

/**
 * The shapes a model makes, drawn to scale and nested like the framing guides
 * on a viewfinder, at the height of the slate: real data (the registry's
 * aspect ratios), the first — the one the Studio starts with — printed amber.
 * A model without shapes has none.
 */
function FramingGuides({ ratios }: { ratios: string[] }) {
  if (ratios.length === 0) return null;
  return (
    <svg aria-hidden className={styles.guides} viewBox="-1 -1 102 102" preserveAspectRatio="xMaxYMid meet">
      {ratios
        .map((r, i) => {
          const [w, h] = r.split(":").map(Number);
          const width = w >= h ? 100 : (100 * w) / h;
          const height = w >= h ? (100 * h) / w : 100;
          return { r, i, x: (100 - width) / 2, y: (100 - height) / 2, width, height };
        })
        .reverse()
        .map((g) => (
          <rect
            key={g.r}
            x={g.x}
            y={g.y}
            width={g.width}
            height={g.height}
            className={g.i === 0 ? styles.guideFirst : styles.guide}
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </svg>
  );
}

/** The Studio would take it: available, or behind a gate the organization can pass (a first purchase). */
function usable(m: DiscoveryModel): boolean {
  return m.state === "available" || m.state === "plan_gated";
}

/** The task a link stands for: the filtered task when it covers the capability, else the capability's first task. */
function taskFor(cap: RegistryCapability, task: TaskId | "all"): TaskId {
  if (task !== "all" && TASKS.find((x) => x.id === task)?.caps.some((k) => k === cap)) return task;
  return TASKS.find((x) => x.caps.some((k) => k === cap))?.id ?? "image";
}

/** A rate as a counter, or the words for why there is none (never 0). */
function RateFigure({ price, unit, compact = false, per = "" }: { price: PriceView; unit: string | null; compact?: boolean; per?: string }) {
  const { t } = useI18n();
  const c = t.modelDiscovery;
  if (price.kind === "unread") return <Timecode value={null} unknown={c.priceUnread} />;
  if (price.kind === "no_unit") return <Timecode value={null} unknown={c.noUnit} />;
  const value = price.kind === "flat" ? price.rate : price.from;
  return (
    <>
      {price.kind === "variants" && value !== null && <span className={compact ? styles.from : styles.priceUnit}>{c.from}</span>}
      <Rate value={value} unit={compact ? `${t.design.crShort}${per}` : c.credits} />
      {unit && value !== null && <span className={styles.priceUnit}>{unit}</span>}
    </>
  );
}

/** A rate in the counter face (Timecode's look), or "not priced yet" in words — never 0. */
function Rate({ value, unit }: { value: number | null; unit: string }) {
  const { t, locale } = useI18n();
  if (value === null || !(value > 0)) return <Timecode value={null} unknown={t.modelDiscovery.notPriced} />;
  return (
    <span className="ns-tc" data-format="credits">
      <span>{rateText(value, locale)}</span>
      <span className="ns-tc-unit">{unit}</span>
    </span>
  );
}

// ── the pane ─────────────────────────────────────────────────────────────────

function reasonText(c: Copy, r: Reason, operator: boolean): string {
  switch (r.kind) {
    case "probe_failed":
      return c.reasons.probe_failed.replace("{when}", dayOf(r.at)).replace("{code}", r.code ?? "—");
    case "terms_gate":
      return c.reasons.terms_gate.replace("{gate}", r.gate);
    case "not_open":
      // The Studio's plan dialog says the same to a customer; the operator is told why.
      return operator ? c.reasons.not_open_operator.replace("{key}", r.value ? `${r.key}:${r.value}` : r.key) : c.reasons.not_open;
    case "first_purchase":
      return r.known ? c.reasons.first_purchase : c.reasons.first_purchase_maybe;
    default:
      return c.reasons[r.kind];
  }
}

function ModelDetail({ model: m, task, operator }: { model: DiscoveryModel; task: TaskId | "all"; operator: boolean }) {
  const { t, fmt, locale } = useI18n();
  const c = t.modelDiscovery;
  const path = useChannelPath();
  const s = m.spec;
  const unitWords = s.unit ? c.per[s.unit] : c.perUse;
  const links = linksFor(m, "all");
  const ordered = [...links].sort((a, b) => Number(taskFor(b.cap, task) === task) - Number(taskFor(a.cap, task) === task));
  const gated = m.state === "plan_gated";
  const withProvider = showsProvider(operator);
  const dur = (sec: number) => formatTimecode(sec, "duration");

  // What it is given: words, reference pictures, and the library file each of its tools starts from.
  const takes: ReactNode[] = [];
  if (m.capabilities.some((cap) => TEXT_CAPS.includes(cap))) {
    // The shorter of the model's own limit and the database's 4000 (creative_params_problem).
    takes.push(<li key="words">{fmt(c.inWords, { n: promptLimit(s).toLocaleString(locale) })}</li>);
  }
  const seen = new Set<string>();
  for (const cap of m.capabilities) {
    const rule = sourceRule(cap, s.maxSourceSeconds);
    if (!rule || seen.has(rule.kind)) continue;
    seen.add(rule.kind);
    const label = rule.kind === "picture" ? c.inPicture : rule.kind === "video" ? c.inVideo : c.inRecording;
    const limits = [
      rule.maxSeconds !== null ? fmt(c.upToLength, { length: dur(rule.maxSeconds) }) : null,
      rule.maxMb !== null ? fmt(c.upToSize, { mb: rule.maxMb }) : null,
    ].filter(Boolean);
    takes.push(
      <li key={rule.kind}>
        {label}
        <span className={styles.sub}>
          {rule.formats.join(", ")}
          {limits.length ? ` · ${limits.join(" · ")}` : ""}
        </span>
      </li>,
    );
  }

  // The settings the registry declares; nothing it does not.
  const settings: [string, ReactNode][] = [];
  const vals = (xs: (string | number)[]) => (
    <span className={styles.values}>
      {xs.map((x) => (
        <span key={String(x)} className={styles.value}>
          {x}
        </span>
      ))}
    </span>
  );
  if (s.aspectRatios.length) settings.push([c.setShapes, vals(s.aspectRatios)]);
  for (const [cap, list] of Object.entries(s.aspectRatiosByCapability)) {
    if (list && list.length) settings.push([fmt(c.setShapesFor, { task: c.tasks[taskFor(cap as RegistryCapability, "all")] }), vals(list)]);
  }
  if (s.imageSizes.length) settings.push([c.setSizes, vals(s.imageSizes)]);
  if (s.qualities.length) settings.push([c.setQuality, vals(s.qualities.map((q) => (q in c.quality ? c.quality[q as keyof Copy["quality"]] : q)))]);
  if (s.resolutions.length)
    settings.push([
      c.setResolution,
      <>
        {vals(s.resolutions)}
        {s.defaultResolution && <span className={styles.sub}>{fmt(c.defaultRes, { res: s.defaultResolution })}</span>}
      </>,
    ]);
  if (s.durationsS.length) settings.push([c.setLength, vals(s.durationsS.map(dur))]);
  if (soundChoice(s)) settings.push([c.setSound, c.soundChoice]);
  else if (s.audioOut) settings.push([c.setSound, c.soundYes]);
  if (s.upscaleFactors.length) settings.push([c.setUpscale, vals(s.upscaleFactors.map((f) => `${f}×`))]);
  if (s.upscaleTargets.length) settings.push([c.setTargets, vals(s.upscaleTargets)]);
  if (s.languages.length) settings.push([c.setLanguages, vals(s.languages.map((l) => (l in c.languages ? c.languages[l as keyof Copy["languages"]] : l)))]);
  if (s.endFrame) settings.push([c.setEndFrame, c.endFrameYes]);
  if (s.maxSourceSeconds) settings.push([c.setLongest, <span key="l" className="ns-tc">{dur(s.maxSourceSeconds)}</span>]);

  const variantName = (parts: string[]) =>
    parts
      .map((p) => (p in c.quality ? c.quality[p as keyof Copy["quality"]] : p in c.sound ? c.sound[p as keyof Copy["sound"]] : p))
      .join(" · ");

  return (
    <div className={styles.detail}>
      <header className={styles.detailHead}>
        {withProvider && <span className="ns-eyebrow">{providerName(m.provider)}</span>}
        <h2 className={styles.detailName}>{m.displayName}</h2>
        <div className={styles.detailMeta}>
          <StatusLamp tone={LAMP[m.state]} label={c.states[m.state]} size="md" />
          <span className={styles.stage}>{c.stages[m.stage]}</span>
          {/* The registry id carries the vendor's name: the operator's, like the provider. */}
          {withProvider && (
            <span className="mono">
              {c.modelId} {m.id}
            </span>
          )}
        </div>
      </header>

      {(m.reasons.length > 0 || m.verifiedAt) && (
        <section className={styles.section} aria-label={c.availabilityHeading}>
          <h3 className={styles.sectionTitle}>{c.availabilityHeading}</h3>
          {m.reasons.length > 0 && (
            <ul className={styles.reasons}>
              {m.reasons.map((r, i) => (
                <li key={`${r.kind}-${i}`} className={styles.reason}>
                  <TriangleAlert aria-hidden className={`${styles.reasonIcon} size-3.5`} />
                  <span>{reasonText(c, r, operator)}</span>
                </li>
              ))}
            </ul>
          )}
          {m.verifiedAt && <p className={styles.note}>{fmt(c.verified, { when: dayOf(m.verifiedAt) })}</p>}
        </section>
      )}

      <section className={styles.section} aria-label={c.priceHeading}>
        <h3 className={styles.sectionTitle}>{c.priceHeading}</h3>
        <p className={styles.priceMain}>
          <RateFigure price={m.price} unit={unitWords} />
        </p>
        {m.price.kind === "variants" && (
          <table className={styles.priceTable}>
            <tbody>
              {m.price.rows.map((r) => (
                <tr key={r.parts.join("_")}>
                  <th scope="row">{variantName(r.parts)}</th>
                  <td>
                    <Rate value={r.rate} unit={t.design.crShort} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className={styles.note}>{c.priceNote}</p>
      </section>

      <section className={styles.section} aria-label={c.tasksHeading}>
        <dl className={styles.dl}>
          <dt>{c.tasksHeading}</dt>
          <dd>{tasksOf(m.capabilities).map((id) => c.tasks[id]).join(", ")}</dd>
          <dt>{c.inHeading}</dt>
          <dd>
            <ul className={styles.list}>{takes}</ul>
          </dd>
          <dt>{c.outHeading}</dt>
          <dd>{s.output ? c.outputs[s.output] : "—"}</dd>
          {withProvider && (
            <>
              <dt>{c.provider}</dt>
              <dd>{providerName(m.provider)}</dd>
            </>
          )}
        </dl>
      </section>

      <section className={styles.section} aria-label={c.settingsHeading}>
        <h3 className={styles.sectionTitle}>{c.settingsHeading}</h3>
        {settings.length ? (
          <dl className={styles.dl}>
            {settings.map(([k, v]) => (
              <Pair key={k} k={k} v={v} />
            ))}
          </dl>
        ) : (
          <p className={styles.note}>{c.noSettings}</p>
        )}
        {(s.speedTier !== null || s.qualityTier !== null) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--color-muted)]">
            <span>{c.marks}</span>
            <TierMarks speed={s.speedTier} quality={s.qualityTier} />
            <span>{c.marksNote}</span>
          </div>
        )}
        {s.webOnly && <p className={styles.note}>{c.webOnly}</p>}
        {s.attribution && (
          <p className={styles.note}>
            {c.attribution}{" "}
            <a href={s.attribution.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {s.attribution.text}
            </a>
          </p>
        )}
      </section>

      <section className={styles.section} aria-label={c.useHeading}>
        <h3 className={styles.sectionTitle}>{c.useHeading}</h3>
        {usable(m) ? (
          <>
            <div className={styles.actions}>
              {ordered.map((l, i) => (
                <UseAction key={l.cap} link={l} primary={i === 0} label={c.tasks[taskFor(l.cap, task)]} href={l.kind === "none" ? null : path(l.href)} />
              ))}
            </div>
            {ordered.some((l) => l.kind === "studio") && <p className={styles.note}>{gated ? `${c.linkNote} ${c.gatedNote}` : c.linkNote}</p>}
            {ordered.some((l) => l.kind === "editor") && <p className={styles.note}>{c.editorNote}</p>}
          </>
        ) : (
          <p className={styles.note}>{c.notOffered}</p>
        )}
      </section>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function UseAction({ link, primary, label, href }: { link: UseLink; primary: boolean; label: string; href: string | null }) {
  const { t, fmt } = useI18n();
  const c = t.modelDiscovery;
  if (link.kind === "none" || !href) return <p className={styles.note}>{fmt(c.noTool, { task: label })}</p>;
  const text = link.kind === "editor" ? c.openEditor : fmt(c.useFor, { task: label });
  return (
    <Link href={href} prefetch={false} className={primary ? "studio-cta" : styles.secondary}>
      <span>{text}</span>
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}

// ── the phone sheet ─────────────────────────────────────────────────────────

function DetailSheet({
  title,
  onClose,
  returnTo,
  children,
}: {
  title: string;
  onClose: () => void;
  returnTo: React.RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.modelDiscovery;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const back = returnTo.current;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      if (back && back.isConnected) back.focus();
    };
    // The opener belongs to the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mounted) closeRef.current?.focus();
  }, [mounted]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = nextFocusIndex(at, items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  if (!mounted) return null;
  return createPortal(
    <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.sheet} onKeyDown={onKeyDown}>
        <div className={styles.sheetHead}>
          <span id={titleId} className="ns-eyebrow">
            {c.details}
            <span className="sr-only">: {title}</span>
          </span>
          <button ref={closeRef} type="button" className={styles.closeKey} onClick={onClose} aria-label={c.close}>
            <X aria-hidden className="size-5" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
