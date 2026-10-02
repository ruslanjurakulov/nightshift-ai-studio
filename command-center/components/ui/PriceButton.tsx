"use client";

import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Timecode } from "@/components/ui/Timecode";

/**
 * The one action that spends, with its price on it (IDENTITY.md §Signature
 * devices; the reference products' "Generate · 25" with the old price struck
 * when discounted). Two legends on one key: the action on the left in the
 * condensed face, the price on the right in the counter face, split by a
 * hairline.
 *
 * Money rules it keeps: the price shown is only ever the number it is given
 * (the backend's quote) — with none, the price legend is not drawn at all,
 * never a 0. A struck old price appears only when `was` is a real, higher
 * number. A key that cannot be pressed says why: `disabledReason` disables it
 * and is linked as its description (or point `aria-describedby` at a reason
 * the page already shows).
 */
export const PriceButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    label: ReactNode;
    /** The quoted price; null/undefined = no price yet (nothing is drawn). */
    credits?: number | null;
    /** The undiscounted price, struck through when higher than `credits`. */
    was?: number | null;
    /**
     * A price that is already text: a currency amount the billing provider
     * quoted ("$12.00"). Drawn in the counter face as given, never parsed or
     * computed. Empty or missing = no price legend. Ignored when `credits` is set.
     */
    priceText?: string | null;
    /** The undiscounted `priceText`, struck through. Pass it only when it is real. */
    wasText?: string | null;
    /** The word after the price, already pluralised ("credits"). */
    unit?: string;
    /** Screen-reader words before the struck price ("was"). */
    wasLabel?: string;
    locale?: string;
    icon?: ReactNode;
    /** Why it cannot be pressed now; disables it and is shown under it. */
    disabledReason?: string | null;
    size?: "lg" | "md";
  }
>(function PriceButton(
  { label, credits, was, priceText, wasText, unit, wasLabel, locale = "en", icon, disabledReason, size = "lg", className, disabled, type = "button", ...rest },
  ref,
) {
  const reasonId = useId();
  const priced = typeof credits === "number" && Number.isFinite(credits);
  const struck = priced && typeof was === "number" && Number.isFinite(was) && was > (credits as number);
  const quoted = !priced && typeof priceText === "string" && priceText.trim() !== "";
  const struckText = quoted && typeof wasText === "string" && wasText.trim() !== "" && wasText !== priceText;
  const describedBy = [rest["aria-describedby"], disabledReason ? reasonId : null].filter(Boolean).join(" ") || undefined;
  const button = (
    <button
      ref={ref}
      type={type}
      {...rest}
      disabled={disabled || Boolean(disabledReason)}
      aria-describedby={describedBy}
      className={`ns-price-button${className ? ` ${className}` : ""}`}
      data-size={size}
    >
      <span className="ns-price-label">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      {quoted && (
        <span className="ns-price-tag" data-testid="price-tag">
          {struckText && (
            <s className="ns-price-was ns-tc">
              {wasLabel && <span className="sr-only">{wasLabel} </span>}
              {wasText}
            </s>
          )}
          <span className="ns-tc">{priceText}</span>
        </span>
      )}
      {priced && (
        <span className="ns-price-tag" data-testid="price-tag">
          {struck && (
            <s className="ns-price-was ns-tc">
              {wasLabel && <span className="sr-only">{wasLabel} </span>}
              <Timecode value={was} locale={locale} />
            </s>
          )}
          <Timecode value={credits} locale={locale} unit={unit} />
        </span>
      )}
    </button>
  );
  if (!disabledReason) return button;
  return (
    <span className="flex w-full flex-col">
      {button}
      <span id={reasonId} className="ns-price-reason">
        {disabledReason}
      </span>
    </span>
  );
});
