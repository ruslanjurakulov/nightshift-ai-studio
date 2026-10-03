"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { AtSign, Clock, Languages, Maximize2, RectangleHorizontal, type LucideIcon } from "lucide-react";
import { DESK_TOOLS, pictureToolFor, type MediaDesk } from "@/lib/creative/desks";
import { Timecode } from "@/components/ui/Timecode";
import { useI18n } from "@/lib/i18n/context";
import { formatCredits } from "@/lib/credits";
import { useChannelPath } from "@/lib/channels-client";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { ModelSheet } from "@/components/studio/ModelSheet";
import { TierMarks } from "@/components/studio/TierMarks";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { useModelPrices, useSoundPrices, useTierPrices } from "@/components/studio/useModelPrices";
import { useStyleKits } from "@/components/studio/useStyleKits";
import { PlanUpsellDialog } from "@/components/studio/PlanUpsellDialog";
import { ChannelDnaHint } from "@/components/studio/ChannelDnaHint";
import "@/components/create/flow.css";
import { PriceButton } from "@/components/ui/PriceButton";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { creditUnit } from "@/lib/credits";
import type { StudioDna } from "@/lib/channel-dna";
import { isUpsellCode, refusalFrom, type Refusal, type UpsellCatalog } from "@/lib/upsell";
import { UPSCALE_FACTORS, type CreativeError } from "@/lib/creative/operations";
import {
  ASPECT_RATIOS,
  DESCRIBE_LANGUAGES,
  IMAGE_QUALITIES,
  PANEL_CAPABILITIES,
  DUB_LANGUAGES,
  PROMPT_MAX,
  STUDIO_VOICES,
  VIDEO_DURATIONS,
  apiErrorMessage,
  asCreativeError,
  blockedReason,
  buildParams,
  canQuote,
  defaultDescribeLanguage,
  effectiveQuality,
  effectiveSound,
  errorAction,
  generateLabel,
  modelsFor,
  needsRecording,
  needsSource,
  needsVideo,
  newIdempotencyKey,
  promptRule,
  sheetQuoteParams,
  soundQuoteParams,
  takesQuality,
  takesSound,
  takesStyle,
  tierQuoteParams,
  type AspectRatio,
  type DescribeLanguage,
  type DubLanguage,
  type ImageQuality,
  type QuoteState,
  routedLine,
  routedPick,
  upscaleTargetsFor,
  type StudioCapability,
  type StudioModel,
  type StudioPrefill,
  type UpscaleFactor,
  type UpscaleTarget,
  type VideoDuration,
} from "@/lib/creative/studio";

const QUOTE_DELAY_MS = 500;

/** What a tool starts from in the library: switching to a tool that starts from another kind starts the pick again. */
const startsFrom = (c: StudioCapability) =>
  needsSource(c) ? "picture" : needsRecording(c) ? "recording" : needsVideo(c) ? "video" : null;
const MAKE_KINDS = PANEL_CAPABILITIES.filter((c) => startsFrom(c) === null);
/** The picture tools (0046), the voice tools (0050) and the video tools (0052): each starts from something in the library. */
const MEDIA_TOOLS = PANEL_CAPABILITIES.filter((c) => startsFrom(c) !== null);

/** The longest recording each voice tool takes (0050's source check; the database still decides). */
const RECORDING_MAX_SECONDS: Record<"voice_change" | "dub", number> = { voice_change: 300, dub: 1800 };

/**
 * The Studio's composer. Make one image, video or voice (migration 0036), or
 * start from a library picture: edit, animate, upscale, cut out (0046), or
 * from a library recording: change its voice, or dub it (0050). The
 * database prices it (/api/creative/quote, debounced while typing); the price
 * is on the button, and pressing it sends exactly that price as `max_credits`
 * — a higher price is refused by the database, never charged. One idempotency
 * key per press. Nothing else here spends: switching tools, opening the model
 * sheet (which asks each model's price) and picking a picture only fill the form.
 *
 * Describe (0055) reads a library picture and writes a prompt for it: the
 * same priced press ("Describe · N credits"), and the answer is text in the
 * results — "Make similar" there only fills this form again.
 *
 * Images and videos can take one of the organization's style kits (0048),
 * the channel's default kit picked to start with; a style adds no credits.
 * @names in the words stay as typed — the worker brings in the characters.
 */
export function GeneratePanel({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
  dna = null,
  sourceRequest = null,
  plans,
  onCreated,
  desk = null,
}: {
  /**
   * The workspace this composer sits on (lib/creative/desks): it offers only
   * that desk's tools and arranges the fields around the desk's job. Absent:
   * every tool, in one column, as before. Prices, the hold and the create
   * call are the same either way.
   */
  desk?: MediaDesk | null;
  orgId: string;
  models: StudioModel[];
  /** "Try again" from the feed, a template, or the Library link: fills the form; spends nothing by itself. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), picked to start with when it is one of the org's kits. */
  defaultStyleKitId?: string | null;
  /** The open channel's DNA (0056): where a fresh form's aspect and speech voice start, and "Change"'s link. */
  dna?: (StudioDna & { href: string }) | null;
  /**
   * "Use as picture" from a finished result: that picture becomes the source
   * (switching to Edit when the current tool takes none). A new nonce applies
   * it once; the words and settings already typed stay.
   */
  sourceRequest?: { nonce: number; id: string } | null;
  /**
   * What the plan dialog may offer (lib/upsell.ts): a refusal for a plan,
   * parallel runs or credits opens it. Absent or null (an organization that
   * never pays): no dialog, the message alone.
   */
  plans?: UpsellCatalog | null;
  onCreated?: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const path = useChannelPath();
  // The tools this composer offers: its desk's, or every one.
  const tools: readonly StudioCapability[] = desk ? DESK_TOOLS[desk] : PANEL_CAPABILITIES;

  const [capability, setCapability] = useState<StudioCapability>(
    initial?.capability ?? tools.find((c) => modelsFor(models, c).length > 0) ?? tools[0] ?? "t2i",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [aspect, setAspect] = useState<AspectRatio>(initial?.aspect ?? dna?.aspect ?? "16:9");
  const [duration, setDuration] = useState<VideoDuration>(initial?.duration ?? 5);
  const [model, setModel] = useState(initial?.model ?? "");
  // 0075: "Auto" lets the database pick the model (mode auto). The quote names
  // the pick and its price; the press sends both back. Off = the picked model, exactly.
  const [auto, setAuto] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(initial?.sourceId ?? null);
  const [factor, setFactor] = useState<UpscaleFactor>(initial?.factor ?? 2);
  // A retried job keeps its own choice (even "none"); a fresh form starts from the channel's look.
  const [styleKitId, setStyleKitId] = useState<string | null>(
    initial && "styleKitId" in initial ? (initial.styleKitId ?? null) : defaultStyleKitId,
  );
  // Speech and a voice change speak in a voice the person picks; a dub in a language they pick. Only the
  // channel's own narrator voice (its DNA) is ever picked to start with — shown, and changeable.
  const [voiceId, setVoiceId] = useState<string | null>(initial?.voiceId ?? dna?.voiceId ?? null);
  const [targetLanguage, setTargetLanguage] = useState<DubLanguage | null>(initial?.targetLanguage ?? null);
  // 0052: the picture an animation ends on (optional), and the size a video upscale makes.
  const [endFrameId, setEndFrameId] = useState<string | null>(initial?.endFrameId ?? null);
  const [endOpen, setEndOpen] = useState(false);
  const [target, setTarget] = useState<UpscaleTarget | null>(initial?.target ?? null);
  // A description is written in the language the app is read in, unless the person picks another.
  const [describeLanguage, setDescribeLanguage] = useState<DescribeLanguage>(
    initial?.describeLanguage ?? defaultDescribeLanguage(locale),
  );
  // 0060: the picture's render quality; null = not picked, so the model's default (medium) applies.
  const [quality, setQuality] = useState<ImageQuality | null>(initial?.quality ?? null);
  // 0070: a clip's soundtrack; null = not picked, so the model's default (silent) applies.
  const [sound, setSound] = useState<boolean | null>(initial?.audio ?? null);
  const styles = useStyleKits(orgId);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [requote, setRequote] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" } | { kind: "error"; code: CreativeError } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const [upsell, setUpsell] = useState<{ refusal: Refusal; open: boolean } | null>(null);
  const tabRefs = useRef<Partial<Record<StudioCapability, HTMLButtonElement | null>>>({});

  const available = modelsFor(models, capability);
  // Auto is offered where there is a choice to make.
  const autoOffered = available.length > 1;
  const routed = auto && autoOffered;
  // The picked model if it can make this kind, else the first that can.
  const effectiveModel = available.some((m) => m.id === model) ? model : (available[0]?.id ?? "");
  const current = available.find((m) => m.id === effectiveModel) ?? null;
  // Model ids -> the names the picker shows, for Auto's pick.
  const modelNames = useMemo(() => new Map(models.map((m) => [m.id, m.displayName])), [models]);
  // Only a kit the organization has (as loaded) is ever sent: a stale default
  // or a deleted kit reads as "None" rather than as a refusal at the price.
  const effectiveStyle = styles.state === "ready" && styles.kits.some((k) => k.id === styleKitId) ? styleKitId : null;
  // An end frame goes only to a model that ends a clip on it; another model
  // keeps the pick but is never sent it (the database would refuse it).
  // Auto: the model is not known before the quote, so no model's own option
  // (an end frame, a tier, a soundtrack choice) is offered or sent.
  const takesEnd = !routed && capability === "i2v" && current?.endFrame === true;
  const effectiveEnd = takesEnd ? endFrameId : null;
  // The size: the one picked if this model makes it, else the model's first.
  // Auto: the sizes any model of this kind makes, never the hand-picked one's.
  const targets = upscaleTargetsFor(available, current, routed);
  const effectiveTarget = capability !== "video_upscale" ? null : target && targets.includes(target) ? target : (targets[0] ?? null);
  // A tier only for a picture tool on a model that sells tiers; another model never gets one.
  const effectiveQ = !routed && takesQuality(capability) ? effectiveQuality(current, quality) : null;
  // A soundtrack choice only for a video tool on a model that sells it; another model never gets one.
  const effectiveSnd = !routed && takesSound(capability) ? effectiveSound(current, sound) : null;
  const form = {
    capability,
    prompt,
    aspect,
    duration,
    sourceId,
    factor,
    styleKitId: effectiveStyle,
    voiceId,
    targetLanguage,
    endFrameId: effectiveEnd,
    target: effectiveTarget,
    describeLanguage,
    quality: effectiveQ,
    audio: effectiveSnd,
  };
  const params = useMemo(
    () =>
      buildParams({
        capability,
        prompt,
        aspect,
        duration,
        sourceId,
        factor,
        styleKitId: effectiveStyle,
        voiceId,
        targetLanguage,
        endFrameId: effectiveEnd,
        target: effectiveTarget,
        describeLanguage,
        quality: effectiveQ,
        audio: effectiveSnd,
      }),
    [capability, prompt, aspect, duration, sourceId, factor, effectiveStyle, voiceId, targetLanguage, effectiveEnd, effectiveTarget, describeLanguage, effectiveQ, effectiveSnd],
  );
  const paramsKey = JSON.stringify(params);
  // A price is asked for only once the form is complete (the picture, the words).
  const ready = canQuote(form);

  // The phone's sticky Generate dock would cover the length chips on the first view;
  // it rests in the flow until the page is scrolled, then sticks above the tab bar.
  const [dockAtTop, setDockAtTop] = useState(true);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      const top = t instanceof HTMLElement ? t.scrollTop : window.scrollY;
      setDockAtTop(top < 24);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  useEffect(() => {
    if (!ready || (!routed && !effectiveModel)) {
      setQuote({ status: "idle" });
      return;
    }
    setQuote({ status: "quoting" });
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/creative/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            routed
              ? { org_id: orgId, capability, mode: "auto", params: JSON.parse(paramsKey) }
              : { org_id: orgId, capability, model: effectiveModel, params: JSON.parse(paramsKey) },
          ),
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { quote?: Record<string, unknown>; error?: unknown };
        const credits = body.quote?.credits;
        const pick = routed ? routedPick(body.quote, modelNames) : null;
        if (res.ok && typeof credits === "number" && Number.isFinite(credits) && (!routed || pick))
          setQuote(pick ? { status: "ready", credits, routed: pick } : { status: "ready", credits });
        else setQuote({ status: "error", code: res.ok ? "failed" : asCreativeError(body.error) });
      } catch {
        if (!ctrl.signal.aborted) setQuote({ status: "error", code: "failed" });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [orgId, capability, effectiveModel, paramsKey, ready, requote, routed, modelNames]);

  // "Use as picture": applied once per request, never on the mount that a
  // template or Try again caused (that request was already used or cleared).
  const appliedSource = useRef(sourceRequest?.nonce ?? 0);
  useEffect(() => {
    if (!sourceRequest || sourceRequest.nonce === appliedSource.current) return;
    appliedSource.current = sourceRequest.nonce;
    setSourceId(sourceRequest.id);
    // A tool that starts from a picture keeps it; otherwise this desk's first
    // picture tool (Edit outside a desk, as before).
    setCapability((c) => pictureToolFor(tools, c, needsSource));
    setNotice(null);
  }, [sourceRequest, tools]);

  // The sheet's prices: the same settings, each model, only while it is open.
  const sheetParams = sheetOpen ? sheetQuoteParams(form) : null;
  const prices = useModelPrices({
    open: sheetOpen,
    orgId,
    capability,
    modelIds: available.map((m) => m.id),
    selectedId: effectiveModel,
    params: sheetParams,
    // Each model is priced at ITS tier: a model without tiers is asked without one.
    // Likewise its soundtrack: a model that offers no choice is asked without one.
    soundFor: takesSound(capability) ? Object.fromEntries(available.map((m) => [m.id, effectiveSound(m, sound)])) : undefined,
    tierFor: takesQuality(capability) ? Object.fromEntries(available.map((m) => [m.id, effectiveQuality(m, quality)])) : undefined,
  });
  // The picked model's tiers, each priced by the database for these settings (never a tier's own number from here).
  const tiers: readonly ImageQuality[] = takesQuality(capability) ? (current?.qualities ?? []) : [];
  const tierPrices = useTierPrices({
    orgId,
    capability,
    modelId: effectiveModel,
    tiers,
    // Without the words: the tiers' prices do not depend on them, and typing must not re-ask or send them.
    params: tiers.length ? tierQuoteParams(form) : null,
  });
  // The picked model's two soundtrack settings, each priced by the database for these settings.
  const soundChoice = takesSound(capability) && current?.soundChoice === true && effectiveSnd !== null;
  const soundPrices = useSoundPrices({
    orgId,
    capability,
    modelId: effectiveModel,
    // Without the words, like the tiers: a clip's price never reads them, and typing must not re-ask or send them.
    params: soundChoice ? soundQuoteParams(form) : null,
  });
  const soundText = (on: boolean): string => {
    const label = on ? t.gen.soundOn : t.gen.soundOff;
    const p = on ? soundPrices.sound : soundPrices.silent;
    if (!p) return label;
    if (p.status === "quoting") return `${label} · …`;
    if (p.status === "ready") return `${label} · ${fmt(t.gen.sheetCredits, { n: formatCredits(p.credits, locale) })}`;
    return `${label} · ${p.code === "unpriced" ? t.gen.qualityUnpriced : "—"}`;
  };
  const tierText = (q: ImageQuality): string => {
    const label = t.gen.qualities[q];
    const p = tierPrices[q];
    if (!p) return label;
    if (p.status === "quoting") return `${label} · …`;
    if (p.status === "ready") return `${label} · ${fmt(t.gen.sheetCredits, { n: formatCredits(p.credits, locale) })}`;
    return `${label} · ${p.code === "unpriced" ? t.gen.qualityUnpriced : "—"}`;
  };

  const edited = () => setNotice(null);

  async function generate() {
    if (quote.status !== "ready" || submitting || !ready) return;
    // Auto sends back the model its quote named; otherwise the picked model.
    const pressModel = routed ? quote.routed?.model : effectiveModel;
    if (!pressModel) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          capability,
          model: pressModel,
          ...(routed ? { mode: "auto" } : {}),
          params,
          idempotency_key: newIdempotencyKey(),
          // The price the person saw on the button: the ceiling, never more.
          max_credits: quote.credits,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (res.ok) {
        setNotice({ kind: "ok" });
        onCreated?.();
      } else {
        const code = asCreativeError(body.error);
        setNotice({ kind: "error", code });
        if (code === "price_changed" || code === "route_changed") setRequote((n) => n + 1);
        if (plans && isUpsellCode(code)) setUpsell({ refusal: refusalFrom(code, body), open: true });
      }
    } catch {
      setNotice({ kind: "error", code: "failed" });
    } finally {
      setSubmitting(false);
    }
  }

  const disabled =
    submitting || quote.status !== "ready" || !ready || (routed ? !quote.routed : !effectiveModel);
  const errorCode = notice?.kind === "error" ? notice.code : quote.status === "error" ? quote.code : null;
  const isVoice = capability === "tts";
  const sourced = needsSource(capability);
  const recorded = needsRecording(capability);
  const filmed = needsVideo(capability);
  const words = promptRule(capability);
  const blocked = blockedReason(form, !!effectiveModel);
  const blockedText = blocked ? t.gen.blocked[blocked] : null;

  const pick = (c: StudioCapability) => {
    // A picture, a recording and a video are never the same pick: switching
    // to a tool that starts from another kind starts the pick again.
    const from = startsFrom(c);
    const was = startsFrom(capability);
    if (from && was && from !== was) setSourceId(null);
    setCapability(c);
    edited();
  };

  // A tablist: ←/→ (and ↑/↓) move and choose, Home/End jump; one tab stop.
  // On a desk it is the desk's tools; outside one, the tool row under the mode switch.
  const rowTools: readonly StudioCapability[] = desk ? tools : MEDIA_TOOLS;
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, c: StudioCapability) {
    const i = rowTools.indexOf(c);
    const n = rowTools.length;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    const next = rowTools[to];
    pick(next);
    tabRefs.current[next]?.focus();
  }

  const tab = (c: StudioCapability) => {
    const Icon = TOOL_ICONS[c];
    const on = capability === c;
    return (
      <button
        key={c}
        ref={(el) => {
          tabRefs.current[c] = el;
        }}
        type="button"
        role="tab"
        id={`gen-tab-${c}`}
        aria-selected={on}
        aria-controls="gen-tabpanel"
        tabIndex={on || (!rowTools.includes(capability) && c === rowTools[0]) ? 0 : -1}
        onClick={() => pick(c)}
        onKeyDown={(e) => onTabKey(e, c)}
        className={desk ? "desk-tool" : "studio-tab"}
      >
        <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
        {desk ? (
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate">{t.desk.tools[c]}</span>
            <span className="desk-tool-from truncate">{t.desk.toolFrom[c]}</span>
          </span>
        ) : (
          <span className="max-w-full truncate">{t.gen.tabs[c]}</span>
        )}
      </button>
    );
  };

  function seg<T extends string | number>(
    groupLabel: string,
    Icon: LucideIcon | null,
    values: readonly T[],
    value: T,
    set: (v: T) => void,
    text: (v: T) => ReactNode,
    mono = false,
  ) {
    return (
      <div className="studio-seg" role="group" aria-label={groupLabel}>
        {Icon && <Icon aria-hidden className="mx-1.5 size-3.5 text-[var(--color-muted)]" />}
        {values.map((v) => (
          <button
            key={String(v)}
            type="button"
            aria-pressed={value === v}
            onClick={() => {
              set(v);
              edited();
            }}
            className={mono ? "tnum" : undefined}
          >
            {text(v)}
          </button>
        ))}
      </div>
    );
  }

  const hasSettings =
    capability === "t2i" || capability === "t2v" || capability === "i2v" || capability === "upscale" || (filmed && targets.length > 0);
  // On a desk the keys say more than the bare value: the shape drawn, the
  // length as a counter. Same values, same buttons, same group names.
  const aspectText = (a: AspectRatio): ReactNode =>
    desk ? (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="desk-shape" data-shape={a} />
        {a}
      </span>
    ) : (
      a
    );
  const durationText = (d: VideoDuration): ReactNode =>
    desk ? <Timecode value={d} format="duration" label={fmt(t.gen.seconds, { n: d })} /> : fmt(t.gen.seconds, { n: d });
  const settings = hasSettings ? (
    <div className="flex flex-wrap items-center gap-2">
      {(capability === "t2i" || capability === "t2v") &&
        seg(t.gen.aspectLabel, desk ? null : RectangleHorizontal, ASPECT_RATIOS, aspect, setAspect, aspectText, true)}
      {(capability === "t2v" || capability === "i2v") &&
        seg(t.gen.durationLabel, Clock, VIDEO_DURATIONS, duration, setDuration, durationText)}
      {capability === "upscale" &&
        seg(t.gen.factorLabel, Maximize2, UPSCALE_FACTORS, factor, setFactor, (f) => fmt(t.gen.factor, { n: f }))}
      {filmed &&
        effectiveTarget &&
        seg(t.gen.targetLabel, Maximize2, targets, effectiveTarget, setTarget, (v) => v.replace(/k$/, "K"), true)}
    </div>
  ) : null;
  const ToolIcon = TOOL_ICONS[capability];

  // ── the blocks: one of each field, arranged per desk below ─────────────────

  const tabsBlock = desk ? (
    <div role="tablist" aria-label={t.gen.kindLabel} className="desk-tools" data-count={tools.length}>
      {tools.map(tab)}
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      {/* The mode switch: what to make. The tools below it start from something in the library. */}
      <SegmentedSwitch
        semantics="tab"
        label={t.gen.kindLabel}
        idPrefix="gen-tab"
        controls="gen-tabpanel"
        size="lg"
        className="w-full [&>button]:flex-1 [&>button]:justify-center"
        value={MAKE_KINDS.includes(capability) ? capability : null}
        onChange={pick}
        options={MAKE_KINDS.map((c) => {
          const Icon = TOOL_ICONS[c];
          return { value: c, label: t.gen.tabs[c], icon: <Icon aria-hidden className="size-4" strokeWidth={1.75} /> };
        })}
      />
      <div role="tablist" aria-label={t.gen.toolRowLabel} className="grid grid-cols-3 gap-1">
        {MEDIA_TOOLS.map(tab)}
      </div>
    </div>
  );

  const dnaBlock = dna ? <ChannelDnaHint href={dna.href} /> : null;

  // Auto's quote, in words: "Auto picked X for N credits" and why.
  const autoLine = routed && quote.status === "ready" && quote.routed ? routedLine(t, quote.routed, quote.credits, locale) : null;
  // The model: what will make it, how fast, how good — and a way to change it.
  const modelBlock = current ? (
    <div className="studio-field flex items-center gap-3 p-3">
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] text-[var(--ns-amber-ink)]"
      >
        <ToolIcon className="size-5" strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="studio-label">{t.gen.modelLabel}</span>
        {routed ? (
          // Auto's pick, named with its price (it wraps on a phone: never cut).
          <span className="flex min-w-0 flex-col gap-0.5" aria-live="polite" data-testid="gen-auto-pick">
            <span className="text-sm font-semibold leading-snug text-[var(--color-fg)] [overflow-wrap:anywhere]">
              {autoLine ? autoLine.picked : quote.status === "quoting" ? t.gen.router.picking : t.gen.router.auto}
            </span>
            {autoLine?.why && <span className="text-xs text-[var(--color-muted)]">{autoLine.why}</span>}
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--color-fg)]" data-testid="gen-model-name">
              {current.displayName}
            </span>
            {current.beta && (
              <span className="shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--color-border)] px-1.5 py-px text-xs font-medium text-[var(--color-muted)]">
                {t.gen.beta}
              </span>
            )}
          </span>
        )}
        {!routed && <TierMarks speed={current.speedTier ?? null} quality={current.qualityTier ?? null} />}
      </span>
      {autoOffered && (
        <button
          type="button"
          aria-pressed={routed}
          aria-label={t.gen.router.autoLabel}
          title={routed ? t.gen.router.autoOff : t.gen.router.autoLabel}
          data-testid="gen-auto"
          onClick={() => {
            setAuto((a) => !a);
            edited();
          }}
          className="studio-chip tap press shrink-0 font-medium"
        >
          {t.gen.router.auto}
        </button>
      )}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-label={t.gen.modelChangeLabel}
        ref={changeRef}
        onClick={() => setSheetOpen(true)}
        className="tap press shrink-0 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)]"
      >
        {t.gen.modelChange}
      </button>
    </div>
  ) : (
    <p className="studio-field p-3 text-sm text-[var(--color-muted)]">{t.gen.noModels}</p>
  );

  // Image and Enhance lay the picture on the table, large; elsewhere it is a thumbnail.
  const wellPicture = desk === "image" || desk === "enhance";
  const sourceBlock = sourced ? (
    <div className="flex flex-col gap-2">
      <span className="studio-label">{desk === "video" ? t.desk.startFrame : t.gen.sourceLabel}</span>
      <SourcePicker
        orgId={orgId}
        value={sourceId}
        compact
        well={wellPicture}
        onChange={(id) => {
          setSourceId(id);
          edited();
        }}
        libraryHref={path("/library")}
      />
      <span className="text-xs text-[var(--color-muted)]">
        {capability === "describe" ? t.gen.describeNote : t.gen.keepsShape}
      </span>
    </div>
  ) : null;

  const describeLangBlock =
    capability === "describe" ? (
      <div className="flex flex-col gap-2">
        <span className="studio-label" id="gen-describe-lang">
          {t.gen.describeLanguageLabel}
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="gen-describe-lang">
          <Languages aria-hidden className="size-3.5 text-[var(--color-muted)]" />
          {DESCRIBE_LANGUAGES.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={describeLanguage === l}
              onClick={() => {
                setDescribeLanguage(l);
                edited();
              }}
              className="studio-chip"
            >
              {t.gen.languages[l]}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  const endFrameBlock = takesEnd ? (
    <div className="flex flex-col gap-2" data-testid="gen-end-frame">
      <span className="studio-label">
        {t.gen.endFrameLabel} · {t.gen.optional}
      </span>
      {endFrameId || endOpen ? (
        <>
          <SourcePicker
            orgId={orgId}
            value={endFrameId}
            compact
            label={t.gen.endFrameLabel}
            onChange={(id) => {
              setEndFrameId(id);
              edited();
            }}
            libraryHref={path("/library")}
          />
          <button
            type="button"
            onClick={() => {
              setEndFrameId(null);
              setEndOpen(false);
              edited();
            }}
            className="btn-quiet w-fit text-xs"
          >
            {t.gen.endFrameRemove}
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setEndOpen(true)} className="studio-chip w-fit">
          {t.gen.endFrameAdd}
        </button>
      )}
      <span className="text-xs text-[var(--color-muted)]">{t.gen.endFrameNote}</span>
    </div>
  ) : null;

  const videoSourceBlock = filmed ? (
    <div className="flex flex-col gap-2">
      <span className="studio-label">{t.gen.videoLabel}</span>
      <SourcePicker
        orgId={orgId}
        value={sourceId}
        compact
        media="video"
        maxSeconds={current?.maxSourceSeconds ?? null}
        onChange={(id) => {
          setSourceId(id);
          edited();
        }}
        libraryHref={path("/library")}
      />
      <span className="text-xs text-[var(--color-muted)]">{t.gen.videoUpscaleNote}</span>
    </div>
  ) : null;

  const recordingBlock = recorded ? (
    <div className="flex flex-col gap-2">
      <span className="studio-label">{t.gen.recordingLabel}</span>
      <SourcePicker
        orgId={orgId}
        value={sourceId}
        compact
        media="recording"
        maxSeconds={RECORDING_MAX_SECONDS[capability as "voice_change" | "dub"]}
        onChange={(id) => {
          setSourceId(id);
          edited();
        }}
        libraryHref={path("/library")}
      />
      <span className="text-xs text-[var(--color-muted)]">
        {capability === "dub" ? t.gen.dubNote : t.gen.voiceChangeNote}
      </span>
    </div>
  ) : null;

  // A voice's character in the reader's language (the list's own words are English).
  const voiceStyle = (v: { id: string; style: string }) => (t.desk.voiceStyles as Record<string, string>)[v.id] ?? v.style;
  const pickVoice = (id: string | null) => {
    setVoiceId(id);
    edited();
  };
  // The cast is a radio group: arrows move and pick, Home/End jump, one tab stop.
  const castRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const castPicked = STUDIO_VOICES.some((v) => v.id === voiceId);
  function onCastKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = STUDIO_VOICES.length;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    pickVoice(STUDIO_VOICES[to].id);
    castRefs.current[to]?.focus();
  }
  const voiceBlock =
    capability === "voice_change" || capability === "tts" ? (
      desk === "voice" ? (
        // The booth's cast: every voice as a row, one picked (the same ids the select offers).
        <div className="flex flex-col gap-2">
          <span className="studio-label" id="gen-voice-label">
            {capability === "tts" ? t.gen.ttsVoiceLabel : t.gen.voiceLabel}
          </span>
          <div role="radiogroup" aria-labelledby="gen-voice-label" className="desk-cast" data-testid="gen-voice-cast">
            {STUDIO_VOICES.map((v, i) => {
              const on = voiceId === v.id;
              // One tab stop: the picked voice, or the first when none is picked yet.
              const stop = on || (!castPicked && i === 0);
              return (
                <button
                  key={v.id}
                  ref={(el) => {
                    castRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={stop ? 0 : -1}
                  onClick={() => pickVoice(v.id)}
                  onKeyDown={(e) => onCastKey(e, i)}
                  className="desk-cast-row"
                >
                  <span aria-hidden className="ns-lamp" data-tone={on ? "run" : "off"} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold text-[var(--color-fg)]">{v.name}</span>
                    <span className="truncate text-xs text-[var(--color-muted)]">{voiceStyle(v)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="gen-voice" className="studio-label">
            {capability === "tts" ? t.gen.ttsVoiceLabel : t.gen.voiceLabel}
          </label>
          <select
            id="gen-voice"
            value={voiceId ?? ""}
            onChange={(e) => pickVoice(e.target.value || null)}
            className="studio-field w-full px-3 py-2.5 text-base text-[var(--color-fg)] outline-none sm:text-[14px]"
          >
            <option value="">{t.gen.voicePick}</option>
            {STUDIO_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {voiceStyle(v)}
              </option>
            ))}
          </select>
        </div>
      )
    ) : null;

  const dubLangBlock =
    capability === "dub" ? (
      <div className="flex flex-col gap-2">
        <span className="studio-label">{t.gen.languageLabel}</span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.gen.languageLabel}>
          <Languages aria-hidden className="size-3.5 text-[var(--color-muted)]" />
          {DUB_LANGUAGES.map((l) => (
            <button
              key={l}
              type="button"
              lang={l}
              aria-pressed={targetLanguage === l}
              onClick={() => {
                setTargetLanguage(l);
                edited();
              }}
              className="studio-chip"
            >
              {t.gen.languages[l]}
            </button>
          ))}
        </div>
      </div>
    ) : null;

  // The words, with the settings that ride under them (or, on Enhance, set apart above).
  const settingsInField = desk !== "enhance";
  const promptBlock =
    words !== "none" ? (
      <div className="flex flex-col gap-2">
        <label htmlFor="gen-prompt" className="studio-label">
          {isVoice ? (desk === "voice" ? t.desk.script : t.gen.voiceTextLabel) : desk === "video" ? t.desk.shot : t.gen.promptLabel}
          {words === "optional" && <span> · {t.gen.optional}</span>}
        </label>
        <div className="studio-field flex flex-col">
          <textarea
            id="gen-prompt"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              edited();
            }}
            rows={isVoice ? (desk === "voice" ? 10 : 6) : 4}
            maxLength={PROMPT_MAX}
            autoFocus={initial !== null}
            placeholder={t.gen.promptPh[capability]}
            className={`${desk === "voice" && isVoice ? "desk-script " : ""}${isVoice ? "" : "studio-shot "}min-h-[104px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-base leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus-visible:outline-none sm:text-[14px]`}
          />
          {settings && settingsInField && <div className="px-2 pb-2">{settings}</div>}
          {desk === "voice" && isVoice && (
            // Speech is priced by its characters: the count is the meter that matters here.
            <div className="flex items-center justify-between gap-2 px-3 pb-2 text-xs text-[var(--color-muted)]">
              <span>{t.desk.scriptNote}</span>
              <span data-testid="gen-char-count">
                <Timecode value={prompt.length} format="count" locale={locale} label={fmt(t.desk.charCount, { n: prompt.length, max: PROMPT_MAX })} />
                <span aria-hidden>
                  {" / "}
                  <Timecode value={PROMPT_MAX} format="count" locale={locale} />
                </span>
              </span>
            </div>
          )}
        </div>
        {takesStyle(capability) && (
          <span className="flex items-start gap-1.5 text-xs text-[var(--color-muted)]">
            <AtSign aria-hidden className="mt-[1px] size-3.5 shrink-0" />
            {t.gen.mentionHint}
          </span>
        )}
      </div>
    ) : settingsInField ? (
      settings
    ) : null;

  // Enhance: the size keys stand on their own, above everything but the picture.
  const sizeBlock =
    !settingsInField && settings ? (
      <div className="flex flex-col gap-2">
        <span className="studio-label">{capability === "upscale" ? t.gen.factorLabel : t.gen.targetLabel}</span>
        <div className="desk-size">{settings}</div>
      </div>
    ) : null;

  const qualityBlock =
    tiers.length > 0 && effectiveQ ? (
      <div className="flex flex-col gap-2" data-testid="gen-quality">
        <span className="studio-label" id="gen-quality-label">
          {t.gen.qualityLabel}
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="gen-quality-label">
          {IMAGE_QUALITIES.filter((q) => tiers.includes(q)).map((q) => {
            const p = tierPrices[q];
            return (
              <button
                key={q}
                type="button"
                data-testid={`gen-quality-${q}`}
                aria-pressed={effectiveQ === q}
                // A tier with no price is not sold: it cannot be picked (never shown as free).
                disabled={p?.status === "error" && p.code === "unpriced"}
                onClick={() => {
                  setQuality(q);
                  edited();
                }}
                className="studio-chip"
              >
                {tierText(q)}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-[var(--color-muted)]">{t.gen.qualityNote}</span>
      </div>
    ) : null;

  const soundBlock = soundChoice ? (
    <div className="flex flex-col gap-2" data-testid="gen-sound">
      <span className="studio-label" id="gen-sound-label">
        {t.gen.soundLabel}
      </span>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="gen-sound-label">
        {([false, true] as const).map((on) => {
          const p = on ? soundPrices.sound : soundPrices.silent;
          return (
            <button
              key={String(on)}
              type="button"
              data-testid={on ? "gen-sound-on" : "gen-sound-off"}
              aria-pressed={effectiveSnd === on}
              // A setting with no price is not sold: it cannot be picked (never shown as free).
              disabled={p?.status === "error" && p.code === "unpriced"}
              onClick={() => {
                setSound(on);
                edited();
              }}
              className="studio-chip"
            >
              {soundText(on)}
            </button>
          );
        })}
      </div>
      <span className="text-xs text-[var(--color-muted)]">{t.gen.soundNote}</span>
    </div>
  ) : null;

  const styleBlock =
    takesStyle(capability) && styles.state !== "unavailable" ? (
      <div className="flex flex-col gap-2">
        <span className="studio-label">{t.gen.styleLabel}</span>
        {styles.state === "loading" ? (
          <div className="flex flex-wrap gap-2" aria-busy="true" aria-label={t.gen.styleLoading}>
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton h-8 w-20 rounded-[var(--ns-r-key)]" />
            ))}
          </div>
        ) : styles.state === "failed" ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-muted)]">
            <span>{t.gen.styleFailed}</span>
            <button type="button" onClick={() => void styles.reload()} className="studio-chip">
              {t.gen.styleRetry}
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.styleLabel}>
              <button
                type="button"
                aria-pressed={effectiveStyle === null}
                onClick={() => {
                  setStyleKitId(null);
                  edited();
                }}
                className="studio-chip"
              >
                {t.gen.styleNone}
              </button>
              {styles.kits.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  aria-pressed={effectiveStyle === k.id}
                  onClick={() => {
                    setStyleKitId(k.id);
                    edited();
                  }}
                  className="studio-chip"
                >
                  <span className="truncate">{k.name}</span>
                </button>
              ))}
            </div>
            {styles.kits.length === 0 && (
              <span className="text-xs text-[var(--color-muted)]">
                {t.gen.styleEmpty}{" "}
                <Link href={path("/studio")} className="tap-link text-[var(--color-primary)] underline">
                  {t.gen.styleMake}
                </Link>
              </span>
            )}
            {/* The built-in library: opening it changes nothing here, adding a style is a click there. */}
            <Link href={path("/styles")} className="tap-link self-start text-xs text-[var(--color-primary)] underline">
              {t.gen.styleBrowse}
            </Link>
          </>
        )}
      </div>
    ) : null;

  const dockBlock = (
    <div className="studio-dock flex flex-col gap-2" data-testid="gen-dock" data-at-top={dockAtTop ? "true" : undefined}>
      {/* The price key (components/ui/PriceButton): the action and the
          database's quote as two legends; its name is the same sentence. */}
      <PriceButton
        ref={generateRef}
        disabled={disabled}
        onClick={generate}
        aria-busy={submitting || quote.status === "quoting"}
        aria-describedby="gen-status"
        aria-label={submitting ? t.gen.starting : generateLabel(t, quote, locale, capability)}
        label={
          submitting
            ? t.gen.starting
            : quote.status === "quoting"
              ? t.gen.quoting
              : capability === "describe"
                ? t.gen.describe
                : t.gen.generate
        }
        credits={!submitting && quote.status === "ready" ? quote.credits : null}
        unit={quote.status === "ready" ? creditUnit(quote.credits, locale, t.shell.creditUnit) : undefined}
        locale={locale}
        icon={<span aria-hidden className={`ns-rec${quote.status === "quoting" || submitting ? " pulse" : ""}`} />}
      />
      <p id="gen-status" className={`min-h-[18px] text-xs${desk ? "" : " text-center"}`} aria-live="polite">
        {notice?.kind === "ok" ? (
          <span className="text-[var(--color-ok)]">{t.gen.started}</span>
        ) : errorCode ? (
          <span className="text-[var(--color-fail)]">
            {apiErrorMessage(t, errorCode)}
            {errorAction(errorCode) === "credits" && (
              <>
                {" "}
                <Link href={path("/credits")} className="tap-link text-[var(--color-primary)] underline">
                  {t.gen.addCredits}
                </Link>
              </>
            )}
            {plans && isUpsellCode(errorCode) && errorAction(errorCode) === "plans" && (
              <>
                {" "}
                <button
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() =>
                    setUpsell((u) => ({ refusal: u?.refusal.code === errorCode ? u.refusal : refusalFrom(errorCode, null), open: true }))
                  }
                  className="tap-link text-[var(--color-primary)] underline"
                >
                  {t.upsell.seePlans}
                </button>
              </>
            )}
          </span>
        ) : blockedText ? (
          <span className="text-[var(--color-muted)]">{blockedText}</span>
        ) : (
          <span className="text-[var(--color-muted)]">{routed ? t.gen.router.note : t.gen.holdNote}</span>
        )}
      </p>
    </div>
  );

  const dialogs = (
    <>
      {sheetOpen && (
        <ModelSheet
          capability={capability}
          models={available}
          selectedId={effectiveModel}
          prices={prices}
          priceHint={sheetParams ? null : blockedText}
          onSelect={(id) => {
            setModel(id);
            // A model picked by hand is the model: Auto is off.
            setAuto(false);
            edited();
            setSheetOpen(false);
          }}
          onClose={() => setSheetOpen(false)}
          returnTo={changeRef}
        />
      )}

      {upsell?.open && plans && (
        <PlanUpsellDialog
          refusal={upsell.refusal}
          model={current ? { name: current.displayName, entitlement: current.entitlement } : null}
          data={plans}
          onClose={() => setUpsell((u) => u && { ...u, open: false })}
          returnTo={generateRef}
        />
      )}
    </>
  );

  const title = (
    <h2 id="gen-title" className="sr-only">
      {t.gen.title}
    </h2>
  );
  const panel = (className: string, children: ReactNode) => (
    <div role="tabpanel" id="gen-tabpanel" aria-labelledby={`gen-tab-${capability}`} className={className}>
      {children}
    </div>
  );

  // ── the arrangements ───────────────────────────────────────────────────────

  if (desk === "video") {
    // A column beside the monitor: the desk's two ways in, the frames side by
    // side (start, and an end where the model takes one), the shot with its
    // shape and length keys, then sound, look, model and the price key.
    return (
      <section className="studio-surface desk-composer" data-desk="video" aria-labelledby="gen-title">
        {title}
        {tabsBlock}
        {dnaBlock}
        {panel(
          "flex flex-col gap-4",
          <>
            {(sourceBlock || endFrameBlock) && (
              <div className="desk-frames">
                {sourceBlock}
                {endFrameBlock}
              </div>
            )}
            {promptBlock}
            {/* The defaults are sensible (the channel's look, the best model for the shot): sound, look and
                model stay one tap away, folded, so the first view is the shot, its length and the price. */}
            <details className="fl-more" data-testid="gen-more">
              <summary>{t.create.flow.more}</summary>
              <div className="fl-more-body">
                {soundBlock}
                {styleBlock}
                {modelBlock}
              </div>
            </details>
          </>,
        )}
        {dockBlock}
        {dialogs}
      </section>
    );
  }

  if (desk === "voice") {
    // The booth: the script (or the recording) on the left, the cast and the price key on the right.
    return (
      <section className="studio-surface desk-composer" data-desk="voice" aria-labelledby="gen-title">
        {title}
        <div className="desk-composer-head">
          {tabsBlock}
          {dnaBlock}
        </div>
        {panel(
          "desk-booth",
          <>
            <div className="desk-booth-script">
              {recordingBlock}
              {promptBlock}
            </div>
            <div className="desk-booth-cast">
              {voiceBlock}
              {dubLangBlock}
              {modelBlock}
              {dockBlock}
            </div>
          </>,
        )}
        {dialogs}
      </section>
    );
  }

  if (desk === "enhance") {
    // The loupe's control bar, across the top: the tools | the picture or
    // video | the size (and, for a picture, what to keep sharp) | model and key.
    return (
      <section className="studio-surface desk-composer" data-desk="enhance" aria-labelledby="gen-title">
        {title}
        <div className="desk-bench">
          <div className="desk-bench-tools">
            {tabsBlock}
            {dnaBlock}
          </div>
          {panel(
            "desk-bench-panel",
            <>
              <div className="desk-bench-source">
                {sourceBlock}
                {videoSourceBlock}
              </div>
              <div className="desk-bench-size">
                {sizeBlock}
                {promptBlock}
              </div>
              <div className="desk-bench-go">
                {modelBlock}
                {dockBlock}
              </div>
            </>,
          )}
        </div>
        {dialogs}
      </section>
    );
  }

  if (desk === "image") {
    // A column beside the light table: the picture first (when the tool starts
    // from one), then what to do with it, then the look, then the model.
    return (
      <section className="studio-surface desk-composer" data-desk="image" aria-labelledby="gen-title">
        {title}
        {tabsBlock}
        {dnaBlock}
        {panel(
          "flex flex-col gap-4",
          <>
            {sourceBlock}
            {describeLangBlock}
            {promptBlock}
            {styleBlock}
            {qualityBlock}
            {modelBlock}
          </>,
        )}
        {dockBlock}
        {dialogs}
      </section>
    );
  }

  return (
    <section className="studio-surface flex flex-col gap-4 p-4" aria-labelledby="gen-title">
      {title}
      {tabsBlock}
      {dnaBlock}
      {panel(
        "flex flex-col gap-4",
        <>
          {modelBlock}
          {sourceBlock}
          {describeLangBlock}
          {endFrameBlock}
          {videoSourceBlock}
          {recordingBlock}
          {voiceBlock}
          {dubLangBlock}
          {promptBlock}
          {qualityBlock}
          {soundBlock}
          {styleBlock}
        </>,
      )}
      {dockBlock}
      {dialogs}
    </section>
  );
}
