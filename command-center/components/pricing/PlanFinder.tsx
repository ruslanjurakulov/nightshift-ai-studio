"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { fmt, type Locale } from "@/lib/i18n/core";
import { formatNumber } from "@/lib/number-format";
import { creditUnit, formatCredits, type CreditUnitForms, UNIT_VIDEO_MINUTE } from "@/lib/credits";
import {
  DEFAULT_LENGTH_S,
  FINDER_LIMITS,
  RERUN_STEPS,
  VOICE_TIERS,
  finderNeed,
  recommendPlan,
  type FinderInput,
  type FinderPlan,
  type VideoRates,
  type VoiceTier,
} from "@/lib/plan-finder";
import type { PlanFinderDictionary } from "@/lib/i18n/plan-finder/en";

/**
 * The plan finder: channels, videos a week, length, voice and room for runs made again, and the smallest plan whose
 * monthly credits cover the month. Arithmetic in the browser over the rates the page was rendered with (`video`: the two
 * units as charged, lib/plan-finder.ts videoPrices) — no request per keystroke, nothing priced here that the server did
 * not read, nothing spent or saved. Each video is quoted by estimateRunCredits(), the function Run now holds credits
 * with, so the finder and a real run cannot disagree.
 *
 * "Your match" is a live region beside the controls (sticky on a wide screen); on a phone a one-line bar pins the same
 * answer to the bottom of the screen while the controls are in view. The bar is aria-hidden and holds no control: the
 * live region already says it once.
 */
export function PlanFinder({
  copy,
  locale,
  unitForms,
  plans,
  video,
  stamp,
  conceptImages,
}: {
  copy: PlanFinderDictionary["finder"];
  locale: Locale;
  unitForms: CreditUnitForms;
  plans: FinderPlan[];
  /** The two units a video is quoted from; null = no published per-minute rate (the finder then says so). */
  video: VideoRates | null;
  /** "Rate set …" / "Rate as read on …", already in the page's language; null with no rate. */
  stamp: string | null;
  /** The most pictures a concept-thumbnail run adds (lib/credits.ts CONCEPT_THUMBNAIL_MAX_IMAGES). */
  conceptImages: number;
}) {
  const uid = useId();
  const [input, setInput] = useState<FinderInput>({
    channels: 1,
    perWeek: 3,
    lengthMin: Math.round(DEFAULT_LENGTH_S / 60),
    voice: "standard",
    rerunPct: 0,
  });
  const need = useMemo(() => finderNeed(input, video), [input, video]);
  // The phone's pinned bar stands in for the card only while the card is off screen; over the card it would cover it.
  const matchRef = useRef<HTMLElement>(null);
  const [cardInView, setCardInView] = useState(false);
  useEffect(() => {
    const el = matchRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCardInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const match = need ? recommendPlan(need.total, plans) : null;
  const c = (n: number) => formatCredits(n, locale);
  const unit = (n: number) => creditUnit(n, locale, unitForms);
  const set = <K extends keyof FinderInput>(key: K, value: FinderInput[K]) => setInput((cur) => ({ ...cur, [key]: value }));
  const minute = video?.[UNIT_VIDEO_MINUTE]?.credits ?? null;

  const stepper = (key: "channels" | "perWeek" | "lengthMin", label: string) => {
    const { min, max } = FINDER_LIMITS[key];
    const v = input[key];
    const id = `${uid}-${key}`;
    return (
      <div className="pf-field">
        <label htmlFor={id} className="pf-label">
          {label}
        </label>
        <div className="pf-step">
          <button type="button" className="pf-step-key" aria-label={`${copy.fewer}: ${label}`} disabled={v <= min} onClick={() => set(key, Math.max(min, v - 1))}>
            <Minus aria-hidden />
          </button>
          <input
            id={id}
            className="pf-num"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={v}
            onChange={(e) => {
              const n = Number(e.target.value);
              // An empty or half-typed field keeps the last good number: the answer never jumps to a default.
              if (Number.isFinite(n) && e.target.value !== "") set(key, Math.min(max, Math.max(min, Math.round(n))));
            }}
          />
          <button type="button" className="pf-step-key" aria-label={`${copy.more}: ${label}`} disabled={v >= max} onClick={() => set(key, Math.min(max, v + 1))}>
            <Plus aria-hidden />
          </button>
        </div>
      </div>
    );
  };

  const head =
    need === null ? (
      <p className="pf-match-none">{copy.unavailable}</p>
    ) : match?.kind === "plan" ? (
      <>
        <p className="pf-match-kicker">{copy.recommended}</p>
        <p className="pf-match-plan">{match.plan.name}</p>
        <p className="pf-match-usage">{fmt(copy.usage, { used: c(need.total), credits: c(match.plan.credits), unit: unit(match.plan.credits) })}</p>
        <div
          className="pf-meter"
          role="meter"
          aria-label={copy.total}
          aria-valuemin={0}
          aria-valuemax={match.plan.credits}
          aria-valuenow={need.total}
        >
          <span style={{ width: `${Math.min(100, (need.total / match.plan.credits) * 100)}%` }} />
        </div>
        <p className="pf-match-sub">{fmt(copy.spare, { n: c(match.spare), unit: unit(match.spare) })}</p>
        <a className="st-link pf-match-link" href={`#plan-${match.plan.id}`}>
          {copy.seePlan}
        </a>
      </>
    ) : match?.kind === "over" ? (
      <>
        <p className="pf-match-kicker">{copy.recommended}</p>
        <p className="pf-match-plan">{match.plan.name}</p>
        <p className="pf-match-usage">
          {fmt(copy.over, { plan: match.plan.name, credits: c(match.plan.credits), short: c(match.short) })}
        </p>
        <a className="st-link pf-match-link" href={`#plan-${match.plan.id}`}>
          {copy.seePlan}
        </a>
      </>
    ) : (
      <p className="pf-match-none">{copy.noPlans}</p>
    );

  const bar =
    need === null
      ? copy.unavailable
      : match?.kind === "plan"
        ? fmt(copy.bar, { plan: match.plan.name, used: c(need.total), credits: c(match.plan.credits), unit: unit(match.plan.credits) })
        : match?.kind === "over"
          ? fmt(copy.barOver, { used: c(need.total), unit: unit(need.total) })
          : `${copy.total}: ${fmt(copy.credits, { n: c(need.total), unit: unit(need.total) })}`;

  return (
    <div className="pf" data-plan-finder>
      <form className="pf-form" aria-label={copy.formLabel} onSubmit={(e) => e.preventDefault()}>
        <div className="pf-grid">
          {stepper("channels", copy.channels)}
          {stepper("perWeek", copy.perWeek)}
          {stepper("lengthMin", copy.length)}
        </div>
        <fieldset className="pf-set">
          <legend className="pf-label">{copy.voice}</legend>
          <div className="pf-chips">
            {VOICE_TIERS.map((v: VoiceTier) => (
              <label key={v} className="pf-chip">
                <input type="radio" name={`${uid}-voice`} value={v} checked={input.voice === v} onChange={() => set("voice", v)} />
                <span>{v === "standard" ? copy.voiceStandard : copy.voicePremium}</span>
              </label>
            ))}
          </div>
          <p className="pf-hint">{copy.voiceNote}</p>
        </fieldset>
        <fieldset className="pf-set">
          <legend className="pf-label">{copy.rerun}</legend>
          <div className="pf-chips">
            {RERUN_STEPS.map((p) => (
              <label key={p} className="pf-chip">
                <input type="radio" name={`${uid}-rerun`} value={p} checked={input.rerunPct === p} onChange={() => set("rerunPct", p)} />
                <span>{p === 0 ? copy.rerunNone : fmt(copy.rerunStep, { n: p })}</span>
              </label>
            ))}
          </div>
          <p className="pf-hint">{copy.rerunNote}</p>
        </fieldset>
      </form>

      <aside ref={matchRef} className="pf-match" aria-labelledby={`${uid}-match`}>
        <h3 id={`${uid}-match`} className="pf-match-title">
          {copy.matchTitle}
        </h3>
        <div aria-live="polite" className="pf-match-head">
          {head}
        </div>
        {need && (
          <dl className="pf-break">
            <div>
              <dt>{copy.videos}</dt>
              <dd>
                <b>{formatCredits(need.videos, locale)}</b>
                <small>{fmt(copy.videosHow, { c: input.channels, w: input.perWeek })}</small>
              </dd>
            </div>
            <div>
              <dt>{copy.perVideo}</dt>
              <dd>
                <b>{fmt(copy.credits, { n: c(need.perVideo), unit: unit(need.perVideo) })}</b>
                <small>
                  {need.floored || minute === null ? copy.perVideoFloor : fmt(copy.perVideoHow, { m: input.lengthMin, rate: formatNumber(minute, locale, 4) })}
                </small>
              </dd>
            </div>
            {input.rerunPct > 0 && (
              <div>
                <dt>{fmt(copy.headroom, { p: input.rerunPct })}</dt>
                <dd>
                  <b>{fmt(copy.credits, { n: c(need.headroom), unit: unit(need.headroom) })}</b>
                </dd>
              </div>
            )}
            <div data-total>
              <dt>{copy.total}</dt>
              <dd>
                <b>{fmt(copy.credits, { n: c(need.total), unit: unit(need.total) })}</b>
              </dd>
            </div>
          </dl>
        )}
        {need && stamp && <p className="pf-note">{stamp}</p>}
        {need && <p className="pf-note">{copy.charge}</p>}
        {need && <p className="pf-note">{fmt(copy.concept, { n: conceptImages })}</p>}
      </aside>

      <div className="pf-bar" aria-hidden="true" data-hidden={cardInView || undefined}>
        {bar}
      </div>
    </div>
  );
}
