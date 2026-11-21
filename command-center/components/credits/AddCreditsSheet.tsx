"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatUsdAmount } from "@/lib/number-format";
import { dodoPriceText, type DodoAmountView } from "@/lib/dodo";
import { parseCreditsText, topupQuote } from "@/lib/topup";
import type { GenerationRates } from "@/lib/plans";
import { Equivalents } from "@/components/credits/Equivalents";
import { Chip } from "@/components/ui/Chip";
import { PriceButton } from "@/components/ui/PriceButton";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The "Add credits" sheet (owner decision 2026-11-21): no fixed packs, the person types ANY number of credits (or drags the
 * slider), and the total, the price per credit and the "≈ N images / N s video" estimate follow as they type. The price is
 * topupQuote's, the same function the checkout route prices the order with; the browser sends only the count, so what is
 * shown here is a preview of the server's quote, never an input to it. The total is before tax: Dodo computes tax on its page.
 *
 * Above one purchase's cap ($1 000) there is no checkout: the sheet says "contact us" with a mail link instead.
 *
 * It only asks; the parent (DodoBuyCredits) opens the checkout, owns the busy state and every message after it.
 *
 * "Auto recharge" is a tab that says plainly it is not available yet and why (CLAUDE.md: nothing shown as available that is
 * not). There is no control in it: no switch, threshold or saved card.
 */

type Tab = "once" | "auto";

const SLIDER_STEP = 500;
const START_CREDITS = 5000;

export function AddCreditsSheet({
  amount,
  busy,
  onSubmit,
  rates = null,
}: {
  amount: DodoAmountView;
  busy: boolean;
  onSubmit: (credits: number) => void;
  rates?: GenerationRates | null;
}) {
  const { t, locale } = useI18n();
  const ac = t.addCredits;
  const [tab, setTab] = useState<Tab>("once");
  const [text, setText] = useState(String(START_CREDITS));
  const [touched, setTouched] = useState(false);
  const ids = { tabs: useId(), panel: useId(), input: useId(), slider: useId(), bounds: useId(), error: useId() };

  const typed = text.trim() === "" ? null : parseCreditsText(text);
  const quote = typed === null ? null : topupQuote(typed);
  const ok = quote?.ok ? quote : null;
  const aboveCap = quote !== null && !quote.ok && quote.reason === "above";
  const totalText = ok ? formatUsdAmount(ok.cents / 100, locale, 2, 2) : ac.totalUnknown;
  const rateText = ok ? formatUsdAmount(ok.tenthCents / 1000, locale, 3, 3) : ac.totalUnknown;
  const maxPrice = dodoPriceText(amount.maxCents, locale);
  const num = (n: number) => n.toLocaleString(locale);
  const error =
    text.trim() === ""
      ? ac.invalid.empty
      : typed === null || (quote && !quote.ok && quote.reason === "format")
        ? ac.invalid.format
        : quote && !quote.ok && quote.reason === "below"
          ? fmt(ac.invalid.below, { min: num(amount.minCredits) })
          : null;
  // A malformed or too-small number is said at once; an empty box only after the person has typed in it.
  const showError = error !== null && (touched || text.trim() !== "");
  const sliderValue = Math.min(Math.max(typed ?? amount.minCredits, amount.minCredits), amount.maxCredits);

  function submit() {
    setTouched(true);
    if (!ok || busy) return;
    onSubmit(ok.credits);
  }

  return (
    <div className="flex flex-col gap-4 rounded-[var(--ns-r-panel)] border border-[var(--color-border)] p-4 sm:p-5" data-add-credits>
      <SegmentedSwitch<Tab>
        label={ac.tabsLabel}
        semantics="tab"
        idPrefix={ids.tabs}
        controls={ids.panel}
        value={tab}
        onChange={setTab}
        options={[
          { value: "once", label: ac.tabOnce },
          { value: "auto", label: ac.tabAuto },
        ]}
      />

      <div id={ids.panel} role="tabpanel" aria-labelledby={`${ids.tabs}-${tab}`} className="flex flex-col gap-4">
        {tab === "auto" ? (
          <div className="flex flex-col gap-2" data-auto-recharge="unavailable">
            <Chip plain>{ac.autoChip}</Chip>
            <p className="text-sm leading-relaxed text-[var(--color-muted)]">{ac.autoBody}</p>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.input} className="text-sm font-medium">
                {ac.customLabel}
              </label>
              <div className="flex items-center gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] px-3 focus-within:border-[var(--color-fg)]">
                <input
                  id={ids.input}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={text}
                  disabled={busy}
                  onChange={(e) => {
                    setText(e.target.value);
                    setTouched(true);
                  }}
                  aria-invalid={showError}
                  aria-describedby={showError ? `${ids.bounds} ${ids.error}` : ids.bounds}
                  className="tnum min-h-11 w-full bg-transparent py-2 text-[15px] outline-none"
                  data-credits-input
                />
              </div>
              <input
                id={ids.slider}
                type="range"
                min={amount.minCredits}
                max={amount.maxCredits}
                step={SLIDER_STEP}
                value={sliderValue}
                disabled={busy}
                aria-label={ac.sliderLabel}
                aria-valuetext={num(sliderValue)}
                onChange={(e) => {
                  setText(e.target.value);
                  setTouched(true);
                }}
                className="min-h-11 w-full accent-[var(--color-primary)]"
                data-credits-slider
              />
              <p id={ids.bounds} className="text-xs text-[var(--color-muted)]">
                {fmt(ac.bounds, { min: num(amount.minCredits), max: num(amount.maxCredits), maxPrice })}
              </p>
              {showError && (
                <p id={ids.error} className="text-sm" style={{ color: "var(--color-fail)" }} role="alert">
                  {error}
                </p>
              )}
            </div>

            {aboveCap ? (
              // Over one purchase's cap: no price, no checkout, a person arranges it.
              <div className="flex flex-col gap-1.5 rounded-[var(--ns-r-key)] border border-[var(--color-border)] p-3" data-topup-contact role="status">
                <p className="text-sm font-medium">{fmt(ac.contactTitle, { max: num(amount.maxCredits) })}</p>
                <p className="text-sm text-[var(--color-muted)]">{fmt(ac.contactBody, { maxPrice })}</p>
                <a href={`mailto:${amount.contactEmail}`} className="tap-link text-sm text-[var(--color-primary)] underline underline-offset-2">
                  {ac.contactLink}
                </a>
              </div>
            ) : (
              <>
                <dl className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3 text-sm" aria-live="polite">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">{ac.creditsToAdd}</dt>
                    <dd className="text-[15px] font-medium" data-credits-to-add>
                      {ok ? <Timecode value={ok.credits} locale={locale} /> : ac.totalUnknown}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">{ac.perCredit}</dt>
                    <dd className="tnum text-[15px]" data-per-credit>
                      {rateText}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[var(--color-muted)]">{ac.total}</dt>
                    <dd className="tnum text-[15px] font-semibold" data-total>
                      {totalText}
                    </dd>
                  </div>
                </dl>
                {ok && <Equivalents credits={ok.credits} rates={rates} />}
              </>
            )}
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">{ac.tiers}</p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">{ac.taxNote}</p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {ac.payWith} {ac.keepAmount}
            </p>

            {!aboveCap && (
              <PriceButton
                type="submit"
                disabled={busy || !ok}
                aria-describedby={showError ? ids.error : undefined}
                label={busy ? ac.processing : ac.submit}
                priceText={ok ? totalText : null}
              />
            )}
          </form>
        )}
      </div>
    </div>
  );
}
