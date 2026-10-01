"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { SourcePicker } from "@/components/studio/SourcePicker";
import { useStyleKits } from "@/components/studio/useStyleKits";
import { UPSCALE_FACTORS, type CreativeError } from "@/lib/creative/operations";
import {
  ASPECT_RATIOS,
  PROMPT_MAX,
  STUDIO_CAPABILITIES,
  VIDEO_DURATIONS,
  apiErrorMessage,
  asCreativeError,
  buildParams,
  canQuote,
  errorAction,
  generateLabel,
  modelsFor,
  needsSource,
  newIdempotencyKey,
  promptRule,
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

const chip = (on: boolean) =>
  `pill border px-3.5 py-2 text-[13px] transition-colors min-h-[36px] ${
    on
      ? "border-[var(--color-primary)] text-[var(--color-primary)]"
      : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
  }`;

const label = "text-[10px] uppercase tracking-[0.18em] text-[var(--color-muted)]";

/**
 * Make one image, video or voice (migration 0036), or start from a library
 * picture: edit, animate, upscale, remove the background (0046). The database prices it
 * (/api/creative/quote, debounced while typing); the price is on the button,
 * and pressing it sends exactly that price as `max_credits` — a higher price
 * is refused by the database, never charged. One idempotency key per press.
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
  onCreated,
}: {
  orgId: string;
  models: StudioModel[];
  /** "Try again" from the feed: fills the form; spends nothing by itself. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), picked to start with when it is one of the org's kits. */
  defaultStyleKitId?: string | null;
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

  const available = modelsFor(models, capability);
  // The picked model if it can make this kind, else the first that can.
  const effectiveModel = available.some((m) => m.id === model) ? model : (available[0]?.id ?? "");
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
  const pick = (c: StudioCapability) => () => {
    setCapability(c);
    edited();
  };
  const makeKinds = STUDIO_CAPABILITIES.filter((c) => !needsSource(c));
  const pictureTools = STUDIO_CAPABILITIES.filter((c) => needsSource(c));

  return (
    <section className="panel flex flex-col gap-4 p-4" aria-labelledby="gen-title">
      <div className="flex flex-col gap-1">
        <h2 id="gen-title" className="t-section">
          {t.gen.title}
        </h2>
        <p className="text-[12px] text-[var(--color-muted)]">{t.gen.subtitle}</p>
      </div>

      <div className="flex flex-col gap-1">
        <span className={label}>{t.gen.kindLabel}</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.kindLabel}>
          {makeKinds.map((c) => (
            <button key={c} type="button" aria-pressed={capability === c} onClick={pick(c)} className={chip(capability === c)}>
              {t.gen.kinds[c]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className={label}>{t.gen.toolsLabel}</span>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.toolsLabel}>
          {pictureTools.map((c) => (
            <button key={c} type="button" aria-pressed={capability === c} onClick={pick(c)} className={chip(capability === c)}>
              {t.gen.kinds[c]}
            </button>
          ))}
        </div>
      </div>

      {sourced && (
        <div className="flex flex-col gap-1">
          <span className={label}>{t.gen.sourceLabel}</span>
          <SourcePicker
            orgId={orgId}
            value={sourceId}
            onChange={(id) => {
              setSourceId(id);
              edited();
            }}
            libraryHref={path("/library")}
          />
          <span className="text-[12px] text-[var(--color-muted)]">{t.gen.keepsShape}</span>
        </div>
      )}

      {words !== "none" && (
        <label className="flex flex-col gap-1">
          <span className={label}>
            {isVoice ? t.gen.voiceTextLabel : t.gen.promptLabel}
            {words === "optional" && <span className="normal-case tracking-normal"> · {t.gen.optional}</span>}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              edited();
            }}
            rows={isVoice ? 5 : 3}
            maxLength={PROMPT_MAX}
            autoFocus={initial !== null}
            placeholder={t.gen.promptPh[capability]}
            className="w-full resize-y rounded-[14px] border border-[var(--color-border)] bg-transparent p-3 text-[16px] leading-relaxed outline-none transition-colors placeholder:text-[var(--color-muted)] focus:border-[var(--color-primary)] sm:text-[14px]"
          />
          {takesStyle(capability) && <span className="text-[12px] text-[var(--color-muted)]">{t.gen.mentionHint}</span>}
        </label>
      )}

      {takesStyle(capability) && styles.state !== "unavailable" && (
        <div className="flex flex-col gap-1">
          <span className={label}>{t.gen.styleLabel}</span>
          {styles.state === "loading" ? (
            <div className="flex flex-wrap gap-2" aria-busy="true" aria-label={t.gen.styleLoading}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="pill min-h-[36px] w-20 animate-pulse bg-[var(--color-panel-2)]" />
              ))}
            </div>
          ) : styles.state === "failed" ? (
            <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-muted)]">
              <span>{t.gen.styleFailed}</span>
              <button type="button" onClick={() => void styles.reload()} className="btn-sky is-quiet pill px-3 py-1.5 text-[12px]">
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
                  className={chip(effectiveStyle === null)}
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
                    className={chip(effectiveStyle === k.id) + " max-w-full truncate"}
                  >
                    {k.name}
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

      {(capability === "t2i" || capability === "t2v") && (
        <div className="flex flex-col gap-1">
          <span className={label}>{t.gen.aspectLabel}</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.aspectLabel}>
            {ASPECT_RATIOS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={aspect === a}
                onClick={() => {
                  setAspect(a);
                  edited();
                }}
                className={chip(aspect === a) + " mono"}
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      )}

      {(capability === "t2v" || capability === "i2v") && (
        <div className="flex flex-col gap-1">
          <span className={label}>{t.gen.durationLabel}</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.durationLabel}>
            {VIDEO_DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={duration === d}
                onClick={() => {
                  setDuration(d);
                  edited();
                }}
                className={chip(duration === d)}
              >
                {fmt(t.gen.seconds, { n: d })}
              </button>
            ))}
          </div>
        </div>
      )}

      {capability === "upscale" && (
        <div className="flex flex-col gap-1">
          <span className={label}>{t.gen.factorLabel}</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t.gen.factorLabel}>
            {UPSCALE_FACTORS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={factor === f}
                onClick={() => {
                  setFactor(f);
                  edited();
                }}
                className={chip(factor === f)}
              >
                {fmt(t.gen.factor, { n: f })}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className={label}>{t.gen.modelLabel}</span>
        {available.length > 0 ? (
          <select
            value={effectiveModel}
            onChange={(e) => {
              setModel(e.target.value);
              edited();
            }}
            className="pill border border-[var(--color-border)] bg-transparent px-4 py-2 text-[16px] outline-none transition-colors focus:border-[var(--color-primary)] sm:text-[13px]"
          >
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.beta ? `${m.displayName} (${t.gen.beta})` : m.displayName}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[13px] text-[var(--color-muted)]">{t.gen.noModels}</span>
        )}
      </label>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={generate}
          aria-busy={submitting || quote.status === "quoting"}
          className="cta-glass pill w-full px-6 py-3 text-[14px] font-semibold disabled:opacity-40 sm:w-auto sm:py-2.5 sm:text-[13px]"
        >
          {submitting ? t.gen.starting : generateLabel(t, quote, locale)}
        </button>
        <span className="text-[12px]" aria-live="polite">
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
          ) : null}
        </span>
      </div>
    </section>
  );
}
