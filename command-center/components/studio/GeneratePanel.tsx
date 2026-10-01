"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { AtSign, Clock, Languages, Maximize2, RectangleHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { ModelSheet } from "@/components/studio/ModelSheet";
import { TierMarks } from "@/components/studio/TierMarks";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { useModelPrices } from "@/components/studio/useModelPrices";
import { useStyleKits } from "@/components/studio/useStyleKits";
import { PlanUpsellDialog } from "@/components/studio/PlanUpsellDialog";
import { isUpsellCode, refusalFrom, type Refusal, type UpsellCatalog } from "@/lib/upsell";
import { UPSCALE_FACTORS, type CreativeError } from "@/lib/creative/operations";
import {
  ASPECT_RATIOS,
  COMPOSER_CAPABILITIES,
  DUB_LANGUAGES,
  PROMPT_MAX,
  STUDIO_VOICES,
  VIDEO_DURATIONS,
  apiErrorMessage,
  asCreativeError,
  blockedReason,
  buildParams,
  canQuote,
  errorAction,
  generateLabel,
  modelsFor,
  needsRecording,
  needsSource,
  needsVideo,
  newIdempotencyKey,
  promptRule,
  sheetQuoteParams,
  takesStyle,
  type AspectRatio,
  type DubLanguage,
  type QuoteState,
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
const MAKE_KINDS = COMPOSER_CAPABILITIES.filter((c) => startsFrom(c) === null);
/** The picture tools (0046), the voice tools (0050) and the video tools (0052): each starts from something in the library. */
const MEDIA_TOOLS = COMPOSER_CAPABILITIES.filter((c) => startsFrom(c) !== null);

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
 * Images and videos can take one of the organization's style kits (0048),
 * the channel's default kit picked to start with; a style adds no credits.
 * @names in the words stay as typed — the worker brings in the characters.
 */
export function GeneratePanel({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
  sourceRequest = null,
  plans,
  onCreated,
}: {
  orgId: string;
  models: StudioModel[];
  /** "Try again" from the feed, a template, or the Library link: fills the form; spends nothing by itself. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), picked to start with when it is one of the org's kits. */
  defaultStyleKitId?: string | null;
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

  const [capability, setCapability] = useState<StudioCapability>(
    initial?.capability ?? COMPOSER_CAPABILITIES.find((c) => modelsFor(models, c).length > 0) ?? "t2i",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [aspect, setAspect] = useState<AspectRatio>(initial?.aspect ?? "16:9");
  const [duration, setDuration] = useState<VideoDuration>(initial?.duration ?? 5);
  const [model, setModel] = useState(initial?.model ?? "");
  const [sourceId, setSourceId] = useState<string | null>(initial?.sourceId ?? null);
  const [factor, setFactor] = useState<UpscaleFactor>(initial?.factor ?? 2);
  // A retried job keeps its own choice (even "none"); a fresh form starts from the channel's look.
  const [styleKitId, setStyleKitId] = useState<string | null>(
    initial && "styleKitId" in initial ? (initial.styleKitId ?? null) : defaultStyleKitId,
  );
  // Speech and a voice change speak in a voice the person picks; a dub in a language they pick. None is defaulted.
  const [voiceId, setVoiceId] = useState<string | null>(initial?.voiceId ?? null);
  const [targetLanguage, setTargetLanguage] = useState<DubLanguage | null>(initial?.targetLanguage ?? null);
  // 0052: the picture an animation ends on (optional), and the size a video upscale makes.
  const [endFrameId, setEndFrameId] = useState<string | null>(initial?.endFrameId ?? null);
  const [endOpen, setEndOpen] = useState(false);
  const [target, setTarget] = useState<UpscaleTarget | null>(initial?.target ?? null);
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
  // The picked model if it can make this kind, else the first that can.
  const effectiveModel = available.some((m) => m.id === model) ? model : (available[0]?.id ?? "");
  const current = available.find((m) => m.id === effectiveModel) ?? null;
  // Only a kit the organization has (as loaded) is ever sent: a stale default
  // or a deleted kit reads as "None" rather than as a refusal at the price.
  const effectiveStyle = styles.state === "ready" && styles.kits.some((k) => k.id === styleKitId) ? styleKitId : null;
  // An end frame goes only to a model that ends a clip on it; another model
  // keeps the pick but is never sent it (the database would refuse it).
  const takesEnd = capability === "i2v" && current?.endFrame === true;
  const effectiveEnd = takesEnd ? endFrameId : null;
  // The size: the one picked if this model makes it, else the model's first.
  const targets = current?.upscaleTargets ?? [];
  const effectiveTarget = capability !== "video_upscale" ? null : target && targets.includes(target) ? target : (targets[0] ?? null);
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
      }),
    [capability, prompt, aspect, duration, sourceId, factor, effectiveStyle, voiceId, targetLanguage, effectiveEnd, effectiveTarget],
  );
  const paramsKey = JSON.stringify(params);
  // A price is asked for only once the form is complete (the picture, the words).
  const ready = canQuote(form);

  useEffect(() => {
    if (!ready || !effectiveModel) {
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
          body: JSON.stringify({ org_id: orgId, capability, model: effectiveModel, params: JSON.parse(paramsKey) }),
          signal: ctrl.signal,
        });
        const body = (await res.json().catch(() => ({}))) as { quote?: { credits?: unknown }; error?: unknown };
        const credits = body.quote?.credits;
        if (res.ok && typeof credits === "number" && Number.isFinite(credits)) setQuote({ status: "ready", credits });
        else setQuote({ status: "error", code: asCreativeError(body.error) });
      } catch {
        if (!ctrl.signal.aborted) setQuote({ status: "error", code: "failed" });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [orgId, capability, effectiveModel, paramsKey, ready, requote]);

  // "Use as picture": applied once per request, never on the mount that a
  // template or Try again caused (that request was already used or cleared).
  const appliedSource = useRef(sourceRequest?.nonce ?? 0);
  useEffect(() => {
    if (!sourceRequest || sourceRequest.nonce === appliedSource.current) return;
    appliedSource.current = sourceRequest.nonce;
    setSourceId(sourceRequest.id);
    setCapability((c) => (needsSource(c) ? c : "edit"));
    setNotice(null);
  }, [sourceRequest]);

  // The sheet's prices: the same settings, each model, only while it is open.
  const sheetParams = sheetOpen ? sheetQuoteParams(form) : null;
  const prices = useModelPrices({
    open: sheetOpen,
    orgId,
    capability,
    modelIds: available.map((m) => m.id),
    selectedId: effectiveModel,
    params: sheetParams,
  });

  const edited = () => setNotice(null);

  async function generate() {
    if (quote.status !== "ready" || submitting || !effectiveModel || !ready) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/creative/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          org_id: orgId,
          capability,
          model: effectiveModel,
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
        if (code === "price_changed") setRequote((n) => n + 1);
        if (plans && isUpsellCode(code)) setUpsell({ refusal: refusalFrom(code, body), open: true });
      }
    } catch {
      setNotice({ kind: "error", code: "failed" });
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || quote.status !== "ready" || !ready || !effectiveModel;
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
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, c: StudioCapability) {
    const i = COMPOSER_CAPABILITIES.indexOf(c);
    const n = COMPOSER_CAPABILITIES.length;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    const next = COMPOSER_CAPABILITIES[to];
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
        tabIndex={on ? 0 : -1}
        onClick={() => pick(c)}
        onKeyDown={(e) => onTabKey(e, c)}
        className="studio-tab"
      >
        <Icon aria-hidden className="size-[18px]" strokeWidth={1.75} />
        <span className="max-w-full truncate">{t.gen.tabs[c]}</span>
      </button>
    );
  };

  function seg<T extends string | number>(
    groupLabel: string,
    Icon: LucideIcon,
    values: readonly T[],
    value: T,
    set: (v: T) => void,
    text: (v: T) => string,
    mono = false,
  ) {
    return (
      <div className="studio-seg" role="group" aria-label={groupLabel}>
        <Icon aria-hidden className="mx-1.5 size-3.5 text-[var(--color-muted)]" />
        {values.map((v) => (
          <button
            key={String(v)}
            type="button"
            aria-pressed={value === v}
            onClick={() => {
              set(v);
              edited();
            }}
            className={mono ? "mono" : undefined}
          >
            {text(v)}
          </button>
        ))}
      </div>
    );
  }

  const hasSettings =
    capability === "t2i" || capability === "t2v" || capability === "i2v" || capability === "upscale" || (filmed && targets.length > 0);
  const settings = hasSettings ? (
    <div className="flex flex-wrap items-center gap-2">
      {(capability === "t2i" || capability === "t2v") &&
        seg(t.gen.aspectLabel, RectangleHorizontal, ASPECT_RATIOS, aspect, setAspect, (a) => a, true)}
      {(capability === "t2v" || capability === "i2v") &&
        seg(t.gen.durationLabel, Clock, VIDEO_DURATIONS, duration, setDuration, (d) => fmt(t.gen.seconds, { n: d }))}
      {capability === "upscale" &&
        seg(t.gen.factorLabel, Maximize2, UPSCALE_FACTORS, factor, setFactor, (f) => fmt(t.gen.factor, { n: f }))}
      {filmed &&
        effectiveTarget &&
        seg(t.gen.targetLabel, Maximize2, targets, effectiveTarget, setTarget, (v) => v.replace(/k$/, "K"), true)}
    </div>
  ) : null;
  const ToolIcon = TOOL_ICONS[capability];

  return (
    <section className="studio-surface flex flex-col gap-4 p-4" aria-labelledby="gen-title">
      <h2 id="gen-title" className="sr-only">
        {t.gen.title}
      </h2>

      <div role="tablist" aria-label={t.gen.kindLabel} className="flex flex-col gap-1">
        <div role="presentation" className="grid grid-cols-3 gap-1">
          {MAKE_KINDS.map(tab)}
        </div>
        <div role="presentation" className="mx-1 my-0.5 h-px bg-[var(--color-border)]" />
        <div role="presentation" className="grid grid-cols-3 gap-1">
          {MEDIA_TOOLS.map(tab)}
        </div>
      </div>

      <div role="tabpanel" id="gen-tabpanel" aria-labelledby={`gen-tab-${capability}`} className="flex flex-col gap-4">
        {/* The model: what will make it, how fast, how good — and a way to change it. */}
        {current ? (
          <div className="studio-field flex items-center gap-3 p-3">
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]"
            >
              <ToolIcon className="size-5" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="studio-label">{t.gen.modelLabel}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[14px] font-semibold text-[var(--color-fg)]" data-testid="gen-model-name">
                  {current.displayName}
                </span>
                {current.beta && (
                  <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                    {t.gen.beta}
                  </span>
                )}
              </span>
              <TierMarks speed={current.speedTier ?? null} quality={current.qualityTier ?? null} />
            </span>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sheetOpen}
              aria-label={t.gen.modelChangeLabel}
              ref={changeRef}
              onClick={() => setSheetOpen(true)}
              className="tap press shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)]"
            >
              {t.gen.modelChange}
            </button>
          </div>
        ) : (
          <p className="studio-field p-3 text-[13px] text-[var(--color-muted)]">{t.gen.noModels}</p>
        )}

        {sourced && (
          <div className="flex flex-col gap-2">
            <span className="studio-label">{t.gen.sourceLabel}</span>
            <SourcePicker
              orgId={orgId}
              value={sourceId}
              compact
              onChange={(id) => {
                setSourceId(id);
                edited();
              }}
              libraryHref={path("/library")}
            />
            <span className="text-[12px] text-[var(--color-muted)]">{t.gen.keepsShape}</span>
          </div>
        )}

        {takesEnd && (
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
                  className="btn-sky is-quiet pill w-fit px-3 py-1.5 text-[12px]"
                >
                  {t.gen.endFrameRemove}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setEndOpen(true)} className="studio-chip w-fit">
                {t.gen.endFrameAdd}
              </button>
            )}
            <span className="text-[12px] text-[var(--color-muted)]">{t.gen.endFrameNote}</span>
          </div>
        )}

        {filmed && (
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
            <span className="text-[12px] text-[var(--color-muted)]">{t.gen.videoUpscaleNote}</span>
          </div>
        )}

        {recorded && (
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
            <span className="text-[12px] text-[var(--color-muted)]">
              {capability === "dub" ? t.gen.dubNote : t.gen.voiceChangeNote}
            </span>
          </div>
        )}

        {(capability === "voice_change" || capability === "tts") && (
          <div className="flex flex-col gap-2">
            <label htmlFor="gen-voice" className="studio-label">
              {capability === "tts" ? t.gen.ttsVoiceLabel : t.gen.voiceLabel}
            </label>
            <select
              id="gen-voice"
              value={voiceId ?? ""}
              onChange={(e) => {
                setVoiceId(e.target.value || null);
                edited();
              }}
              className="studio-field w-full px-3 py-2.5 text-[16px] text-[var(--color-fg)] outline-none sm:text-[14px]"
            >
              <option value="">{t.gen.voicePick}</option>
              {STUDIO_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.style}
                </option>
              ))}
            </select>
          </div>
        )}

        {capability === "dub" && (
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
        )}

        {words !== "none" ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="gen-prompt" className="studio-label">
              {isVoice ? t.gen.voiceTextLabel : t.gen.promptLabel}
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
                rows={isVoice ? 6 : 4}
                maxLength={PROMPT_MAX}
                autoFocus={initial !== null}
                placeholder={t.gen.promptPh[capability]}
                className="min-h-[104px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[16px] leading-relaxed text-[var(--color-fg)] outline-none placeholder:text-[var(--color-muted)] focus-visible:outline-none sm:text-[14px]"
              />
              {settings && <div className="px-2 pb-2">{settings}</div>}
            </div>
            {takesStyle(capability) && (
              <span className="flex items-start gap-1.5 text-[12px] text-[var(--color-muted)]">
                <AtSign aria-hidden className="mt-[1px] size-3.5 shrink-0" />
                {t.gen.mentionHint}
              </span>
            )}
          </div>
        ) : (
          settings
        )}

        {takesStyle(capability) && styles.state !== "unavailable" && (
          <div className="flex flex-col gap-2">
            <span className="studio-label">{t.gen.styleLabel}</span>
            {styles.state === "loading" ? (
              <div className="flex flex-wrap gap-2" aria-busy="true" aria-label={t.gen.styleLoading}>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="skeleton h-8 w-20 rounded-full" />
                ))}
              </div>
            ) : styles.state === "failed" ? (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-muted)]">
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
                  <span className="text-[12px] text-[var(--color-muted)]">
                    {t.gen.styleEmpty}{" "}
                    <Link href={path("/studio")} className="tap-link text-[var(--color-primary)] underline">
                      {t.gen.styleMake}
                    </Link>
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="studio-dock flex flex-col gap-2" data-testid="gen-dock">
        <button
          ref={generateRef}
          type="button"
          disabled={disabled}
          onClick={generate}
          aria-busy={submitting || quote.status === "quoting"}
          aria-describedby="gen-status"
          className="studio-cta"
        >
          <Sparkles aria-hidden className={`size-4${quote.status === "quoting" || submitting ? " pulse" : ""}`} />
          <span>{submitting ? t.gen.starting : generateLabel(t, quote, locale)}</span>
        </button>
        <p id="gen-status" className="min-h-[18px] text-center text-[12px]" aria-live="polite">
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
            <span className="text-[var(--color-muted)]">{t.gen.holdNote}</span>
          )}
        </p>
      </div>

      {sheetOpen && (
        <ModelSheet
          capability={capability}
          models={available}
          selectedId={effectiveModel}
          prices={prices}
          priceHint={sheetParams ? null : blockedText}
          onSelect={(id) => {
            setModel(id);
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
    </section>
  );
}
