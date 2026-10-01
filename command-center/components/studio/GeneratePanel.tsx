"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { AtSign, Clock, Maximize2, RectangleHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { ModelSheet } from "@/components/studio/ModelSheet";
import { TierMarks } from "@/components/studio/TierMarks";
import { TOOL_ICONS } from "@/components/studio/toolIcons";
import { useModelPrices } from "@/components/studio/useModelPrices";
import { useStyleKits } from "@/components/studio/useStyleKits";
import { UPSCALE_FACTORS, type CreativeError } from "@/lib/creative/operations";
import {
  ASPECT_RATIOS,
  PROMPT_MAX,
  STUDIO_CAPABILITIES,
  VIDEO_DURATIONS,
  apiErrorMessage,
  asCreativeError,
  blockedReason,
  buildParams,
  canQuote,
  errorAction,
  generateLabel,
  modelsFor,
  needsSource,
  newIdempotencyKey,
  promptRule,
  sheetQuoteParams,
  takesStyle,
  type AspectRatio,
  type QuoteState,
  type StudioCapability,
  type StudioModel,
  type StudioPrefill,
  type UpscaleFactor,
  type VideoDuration,
} from "@/lib/creative/studio";

const QUOTE_DELAY_MS = 500;

const MAKE_KINDS = STUDIO_CAPABILITIES.filter((c) => !needsSource(c));
const PICTURE_TOOLS = STUDIO_CAPABILITIES.filter((c) => needsSource(c));

/**
 * The Studio's composer. Make one image, video or voice (migration 0036), or
 * start from a library picture: edit, animate, upscale, cut out (0046). The
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
  onCreated?: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const path = useChannelPath();

  const [capability, setCapability] = useState<StudioCapability>(
    initial?.capability ?? STUDIO_CAPABILITIES.find((c) => modelsFor(models, c).length > 0) ?? "t2i",
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
  const styles = useStyleKits(orgId);
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [requote, setRequote] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" } | { kind: "error"; code: CreativeError } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<StudioCapability, HTMLButtonElement | null>>>({});

  const available = modelsFor(models, capability);
  // The picked model if it can make this kind, else the first that can.
  const effectiveModel = available.some((m) => m.id === model) ? model : (available[0]?.id ?? "");
  const current = available.find((m) => m.id === effectiveModel) ?? null;
  // Only a kit the organization has (as loaded) is ever sent: a stale default
  // or a deleted kit reads as "None" rather than as a refusal at the price.
  const effectiveStyle = styles.state === "ready" && styles.kits.some((k) => k.id === styleKitId) ? styleKitId : null;
  const form = { capability, prompt, aspect, duration, sourceId, factor, styleKitId: effectiveStyle };
  const params = useMemo(
    () => buildParams({ capability, prompt, aspect, duration, sourceId, factor, styleKitId: effectiveStyle }),
    [capability, prompt, aspect, duration, sourceId, factor, effectiveStyle],
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
  const words = promptRule(capability);
  const blocked = blockedReason(form, !!effectiveModel);
  const blockedText = blocked ? t.gen.blocked[blocked] : null;

  const pick = (c: StudioCapability) => {
    setCapability(c);
    edited();
  };

  // A tablist: ←/→ (and ↑/↓) move and choose, Home/End jump; one tab stop.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, c: StudioCapability) {
    const i = STUDIO_CAPABILITIES.indexOf(c);
    const n = STUDIO_CAPABILITIES.length;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    const next = STUDIO_CAPABILITIES[to];
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

  const hasSettings = capability === "t2i" || capability === "t2v" || capability === "i2v" || capability === "upscale";
  const settings = hasSettings ? (
    <div className="flex flex-wrap items-center gap-2">
      {(capability === "t2i" || capability === "t2v") &&
        seg(t.gen.aspectLabel, RectangleHorizontal, ASPECT_RATIOS, aspect, setAspect, (a) => a, true)}
      {(capability === "t2v" || capability === "i2v") &&
        seg(t.gen.durationLabel, Clock, VIDEO_DURATIONS, duration, setDuration, (d) => fmt(t.gen.seconds, { n: d }))}
      {capability === "upscale" &&
        seg(t.gen.factorLabel, Maximize2, UPSCALE_FACTORS, factor, setFactor, (f) => fmt(t.gen.factor, { n: f }))}
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
        <div role="presentation" className="grid grid-cols-4 gap-1">
          {PICTURE_TOOLS.map(tab)}
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
    </section>
  );
}
