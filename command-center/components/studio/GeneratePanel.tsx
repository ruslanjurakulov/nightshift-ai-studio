"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUp, AtSign, ChevronDown, Clock, Languages, Lock, Maximize2, MonitorPlay, Plus, RectangleHorizontal, Settings2, X, type LucideIcon } from "lucide-react";
import { DESK_TOOLS, pictureToolFor, type MediaDesk } from "@/lib/creative/desks";
import { ATTACH_ACCEPT } from "@/lib/site/pending-attachment";
import { Timecode } from "@/components/ui/Timecode";
import { useI18n } from "@/lib/i18n/context";
import { failedJobLimitText } from "@/lib/creative/failed-job-limit";
import { formatCredits } from "@/lib/credits";
import { useChannelPath } from "@/lib/channels-client";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { ModelSheet } from "@/components/studio/ModelSheet";
import { TierMarks } from "@/components/studio/TierMarks";
import { ModelAttribution } from "@/components/studio/ModelAttribution";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { useModelPrices, useSoundPrices, useTierPrices } from "@/components/studio/useModelPrices";
import { useStyleKits } from "@/components/studio/useStyleKits";
import { PlanUpsellDialog } from "@/components/studio/PlanUpsellDialog";
import { RightsAcknowledgementDialog, type RightsAckState } from "@/components/studio/RightsAcknowledgementDialog";
import { inputSubjects, parseRefusalDetail, parseStatus, type MissingAcknowledgement, type RightsSubjectKey } from "@/lib/rights-acknowledgement";
import { ChannelDnaHint } from "@/components/studio/ChannelDnaHint";
import "@/components/create/flow.css";
import { PriceButton } from "@/components/ui/PriceButton";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { creditUnit } from "@/lib/credits";
import type { StudioDna } from "@/lib/channel-dna";
import { isUpsellCode, refusalFrom, UPSELL_LINKS, type Refusal, type UpsellCatalog } from "@/lib/upsell";
import { refreshCredits, useLiveCredits } from "@/lib/credits-live";
import { RELIGHT_LOOKS, UPSCALE_FACTORS, type CreativeError } from "@/lib/creative/operations";
import {
  DESCRIBE_LANGUAGES,
  IMAGE_QUALITIES,
  PANEL_CAPABILITIES,
  DUB_LANGUAGES,
  PROMPT_MAX,
  STUDIO_VOICES,
  apiErrorMessage,
  asCreativeError,
  blockedReason,
  buildParams,
  canQuote,
  defaultDescribeLanguage,
  durationsFor,
  effectiveQuality,
  entitlementReason,
  effectiveSound,
  errorAction,
  expandShapesFor,
  generateLabel,
  isAiEdit,
  isPictureOp,
  modelSettings,
  modelShapes,
  modelsFor,
  needsRecording,
  needsSource,
  needsVideo,
  newIdempotencyKey,
  promptRule,
  reframeShapesFor,
  relightLooksFor,
  resolutionLabel,
  resolutionsFor,
  shapesFor,
  sheetQuoteParams,
  snapSeconds,
  snapShape,
  soundQuoteParams,
  takesQuality,
  takesShape,
  takesSound,
  takesStyle,
  tierQuoteParams,
  wordsMax,
  type DescribeLanguage,
  type DubLanguage,
  type ExpandAspect,
  type ImageQuality,
  type ModelLock,
  type QuoteState,
  routedLine,
  routedPick,
  upscaleTargetsFor,
  type RelightLook,
  type StudioCapability,
  type StudioModel,
  type StudioPrefill,
  type UpscaleFactor,
  type UpscaleTarget,
} from "@/lib/creative/studio";

const QUOTE_DELAY_MS = 500;

/** desk.css draws the five common shapes; any other shape a model lists (3:2, 21:9, 4:5 ...) is drawn from its own ratio. */
const DRAWN_SHAPES = ["16:9", "9:16", "1:1", "4:3", "3:4"];
function shapeGlyph(a: string): CSSProperties | undefined {
  if (DRAWN_SHAPES.includes(a)) return undefined;
  const [w, h] = a.split(":").map(Number);
  if (!w || !h) return undefined;
  const r = w / h;
  return r >= 1 ? { width: 16, height: Math.max(4, 16 / r) } : { width: Math.max(4, 14 * r), height: 14 };
}

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
  unavailable = [],
  layout = "panel",
  onDraftChange,
  composerExtra = null,
  autoFocusPrompt,
  onAttachFile,
  attachBusy = false,
  attachNote = null,
  onSubmittingChange,
  onEdit,
}: {
  /**
   * Told on each change the person makes to the form after it mounted (the words, the tool, the model, any setting): the page never
   * swaps a box the person has touched (StudioHome's attachment). Unlike onDraftChange, never on the mount itself.
   */
  onEdit?: () => void;
  /** Told when a press of Generate starts and ends: the page never swaps this box under a create in flight (StudioHome). */
  onSubmittingChange?: (submitting: boolean) => void;
  /**
   * Composer only: [+] takes a picture or a video from the device (the system picker, ATTACH_ACCEPT) and hands it to the page, which
   * uploads it to the library and opens the tool for its kind (components/studio/StudioHome.tsx). Absent: [+] switches to this mode's
   * first tool that starts from a library file, as before (the Voice mode, whose files are recordings).
   */
  onAttachFile?: (file: File) => void;
  /** A file handed over is still on its way into the library: [+] waits. */
  attachBusy?: boolean;
  /**
   * Composer only: the page's line about that file (uploading, the tool it switched to, or why it did not attach), drawn inside the
   * box under the send row, so it is part of the box and never lies over the page under a pinned box.
   */
  attachNote?: ReactNode;
  /** Whether the words box takes focus when it mounts (default: when the form came filled). A mode picked by keyboard keeps focus on its chip. */
  autoFocusPrompt?: boolean;
  /**
   * `composer` (the /create overview): the same form as one chat-style box —
   * the words first, then [+] to start from a file, the model, the settings
   * folded behind one key, and the price key that sends. Only the arrangement
   * changes: the tools (`desk`), the quote, the hold and the create request are
   * exactly the panel's (tests/studio-home.test.tsx compares the two).
   */
  layout?: "panel" | "composer";
  /** The words as typed, for a page that carries them to another mode. */
  onDraftChange?: (prompt: string) => void;
  /** Composer only: a key the page adds to the box's bar (the Assistant's Plan toggle). */
  composerExtra?: ReactNode;
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
  /**
   * The model ids the owner switched off for now (migration 0124, models_switched_off()): ids only, never a reason. A model the form came
   * with (a retried job, a link from the catalog) that is one of them is NOT swapped for another: the form says it is temporarily
   * unavailable and the person picks another themselves (CLAUDE.md #4).
   */
  unavailable?: readonly string[];
}) {
  const { t, fmt, locale } = useI18n();
  const path = useChannelPath();
  // The tools this composer offers: its desk's, or every one.
  const tools: readonly StudioCapability[] = desk ? DESK_TOOLS[desk] : PANEL_CAPABILITIES;
  // `desk` picks the tools; `arrange` is the desk's own look, which the composer does not use.
  const composer = layout === "composer";
  const arrange: MediaDesk | null = composer ? null : desk;
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [capability, setCapability] = useState<StudioCapability>(
    initial?.capability ?? tools.find((c) => modelsFor(models, c).length > 0) ?? tools[0] ?? "t2i",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const draftRef = useRef(onDraftChange);
  draftRef.current = onDraftChange;
  useEffect(() => {
    draftRef.current?.(prompt);
  }, [prompt]);
  // The shape and length asked for; what is SENT is snapped to the picked model's own lists (effectiveAspect / effectiveSeconds).
  const [aspect, setAspect] = useState<string>(initial?.aspect ?? dna?.aspect ?? "16:9");
  const [duration, setDuration] = useState<number>(initial?.duration ?? 5);
  // 0070: a clip's resolution; null = the model's pinned default (sent as nothing, priced as the default).
  const [resolution, setResolution] = useState<string | null>(initial?.resolution ?? null);
  const [model, setModel] = useState(initial?.model ?? "");
  // 0075: "Auto" lets the database pick the model (mode auto). The quote names
  // the pick and its price; the press sends both back. Off = the picked model, exactly.
  // A link may start it on ("Improve with AI" with Auto picked); it only counts where Auto is offered (`routed` below).
  const [auto, setAuto] = useState(initial?.auto === true);
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
  // 0099: the shape an expand extends the picture to, and the light a relight is asked for by name.
  const [shape, setShape] = useState<ExpandAspect | null>(initial?.shape ?? null);
  const [look, setLook] = useState<RelightLook | null>(initial?.look ?? null);
  // A description is written in the language the app is read in, unless the person picks another.
  const [describeLanguage, setDescribeLanguage] = useState<DescribeLanguage>(
    initial?.describeLanguage ?? defaultDescribeLanguage(locale),
  );
  // 0060: the picture's render quality; null = not picked, so the model's default (medium) applies.
  const [quality, setQuality] = useState<ImageQuality | null>(initial?.quality ?? null);
  // 0070: a clip's soundtrack; null = not picked, so the model's default (silent) applies.
  const [sound, setSound] = useState<boolean | null>(initial?.audio ?? null);
  // What the person has set, as asked (not the effective values, which also move when the models or the style kits load): a change
  // from the mounted form is theirs. Compared to the last key seen, so React's second effect run on mount is not a change.
  const editKey = JSON.stringify([
    capability, prompt, aspect, duration, resolution, model, auto, sourceId, factor, styleKitId, voiceId, targetLanguage, endFrameId,
    target, shape, look, describeLanguage, quality, sound,
  ]);
  const seenEdit = useRef(editKey);
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  useEffect(() => {
    if (editKey === seenEdit.current) return;
    seenEdit.current = editKey;
    editRef.current?.();
  }, [editKey]);
  const styles = useStyleKits(orgId);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [requote, setRequote] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(onSubmittingChange);
  submittingRef.current = onSubmittingChange;
  useEffect(() => {
    submittingRef.current?.(submitting);
  }, [submitting]);
  // A box that unmounts mid-press (never by the page's own swap: it waits) is not pressing any more.
  useEffect(() => () => submittingRef.current?.(false), []);
  const [notice, setNotice] = useState<{ kind: "ok" } | { kind: "error"; code: CreativeError; detail?: string } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const [upsell, setUpsell] = useState<{ refusal: Refusal; open: boolean } | null>(null);
  // 0174: the rights acknowledgement step (null = closed), and the press it holds: the model and the quote the person pressed
  // with, and which input each subject is. The job starts with exactly these once every input is acknowledged.
  const [rightsAck, setRightsAck] = useState<RightsAckState | null>(null);
  const ackPress = useRef<{ model: string; pressed: QuoteState; params: Record<string, unknown>; subjects: { key: RightsSubjectKey; id: string }[] } | null>(null);
  const tabRefs = useRef<Partial<Record<StudioCapability, HTMLButtonElement | null>>>({});
  const filePicker = useRef<HTMLInputElement>(null);

  // The models of this kind, the ones this organization can buy first (modelLock: the database refuses the others for it).
  const available = useMemo(() => {
    const all = modelsFor(models, capability);
    return [...all.filter((m) => !m.lock), ...all.filter((m) => m.lock)];
  }, [models, capability]);
  const usable = available.filter((m) => !m.lock);
  // Auto is offered where there is a choice to make (the router never picks a model the database refuses this organization).
  const autoOffered = usable.length > 1;
  const routed = auto && autoOffered;
  // A model the form came with that the owner switched off: nothing is picked for the person (0124).
  const pickedOff = model !== "" && unavailable.includes(model) && !available.some((m) => m.id === model);
  // The picked model if it can make this kind, else the first this organization can buy (never a locked one just because its
  // name sorts first), else the first at all (then its lock is named).
  const effectiveModel = pickedOff ? "" : available.some((m) => m.id === model) ? model : ((usable[0] ?? available[0])?.id ?? "");
  const current = available.find((m) => m.id === effectiveModel) ?? null;
  // Why the picked model cannot be bought here: no price is asked (the database would refuse it), the reason is named instead.
  const locked: ModelLock | null = !routed && current?.lock ? current.lock : null;
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
  // The shape: the one picked if this model makes it, else the model's first. A light is never defaulted:
  // the person picks one (or describes it), because the press pays for exactly that.
  const shapes = capability === "video_reframe" ? reframeShapesFor(available, current, routed) : expandShapesFor(available, current, routed);
  const effectiveShape = !takesShape(capability) ? null : shape && shapes.includes(shape) ? shape : (shapes[0] ?? null);
  const looks = relightLooksFor(available, current, routed);
  const effectiveLook = capability !== "relight" ? null : look && looks.includes(look) ? look : null;
  // A tier only for a picture tool on a model that sells tiers; another model never gets one.
  const effectiveQ = !routed && takesQuality(capability) ? effectiveQuality(current, quality) : null;
  // A soundtrack choice only for a video tool on a model that sells it; another model never gets one.
  const effectiveSnd = !routed && takesSound(capability) ? effectiveSound(current, sound) : null;
  // The shapes, lengths and resolutions come from the picked model's own spec (Auto: every model's that this organization can
  // buy). 0155 refuses a shape the model does not list and 0159 a length, so offering a fixed list sold refusals.
  const textShape = capability === "t2i" || capability === "t2v";
  const clip = capability === "t2v" || capability === "i2v";
  const pool = usable.length ? usable : available;
  const shapeList = textShape ? shapesFor(pool, current, routed, capability) : [];
  const ownShapes = !routed && textShape ? modelShapes(current, capability) : null;
  // A model whose spec lists no aspect ratio makes its own shape: no shape is offered or sent for it (Auto: not known, as above).
  const shapeless = !routed && textShape && (ownShapes ? ownShapes.length === 0 : current?.fixedShape === true);
  const effectiveAspect = snapShape(aspect, shapeList);
  const lengths = clip ? durationsFor(pool, current, routed) : [];
  const effectiveSeconds = snapSeconds(duration, lengths);
  // A resolution only on a hand-picked model whose price follows it; the default stands for "send none".
  const resolutions = clip ? resolutionsFor(current, routed) : [];
  const defaultRes = current?.defaultResolution ?? null;
  const shownRes = resolution && resolutions.includes(resolution) ? resolution : defaultRes;
  const effectiveRes = resolutions.length > 0 && shownRes && shownRes !== defaultRes ? shownRes : null;
  // A model whose spec lists no clip length at all cannot be sold a clip (0159 refuses every length): no price is asked for a
  // stand-in length, the reason is named instead.
  const noLength = clip && !routed && !!current && Array.isArray(current.durations) && current.durations.length === 0;
  // What was asked for (a retried job, a link, a setting kept from another model) and is NOT what will be sent: said in one line,
  // never changed silently (CLAUDE.md #4).
  const snapped: Array<[string, string]> = [];
  if (textShape && !shapeless && shapeList.length > 0 && aspect !== effectiveAspect) snapped.push([aspect, effectiveAspect]);
  if (clip && lengths.length > 0 && duration !== effectiveSeconds)
    snapped.push([fmt(t.gen.seconds, { n: duration }), fmt(t.gen.seconds, { n: effectiveSeconds })]);
  if (clip && !routed && current && resolution && resolution !== shownRes)
    snapped.push([resolutionLabel(resolution), shownRes ? resolutionLabel(shownRes) : t.gen.snapModelDefault]);
  const snapText = snapped.length
    ? fmt(routed ? t.gen.snapAuto : t.gen.snapNote, {
        model: current?.displayName ?? "",
        from: snapped.map((s) => s[0]).join(", "),
        to: snapped.map((s) => s[1]).join(", "),
      })
    : null;
  const form = {
    capability,
    prompt,
    aspect: effectiveAspect,
    duration: effectiveSeconds,
    resolution: effectiveRes,
    sourceId,
    factor,
    styleKitId: effectiveStyle,
    voiceId,
    targetLanguage,
    endFrameId: effectiveEnd,
    target: effectiveTarget,
    shape: effectiveShape,
    look: effectiveLook,
    describeLanguage,
    quality: effectiveQ,
    audio: effectiveSnd,
    noAspect: shapeless,
  };
  const params = useMemo(
    () =>
      buildParams({
        capability,
        prompt,
        aspect: effectiveAspect,
        duration: effectiveSeconds,
        resolution: effectiveRes,
        sourceId,
        factor,
        styleKitId: effectiveStyle,
        voiceId,
        targetLanguage,
        endFrameId: effectiveEnd,
        target: effectiveTarget,
        shape: effectiveShape,
        look: effectiveLook,
        describeLanguage,
        quality: effectiveQ,
        audio: effectiveSnd,
        noAspect: shapeless,
      }),
    [capability, prompt, effectiveAspect, effectiveSeconds, effectiveRes, sourceId, factor, effectiveStyle, voiceId, targetLanguage, effectiveEnd, effectiveTarget, effectiveShape, effectiveLook, describeLanguage, effectiveQ, effectiveSnd, shapeless],
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
    if (!ready || (!routed && !effectiveModel) || locked || noLength) {
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
        const body = (await res.json().catch(() => ({}))) as { quote?: Record<string, unknown>; error?: unknown; detail?: unknown };
        const credits = body.quote?.credits;
        const pick = routed ? routedPick(body.quote, modelNames) : null;
        if (res.ok && typeof credits === "number" && Number.isFinite(credits) && (!routed || pick))
          setQuote(pick ? { status: "ready", credits, routed: pick } : { status: "ready", credits });
        else
          setQuote({
            status: "error",
            code: res.ok ? "failed" : asCreativeError(body.error),
            ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
          });
      } catch {
        if (!ctrl.signal.aborted) setQuote({ status: "error", code: "failed" });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [orgId, capability, effectiveModel, paramsKey, ready, requote, routed, modelNames, locked, noLength]);

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

  // Each model's own shape, length and resolution for the sheet's prices, and, where they are not the form's, those settings in
  // words beside its price ("at 8 s · 16:9"): a number asked at other settings is never shown as if it were this form's.
  const sheetSettings =
    textShape || clip
      ? Object.fromEntries(
          available.map((m) => [m.id, modelSettings(m, capability, effectiveAspect, effectiveSeconds, m.id === effectiveModel ? effectiveRes : null)]),
        )
      : undefined;
  const sentAspect = shapeless ? null : effectiveAspect;
  const pricedAt = sheetSettings
    ? Object.fromEntries(
        Object.entries(sheetSettings).flatMap(([id, s]) => {
          const parts: string[] = [];
          if (typeof s.duration_s === "number" && s.duration_s !== effectiveSeconds) parts.push(fmt(t.gen.seconds, { n: s.duration_s }));
          if ("aspect_ratio" in s && s.aspect_ratio !== sentAspect && typeof s.aspect_ratio === "string") parts.push(s.aspect_ratio);
          if (typeof s.resolution === "string" && s.resolution !== effectiveRes) parts.push(resolutionLabel(s.resolution));
          return parts.length ? [[id, parts.join(" · ")]] : [];
        }),
      )
    : undefined;
  // The sheet's prices: the same settings, each model, only while it is open.
  const sheetParams = sheetOpen ? sheetQuoteParams(form) : null;
  const prices = useModelPrices({
    open: sheetOpen,
    orgId,
    capability,
    // A model this organization cannot buy is not priced: the sheet names its lock instead.
    modelIds: available.filter((m) => !m.lock).map((m) => m.id),
    selectedId: effectiveModel,
    params: sheetParams,
    // Each model at ITS shape, length and resolution (the ones it would be sent if picked).
    settingsFor: sheetSettings,
    // Each model is priced at ITS tier: a model without tiers is asked without one.
    // Likewise its soundtrack: a model that offers no choice is asked without one.
    soundFor: takesSound(capability) ? Object.fromEntries(available.map((m) => [m.id, effectiveSound(m, sound)])) : undefined,
    tierFor: takesQuality(capability) ? Object.fromEntries(available.map((m) => [m.id, effectiveQuality(m, quality)])) : undefined,
  });
  // The picked model's tiers, each priced by the database for these settings (never a tier's own number from here).
  // A locked model is not priced at all (its tiers and soundtracks neither): the database would refuse each one.
  const tiers: readonly ImageQuality[] = takesQuality(capability) && !locked ? (current?.qualities ?? []) : [];
  const tierPrices = useTierPrices({
    orgId,
    capability,
    modelId: effectiveModel,
    tiers,
    // Without the words: the tiers' prices do not depend on them, and typing must not re-ask or send them.
    params: tiers.length ? tierQuoteParams(form) : null,
  });
  // The picked model's two soundtrack settings, each priced by the database for these settings.
  const soundChoice = takesSound(capability) && !locked && current?.soundChoice === true && effectiveSnd !== null;
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

  // One press at a time, even when two arrive before React re-renders (a double Enter, a double tap).
  const pressing = useRef(false);
  // The composer's one send per quote: the quote a job was created with is spent. Enter or the key
  // sends again only after the words or a setting changed, which asks a fresh quote (a new object).
  const [spent, setSpent] = useState<QuoteState | null>(null);
  const quoteSpent = composer && spent !== null && spent === quote;

  /**
   * 0174: the database refused the job because this person has not acknowledged an input of this model (nothing was held).
   * Ask it which of this press's inputs are still missing, so one dialog covers them all; if that question fails, ask about
   * the one the refusal named, which the database itself asked for.
   */
  async function askRights(model: string, subjects: { key: RightsSubjectKey; id: string }[], refused: MissingAcknowledgement) {
    const subjectKeys = Object.fromEntries(subjects.map((s) => [s.id, s.key]));
    setRightsAck({ phase: "checking" });
    let missing: MissingAcknowledgement[] = [refused];
    try {
      const q = new URLSearchParams({ org_id: orgId, model, subjects: subjects.map((s) => s.id).join(",") });
      const res = await fetch(`/api/creative/acknowledgements?${q.toString()}`, { cache: "no-store" });
      const status = res.ok ? parseStatus(await res.json().catch(() => null)) : null;
      if (status && status.missing.some((m) => m.kind === refused.kind && m.subject === refused.subject)) missing = status.missing;
    } catch {
      // The refusal's own pair stands.
    }
    setRightsAck({ phase: "ask", missing, subjectKeys });
  }

  async function generate() {
    if (quote.status !== "ready" || submitting || !ready || quoteSpent || pressing.current || rightsAck) return;
    // Auto sends back the model its quote named; otherwise the picked model.
    const pressModel = routed ? quote.routed?.model : effectiveModel;
    if (!pressModel) return;
    await startJob(pressModel, quote, params);
  }

  /** The job itself, for the model, the quote and the settings the person pressed with (the ones the dialog asked about). */
  async function startJob(pressModel: string, pressed: QuoteState, pressParams: Record<string, unknown>) {
    if (pressed.status !== "ready" || pressing.current) return;
    pressing.current = true;
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
          params: pressParams,
          idempotency_key: newIdempotencyKey(),
          // The price the person saw on the button: the ceiling, never more.
          max_credits: pressed.credits,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
      if (res.ok) {
        setNotice({ kind: "ok" });
        if (composer) setSpent(pressed);
        onCreated?.();
        // The hold was just placed: the header's credits (and the short-of-credits check below) read it now, not on the next page.
        void refreshCredits(orgId);
      } else {
        const code = asCreativeError(body.error);
        const detail = typeof body.detail === "string" ? body.detail : undefined;
        // 0174: the model needs this person to take responsibility for an input first. The database refused before pricing or
        // holding anything; the dialog asks, records, and this same press (model, price, settings) is sent again.
        const refused = code === "acknowledgement_required" ? parseRefusalDetail(detail) : null;
        if (refused) {
          const subjects = inputSubjects(pressParams);
          ackPress.current = { model: pressModel, pressed, params: pressParams, subjects };
          void askRights(pressModel, subjects, refused);
          return;
        }
        setNotice({ kind: "error", code, ...(detail ? { detail } : {}) });
        if (code === "price_changed" || code === "route_changed") setRequote((n) => n + 1);
        // The balance this page knew was not the database's: read it again.
        if (code === "insufficient_credits") void refreshCredits(orgId);
        // A model no plan opens gets no plan dialog (it would offer plans that do not open it): the sentence says so.
        // Under Auto the hand-picked model is not the one refused: only the database's sentence tells.
        const noOffer =
          code === "entitlement_required" && entitlementReason(routed ? undefined : current?.entitlement, detail) === "not_on_sale";
        if (plans && isUpsellCode(code) && !noOffer) setUpsell({ refusal: refusalFrom(code, body), open: true });
      }
    } catch {
      setNotice({ kind: "error", code: "failed" });
    } finally {
      pressing.current = false;
      setSubmitting(false);
    }
  }

  const disabled =
    submitting || quote.status !== "ready" || !ready || quoteSpent || !!locked || noLength || (routed ? !quote.routed : !effectiveModel);
  const errorCode = notice?.kind === "error" ? notice.code : quote.status === "error" ? quote.code : null;
  const errorDetail = notice?.kind === "error" ? notice.detail : quote.status === "error" ? quote.detail : undefined;
  // An entitlement refusal in its own words: a first purchase opens it, or nothing does yet (entitlementReason).
  const entReason =
    errorCode === "entitlement_required" ? entitlementReason(routed ? undefined : current?.entitlement, errorDetail) : null;
  // The price is more than the credits this organization has available (lib/credits-live, the header's reading): the key says
  // how many are missing and opens the top-ups instead of pressing into a refusal. The database's 402 stays the backstop.
  const live = useLiveCredits(orgId);
  const shortBy =
    quote.status === "ready" && !submitting && live && quote.credits > live.available ? quote.credits - live.available : null;
  const isVoice = capability === "tts";
  const sourced = needsSource(capability);
  const recorded = needsRecording(capability);
  const filmed = needsVideo(capability);
  const words = promptRule(capability);
  const blocked = blockedReason(form, !!effectiveModel);
  // An AI edit tool nobody sells yet (no proven, priced model): the plain truth, not a generic "no model".
  const blockedText = pickedOff
    ? t.modelSwitch.studio.offBody
    : noLength && current
      ? fmt(t.gen.noLength, { model: current.displayName })
      : blocked === "no_model" && isAiEdit(capability)
      ? t.gen.notAvailableYet
      : blocked
        ? t.gen.blocked[blocked]
        : null;

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
        className={composer ? "sc-tool" : arrange ? "desk-tool" : "studio-tab"}
      >
        <Icon aria-hidden className={composer ? "size-4 shrink-0" : "size-[18px] shrink-0"} strokeWidth={1.75} />
        {composer ? (
          <span className="truncate">{t.desk.tools[c]}</span>
        ) : arrange ? (
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

  // A long list (a model with 16 lengths or 9 shapes) is one select rather than a row of keys that would wrap off a phone.
  function choice<T extends string | number>(
    groupLabel: string,
    Icon: LucideIcon | null,
    values: readonly T[],
    value: T,
    set: (v: T) => void,
    text: (v: T) => ReactNode,
    label: (v: T) => string,
    mono = false,
  ) {
    if (values.length <= 6) return seg(groupLabel, Icon, values, value, set, text, mono);
    return (
      <label className="studio-seg studio-seg-select">
        {Icon && <Icon aria-hidden className="mx-1.5 size-3.5 text-[var(--color-muted)]" />}
        <span className="sr-only">{groupLabel}</span>
        <select
          value={String(value)}
          onChange={(e) => {
            const next = values.find((v) => String(v) === e.target.value);
            if (next !== undefined) {
              set(next);
              edited();
            }
          }}
          className={mono ? "tnum" : undefined}
        >
          {values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {label(v)}
            </option>
          ))}
        </select>
      </label>
    );
  }

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
    (capability === "t2i" && !shapeless && shapeList.length > 0) ||
    capability === "t2v" ||
    capability === "i2v" ||
    capability === "upscale" ||
    (filmed && targets.length > 0) ||
    (takesShape(capability) && shapes.length > 0);
  // On a desk the keys say more than the bare value: the shape drawn, the
  // length as a counter. Same values, same buttons, same group names.
  const aspectText = (a: string): ReactNode =>
    arrange ? (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="desk-shape" data-shape={a} style={shapeGlyph(a)} />
        {a}
      </span>
    ) : (
      a
    );
  const durationText = (d: number): ReactNode =>
    arrange ? <Timecode value={d} format="duration" label={fmt(t.gen.seconds, { n: d })} /> : fmt(t.gen.seconds, { n: d });
  const settings = hasSettings ? (
    <div className="flex flex-wrap items-center gap-2">
      {textShape &&
        !shapeless &&
        shapeList.length > 0 &&
        choice(t.gen.aspectLabel, arrange ? null : RectangleHorizontal, shapeList, effectiveAspect, setAspect, aspectText, (a) => a, true)}
      {clip &&
        lengths.length > 0 &&
        choice(t.gen.durationLabel, Clock, lengths, effectiveSeconds, setDuration, durationText, (d) => fmt(t.gen.seconds, { n: d }))}
      {clip &&
        resolutions.length > 1 &&
        shownRes &&
        choice(
          t.gen.resolutionLabel,
          MonitorPlay,
          resolutions,
          shownRes,
          setResolution,
          (r) => resolutionLabel(r),
          (r) => (r === defaultRes ? fmt(t.gen.resolutionDefault, { r: resolutionLabel(r) }) : resolutionLabel(r)),
          true,
        )}
      {routed && (textShape || clip) && (
        <span className="basis-full text-xs text-[var(--color-muted)]" data-testid="gen-auto-settings">
          {t.gen.autoSettingsNote}
        </span>
      )}
      {snapText && !composer && (
        <span className="basis-full text-xs text-[var(--color-muted)]" data-testid="gen-snap-note" aria-live="polite">
          {snapText}
        </span>
      )}
      {capability === "upscale" &&
        seg(t.gen.factorLabel, Maximize2, UPSCALE_FACTORS, factor, setFactor, (f) => fmt(t.gen.factor, { n: f }))}
      {filmed &&
        effectiveTarget &&
        seg(t.gen.targetLabel, Maximize2, targets, effectiveTarget, setTarget, (v) => v.replace(/k$/, "K"), true)}
      {takesShape(capability) &&
        effectiveShape &&
        seg(
          capability === "video_reframe" ? t.gen.reframeLabel : t.gen.shapeLabel,
          arrange ? null : RectangleHorizontal,
          shapes,
          effectiveShape,
          setShape,
          aspectText,
          true,
        )}
    </div>
  ) : null;
  const ToolIcon = TOOL_ICONS[capability];

  // ── the blocks: one of each field, arranged per desk below ─────────────────

  const tabsBlock = composer ? (
    // The mode's tools as one quiet row (the mode itself is the page's choice above the box).
    tools.length > 1 ? (
      <div role="tablist" aria-label={t.gen.kindLabel} className="sc-tools" data-testid="composer-tools">
        {tools.map(tab)}
      </div>
    ) : null
  ) : arrange ? (
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
  // The maker's required credit line for the model that will make it (Runway: "Powered by Runway"). Auto's is known only once the
  // quote names its pick; until then no line is guessed.
  const makerLine = routed
    ? quote.status === "ready" && quote.routed
      ? models.find((m) => m.id === quote.routed?.model)?.attribution
      : undefined
    : current?.attribution;
  // The model: what will make it, how fast, how good — and a way to change it.
  const modelBlock = pickedOff ? (
    <div className="studio-field flex items-center gap-3 p-3" data-testid="gen-model-off">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="studio-label">{t.gen.modelLabel}</span>
        <span className="text-sm font-semibold text-[var(--color-fg)]">{t.modelSwitch.studio.offTitle}</span>
        <span className="text-xs text-[var(--color-muted)]">{t.modelSwitch.studio.offBody}</span>
      </span>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        ref={changeRef}
        disabled={available.length === 0}
        onClick={() => setSheetOpen(true)}
        className="tap press min-h-10 shrink-0 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)] disabled:opacity-60"
      >
        {t.modelSwitch.studio.offChoose}
      </button>
    </div>
  ) : current ? (
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
            {current.lock && (
              <span className="studio-lock shrink-0" data-testid="gen-model-lock">
                <Lock aria-hidden className="size-3" />
                {t.gen.lock[current.lock]}
              </span>
            )}
            {current.beta && (
              <span className="shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--color-border)] px-1.5 py-px text-xs font-medium text-[var(--color-muted)]">
                {t.gen.beta}
              </span>
            )}
            {current.preview && (
              <span
                title={t.gen.previewHint}
                data-testid="gen-model-preview"
                className="shrink-0 rounded-[var(--ns-r-chip)] border border-[var(--ns-amber-ink)] px-1.5 py-px text-xs font-medium text-[var(--ns-amber-ink)]"
              >
                {t.gen.preview}
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
        className="tap press min-h-10 shrink-0 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)]"
      >
        {t.gen.modelChange}
      </button>
    </div>
  ) : (
    <p className="studio-field p-3 text-sm text-[var(--color-muted)]" data-testid="gen-no-model">
      {isAiEdit(capability) ? t.gen.notAvailableYet : t.gen.noModels}
    </p>
  );

  // Image and Enhance lay the picture on the table, large; elsewhere it is a thumbnail.
  const wellPicture = arrange === "image" || arrange === "enhance";
  const sourceBlock = sourced ? (
    <div className="flex flex-col gap-2">
      <span className="studio-label">{arrange === "video" ? t.desk.startFrame : t.gen.sourceLabel}</span>
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
        {capability === "describe"
          ? t.gen.describeNote
          : capability === "expand"
            ? t.gen.expandNote
            : capability === "relight"
              ? t.gen.relightNote
              : capability === "erase"
                ? t.gen.eraseNote
                : t.gen.keepsShape}
      </span>
      {isPictureOp(capability) && <span className="text-xs text-[var(--color-muted)]">{t.gen.aiEditNote}</span>}
    </div>
  ) : null;

  // A relight is asked for by a named light OR by words, never both: a chip clears the words, typing clears the chip.
  const lookBlock =
    capability === "relight" && looks.length > 0 ? (
      <div className="flex flex-col gap-2" data-testid="gen-looks">
        <span className="studio-label" id="gen-look-label">
          {t.gen.lookLabel}
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby="gen-look-label">
          {RELIGHT_LOOKS.filter((l) => looks.includes(l)).map((l) => (
            <button
              key={l}
              type="button"
              data-testid={`gen-look-${l}`}
              aria-pressed={effectiveLook === l && !prompt.trim()}
              onClick={() => {
                setLook(l);
                setPrompt("");
                edited();
              }}
              className="studio-chip"
            >
              {t.gen.looks[l]}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--color-muted)]">{t.gen.lookOrWords}</span>
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
      <span className="text-xs text-[var(--color-muted)]">
        {capability === "video_upscale" ? t.gen.videoUpscaleNote : t.gen.videoOpNotes[capability as "video_edit" | "video_reframe" | "video_remove_bg"]}
      </span>
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
      arrange === "voice" ? (
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
  const settingsInField = arrange !== "enhance";
  const promptBlock =
    words !== "none" ? (
      <div className="flex flex-col gap-2">
        <label htmlFor="gen-prompt" className="studio-label">
          {isVoice
            ? arrange === "voice"
              ? t.desk.script
              : t.gen.voiceTextLabel
            : isAiEdit(capability)
              ? (t.gen.opWords as Record<string, string>)[capability]
              : arrange === "video"
                ? t.desk.shot
                : t.gen.promptLabel}
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
            rows={isVoice ? (arrange === "voice" ? 10 : 6) : isAiEdit(capability) ? 2 : 4}
            maxLength={wordsMax(capability)}
            autoFocus={initial !== null}
            placeholder={t.gen.promptPh[capability]}
            className={`${arrange === "voice" && isVoice ? "desk-script " : ""}${isVoice ? "" : "studio-shot "}min-h-[104px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-base leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus-visible:outline-none sm:text-[14px]`}
          />
          {settings && settingsInField && <div className="px-2 pb-2">{settings}</div>}
          {arrange === "voice" && isVoice && (
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
        <span className="studio-label">
          {capability === "upscale"
            ? t.gen.factorLabel
            : capability === "expand"
              ? t.gen.shapeLabel
              : capability === "video_reframe"
                ? t.gen.reframeLabel
                : t.gen.targetLabel}
        </span>
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

  // What the press will do, or why it cannot: the same words under the panel's key and the composer's.
  const status = (
    <p id="gen-status" className={`min-h-[18px] text-xs${arrange || composer ? "" : " text-center"}`} aria-live="polite">
      {notice?.kind === "ok" ? (
        <span className="text-[var(--color-ok)]">{t.gen.started}</span>
      ) : locked || entReason ? (
        // A model this organization cannot buy: why, in words that match what the database does — not a red failure.
        <span className="text-[var(--color-muted)]" data-testid="gen-locked" data-lock={locked ?? entReason ?? undefined}>
          {t.gen.lockWhy[(locked ?? entReason) as ModelLock]}
          {(locked ?? entReason) === "first_purchase" && (
            <>
              {" "}
              <Link href={path(UPSELL_LINKS.topups)} className="tap-link text-[var(--color-primary)] underline">
                {t.gen.lockBuy}
              </Link>
            </>
          )}
        </span>
      ) : shortBy !== null ? (
        <span className="text-[var(--color-muted)]" data-testid="gen-short-note">
          {t.gen.needMoreNote}
        </span>
      ) : errorCode ? (
        <span className="text-[var(--color-fail)]">
          {/* 0175: how many failed, the limit and when it frees, from the database's detail (no number without it). */}
          {errorCode === "failed_job_limit" ? failedJobLimitText(t, errorDetail) : apiErrorMessage(t, errorCode)}
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
  );

  // Short of credits: the price key's look, as a link to the top-ups. It names how many credits are missing and still shows the
  // database's price; nothing is pressed into a refusal (the 402 dialog stays the backstop for a balance read before a change).
  const shortKey = (size: "lg" | "md") => (
    <Link
      href={path(UPSELL_LINKS.topups)}
      className={`ns-price-button${size === "md" ? " sc-send" : ""}`}
      data-size={size}
      data-testid="gen-need-credits"
      aria-describedby="gen-status"
      aria-label={
        live && quote.status === "ready"
          ? fmt(t.gen.needMoreLabel, { cost: formatCredits(quote.credits, locale), available: formatCredits(live.available, locale) })
          : undefined
      }
    >
      <span className="ns-price-label">
        <Plus aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
        {/* Wraps rather than cuts: the number missing is the point of this key. */}
        <span className="min-w-0 whitespace-normal text-left leading-tight">{fmt(t.gen.needMore, { n: formatCredits(shortBy ?? 0, locale) })}</span>
      </span>
      {quote.status === "ready" && (
        <span className="ns-price-tag" data-testid="price-tag">
          <Timecode value={quote.credits} locale={locale} unit={creditUnit(quote.credits, locale, t.shell.creditUnit)} />
        </span>
      )}
    </Link>
  );

  const dockBlock = (
    <div className="studio-dock flex flex-col gap-2" data-testid="gen-dock" data-at-top={dockAtTop ? "true" : undefined}>
      {/* The price key (components/ui/PriceButton): the action and the
          database's quote as two legends; its name is the same sentence.
          Short of credits, the same key opens the top-ups and says how many are missing. */}
      {shortBy !== null && quote.status === "ready" ? (
        shortKey("lg")
      ) : (
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
      )}
      {status}
      <ModelAttribution attribution={makerLine} className="self-center" />
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
          buyHref={path(UPSELL_LINKS.topups)}
          pricedAt={pricedAt}
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

      {rightsAck && (
        <RightsAcknowledgementDialog
          state={rightsAck}
          onAcknowledged={() => {
            const p = ackPress.current;
            setRightsAck(null);
            ackPress.current = null;
            if (p) void startJob(p.model, p.pressed, p.params);
          }}
          onClose={() => {
            setRightsAck(null);
            ackPress.current = null;
          }}
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

  if (composer) {
    const th = t.studioHome;
    // The mode's tool that starts from nothing (Image's new picture, Video's clip from words, Voice's speech), if it has one.
    const textTool = tools.find((c) => startsFrom(c) === null) ?? null;
    const from = startsFrom(capability);
    // [+] starts from a file: this mode's first picture tool, else its first tool that takes a file.
    const attachTool =
      from !== null ? null : (tools.find((c) => startsFrom(c) === "picture") ?? tools.find((c) => startsFrom(c) !== null) ?? null);
    const attachment = sourceBlock ?? videoSourceBlock ?? recordingBlock;
    const detach = () => {
      if (!textTool) return;
      setSourceId(null);
      setEndFrameId(null);
      setCapability(textTool);
      edited();
    };
    // The settings key's own words: what is set now (the shape, the length, the size), never a price.
    const summary = [
      textShape && !shapeless && shapeList.length > 0 ? effectiveAspect : null,
      clip ? fmt(t.gen.seconds, { n: effectiveSeconds }) : null,
      effectiveRes ? resolutionLabel(effectiveRes) : null,
      capability === "upscale" ? fmt(t.gen.factor, { n: factor }) : null,
      effectiveTarget ? effectiveTarget.replace(/k$/, "K") : null,
      effectiveShape,
    ]
      .filter(Boolean)
      .join(" · ");
    const modelName = routed
      ? autoLine
        ? autoLine.picked
        : quote.status === "quoting"
          ? t.gen.router.picking
          : t.gen.router.auto
      : pickedOff
        ? t.modelSwitch.studio.offTitle
        : (current?.displayName ?? th.modelNone);
    // The model's facts and Auto, folded with the settings (the bar's model key changes the model).
    const modelFacts = current ? (
      <div className="flex flex-col gap-2" data-testid="composer-model-facts">
        <span className="studio-label">{t.gen.modelLabel}</span>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-[var(--color-fg)]">{routed ? modelName : current.displayName}</span>
          {current.beta && !routed && (
            <span className="rounded-[var(--ns-r-chip)] border border-[var(--color-border)] px-1.5 py-px text-xs font-medium text-[var(--color-muted)]">
              {t.gen.beta}
            </span>
          )}
          {!routed && <TierMarks speed={current.speedTier ?? null} quality={current.qualityTier ?? null} />}
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
              className="studio-chip tap press font-medium"
            >
              {t.gen.router.auto}
            </button>
          )}
        </div>
        {autoLine?.why && <span className="text-xs text-[var(--color-muted)]">{autoLine.why}</span>}
      </div>
    ) : null;
    const folded = [
      settings && (
        <div key="settings" className="flex flex-col gap-2">
          <span className="studio-label">{th.settings}</span>
          {settings}
        </div>
      ),
      describeLangBlock,
      endFrameBlock,
      qualityBlock,
      soundBlock,
      styleBlock,
      modelFacts,
      dnaBlock,
    ].filter(Boolean);
    const sendLabel = submitting
      ? t.gen.starting
      : quote.status === "quoting"
        ? t.gen.quoting
        : capability === "describe"
          ? t.gen.describe
          : t.gen.generate;

    return (
      <section className="studio-surface sc-composer" aria-labelledby="gen-title" data-testid="composer" data-capability={capability}>
        {title}
        {tabsBlock}
        {panel(
          "sc-body",
          <>
            {attachment && (
              <div className="sc-attach" data-testid="composer-attachment">
                {attachment}
                {textTool && (
                  <button type="button" onClick={detach} className="sc-detach tap-icon press" aria-label={th.attachRemove} title={th.attachRemove}>
                    <X aria-hidden className="size-4" />
                  </button>
                )}
              </div>
            )}
            {voiceBlock}
            {dubLangBlock}
            {lookBlock}
            {words !== "none" && (
              <>
                <label htmlFor="gen-prompt" className="sr-only">
                  {isVoice ? t.gen.voiceTextLabel : isAiEdit(capability) ? (t.gen.opWords as Record<string, string>)[capability] : t.gen.promptLabel}
                  {words === "optional" ? ` · ${t.gen.optional}` : ""}
                </label>
                <textarea
                  id="gen-prompt"
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    edited();
                  }}
                  onKeyDown={(e) => {
                    // Enter is the send key (the same priced press); Shift+Enter is a new line, and an IME's Enter only picks a word.
                    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    // A held Enter repeats: only the first keydown may press.
                    if (e.repeat) return;
                    if (!disabled && shortBy === null) void generate();
                  }}
                  rows={3}
                  maxLength={wordsMax(capability)}
                  autoFocus={autoFocusPrompt ?? initial !== null}
                  placeholder={t.gen.promptPh[capability]}
                  aria-describedby="gen-status sc-enter-hint"
                  className="sc-input"
                />
              </>
            )}
            {takesStyle(capability) && words !== "none" && (
              <span className="sr-only">{t.gen.mentionHint}</span>
            )}
            {/* Always in the DOM (hidden when folded), so the settings key's aria-controls names a real element. */}
            {folded.length > 0 && (
              <div id="gen-settings" className="sc-settings" data-testid="composer-settings" hidden={!settingsOpen}>
                {settingsOpen &&
                  folded.map((node, i) => (
                    <Fragment key={i}>{node}</Fragment>
                  ))}
              </div>
            )}
          </>,
        )}
        <div className="sc-bar">
          <div className="sc-bar-start">
            {onAttachFile ? (
              <>
                <button
                  type="button"
                  className="sc-key tap-icon press"
                  aria-label={th.attachFlow.pick}
                  title={th.attachFlow.pick}
                  data-testid="composer-attach"
                  disabled={attachBusy}
                  aria-busy={attachBusy || undefined}
                  onClick={(e) => {
                    // Focus leaves the words here on every browser (Safari does not focus a clicked button): the page reads a focused
                    // words box at the upload's end as "still typing" and then does not swap the box (StudioHome attachFile).
                    e.currentTarget.focus();
                    filePicker.current?.click();
                  }}
                >
                  <Plus aria-hidden className="size-[18px]" />
                </button>
                {/* The system picker, a picture or a video. No `capture`: nothing asks for the camera or the microphone. */}
                <input
                  ref={filePicker}
                  type="file"
                  accept={ATTACH_ACCEPT}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  data-testid="composer-file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) onAttachFile(file);
                  }}
                />
              </>
            ) : (
              attachTool && (
                <button
                  type="button"
                  className="sc-key tap-icon press"
                  aria-label={th.attach[desk ?? "image"]}
                  title={th.attach[desk ?? "image"]}
                  data-testid="composer-attach"
                  onClick={() => pick(attachTool)}
                >
                  <Plus aria-hidden className="size-[18px]" />
                </button>
              )
            )}
            <button
              type="button"
              ref={changeRef}
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              aria-label={fmt(th.modelButton, { name: modelName })}
              disabled={available.length === 0}
              onClick={() => setSheetOpen(true)}
              className="sc-pill tap press"
              data-testid="composer-model"
              data-off={pickedOff ? "true" : undefined}
            >
              <ToolIcon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{modelName}</span>
              <ChevronDown aria-hidden className="size-3.5 shrink-0 opacity-70" />
            </button>
            {folded.length > 0 && (
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls="gen-settings"
                aria-label={settingsOpen ? th.settingsClose : summary ? fmt(th.settingsFor, { summary }) : th.settings}
                title={th.settings}
                onClick={() => setSettingsOpen((o) => !o)}
                className="sc-pill tap press"
                data-testid="composer-settings-key"
              >
                <Settings2 aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                {summary && <span className="sc-pill-sub tnum">{summary}</span>}
              </button>
            )}
            {composerExtra}
          </div>
          {shortBy !== null && quote.status === "ready" ? (
            shortKey("md")
          ) : (
          <PriceButton
            ref={generateRef}
            disabled={disabled}
            onClick={generate}
            aria-busy={submitting || quote.status === "quoting"}
            aria-describedby="gen-status"
            aria-label={submitting ? t.gen.starting : generateLabel(t, quote, locale, capability)}
            label={<span className="sc-send-word">{sendLabel}</span>}
            credits={!submitting && quote.status === "ready" ? quote.credits : null}
            unit={quote.status === "ready" ? creditUnit(quote.credits, locale, t.shell.creditUnit) : undefined}
            locale={locale}
            size="md"
            className="sc-send"
            icon={<ArrowUp aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />}
          />
          )}
        </div>
        {attachNote && <div className="sc-foot sc-attach-note">{attachNote}</div>}
        <div className="sc-foot">
          {status}
          <span id="sc-enter-hint" className="sc-hint">
            {th.enterHint}
          </span>
        </div>
        {snapText && (
          // The composer folds its settings away: the change is said under the box, where it is seen.
          <div className="sc-foot">
            <span className="text-xs text-[var(--color-muted)]" data-testid="gen-snap-note" aria-live="polite">
              {snapText}
            </span>
          </div>
        )}
        {makerLine && (
          <div className="sc-foot">
            <ModelAttribution attribution={makerLine} />
          </div>
        )}
        {dialogs}
      </section>
    );
  }

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
                {lookBlock}
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
            {lookBlock}
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
          {lookBlock}
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
