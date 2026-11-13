"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatUsdAmount } from "@/lib/number-format";
import { dodoPriceText, parseDodoAmount, type DodoAmountView } from "@/lib/dodo";
import { Chip } from "@/components/ui/Chip";
import { PriceButton } from "@/components/ui/PriceButton";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The "Add credits" sheet (Ideogram's wallet sheet, in credits): preset amounts and a typed USD amount with its bounds, and,
 * before anything is paid, the credits it adds and its total. The arithmetic is the webhook's own (DODO_AMOUNT: the signed
 * cents × credits per cent), so "Credits to add" is what arrives when Dodo reports that amount paid. The total is before tax:
 * Dodo computes tax on its page, which the sheet says.
 *
 * It only asks; the parent (DodoBuyCredits) opens the checkout, owns the busy state and every message after it. The card is
 * typed on Dodo's hosted page, never here.
 *
 * "Auto recharge" is a tab that says plainly it is not available yet and why (CLAUDE.md: nothing shown as available that is
 * not). There is no control in it: no switch, threshold or saved card.
 */

type Tab = "once" | "auto";

function presetText(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function AddCreditsSheet({
  amount,
  busy,
  onSubmit,
  packsBetter = false,
}: {
  amount: DodoAmountView;
  busy: boolean;
  onSubmit: (usdCents: number) => void;
  /** Some pack on sale here gives more credits per dollar than this rate (packBonusPercent); only then is it said. */
  packsBetter?: boolean;
}) {
  const { t, locale } = useI18n();
  const ac = t.addCredits;
  const [tab, setTab] = useState<Tab>("once");
  const [text, setText] = useState(presetText(amount.presetsCents[0] ?? amount.minCents));
  const [touched, setTouched] = useState(false);
  const ids = { tabs: useId(), panel: useId(), input: useId(), bounds: useId(), error: useId() };

  const parsed = parseDodoAmount(text);
  const cents = parsed.ok ? parsed.cents : null;
  const credits = cents === null ? null : cents * amount.creditsPerCent;
  const totalText = cents === null ? ac.totalUnknown : formatUsdAmount(cents / 100, locale, 2, 2);
  const min = dodoPriceText(amount.minCents, locale);
  const max = dodoPriceText(amount.maxCents, locale);
  const error = parsed.ok
    ? null
    : parsed.reason === "below"
      ? fmt(ac.invalid.below, { min })
      : parsed.reason === "above"
        ? fmt(ac.invalid.above, { max })
        : ac.invalid[parsed.reason];
  // An out-of-bounds or malformed number is said at once; an empty box only after the person has typed in it.
  const showError = error !== null && (touched || (!parsed.ok && parsed.reason !== "empty"));

  function submit() {
    setTouched(true);
    if (cents === null || busy) return;
    onSubmit(cents);
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
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">{ac.presetsLabel}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {amount.presetsCents.map((p) => {
                  const on = cents === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => {
                        setText(presetText(p));
                        setTouched(false);
                      }}
                      className={`tnum min-h-11 rounded-[var(--ns-r-key)] border px-3 py-2 text-[15px] font-medium transition-colors ${
                        on
                          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-fg)]"
                          : "border-[var(--color-border)] hover:border-[var(--color-fg)]"
                      }`}
                    >
                      {dodoPriceText(p, locale)}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.input} className="text-sm font-medium">
                {ac.customLabel}
              </label>
              <div className="flex items-center gap-2 rounded-[var(--ns-r-key)] border border-[var(--color-border)] px-3 focus-within:border-[var(--color-fg)]">
                <span aria-hidden="true" className="text-[var(--color-muted)]">
                  $
                </span>
                <input
                  id={ids.input}
                  type="text"
                  inputMode="decimal"
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
                />
              </div>
              <p id={ids.bounds} className="text-xs text-[var(--color-muted)]">
                {fmt(ac.bounds, { min, max })}
              </p>
              {showError && (
                <p id={ids.error} className="text-sm" style={{ color: "var(--color-fail)" }} role="alert">
                  {error}
                </p>
              )}
            </div>

            <dl className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-3 text-sm" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--color-muted)]">{ac.creditsToAdd}</dt>
                <dd className="text-[15px] font-medium" data-credits-to-add>
                  {credits === null ? ac.totalUnknown : <Timecode value={credits} locale={locale} />}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[var(--color-muted)]">{ac.total}</dt>
                <dd className="tnum text-[15px] font-semibold" data-total>
                  {totalText}
                </dd>
              </div>
            </dl>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {ac.taxNote} {fmt(ac.rate, { n: String(100 * amount.creditsPerCent) })}
              {packsBetter ? ` ${ac.ratePacks}` : ""}
            </p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {ac.payWith} {ac.keepAmount}
            </p>

            <PriceButton
              type="submit"
              disabled={busy || cents === null}
              aria-describedby={showError ? ids.error : undefined}
              label={busy ? ac.processing : ac.submit}
              priceText={cents === null ? null : totalText}
            />
          </form>
        )}
      </div>
    </div>
  );
}
