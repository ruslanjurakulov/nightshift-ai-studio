/**
 * Numbers for display, the same on the server and in every browser.
 *
 * `Intl.NumberFormat` depends on the runtime's ICU data: Node (full ICU)
 * groups Uzbek as "1 191" while Chromium, which ships no Uzbek number
 * symbols, prints "1,191". A client component rendered on the server then
 * hydrates with different text and React throws the server HTML away. So the
 * three languages the app is written in are formatted here, by table, with
 * CLDR's separators; anything else falls back to English. Pure; pinned by
 * tests/number-format.test.ts.
 */
const SEPARATORS: Record<string, { group: string; decimal: string }> = {
  en: { group: ",", decimal: "." },
  // CLDR: a no-break space groups, a comma marks the decimals.
  ru: { group: " ", decimal: "," },
  uz: { group: " ", decimal: "," },
};

function separators(locale: string | undefined): { group: string; decimal: string } {
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  return SEPARATORS[base] ?? SEPARATORS.en;
}

/**
 * `n` with grouped thousands and at most `maxFraction` decimals (rounded half
 * away from zero, trailing zeros dropped) — what `Intl.NumberFormat(locale,
 * { maximumFractionDigits })` prints for en / ru / uz, without asking the runtime.
 */
export function formatNumber(n: number, locale = "en", maxFraction = 2): string {
  if (!Number.isFinite(n)) return "—";
  const { group, decimal } = separators(locale);
  const scale = 10 ** Math.max(0, Math.floor(maxFraction));
  // Rounded in integer units of the last decimal, so 0.005 → 0.01 as Intl does.
  const units = Math.round(Math.abs(n) * scale + 1e-9);
  const whole = Math.floor(units / scale);
  let fraction = scale > 1 ? String(units % scale).padStart(String(scale).length - 1, "0") : "";
  fraction = fraction.replace(/0+$/, "");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const sign = n < 0 && units > 0 ? "-" : "";
  return `${sign}${grouped}${fraction ? decimal + fraction : ""}`;
}

/**
 * `n` with grouped thousands and between `minFraction` and `maxFraction`
 * decimals: `formatNumber` that keeps trailing zeros down to a minimum
 * ("9.50" with two, "10" with none). Rounded half away from zero in integer
 * units, so it never depends on binary fractions or on the runtime.
 */
export function formatFixed(n: number, locale = "en", minFraction = 0, maxFraction = 2): string {
  if (!Number.isFinite(n)) return "—";
  const { group, decimal } = separators(locale);
  const max = Math.max(0, Math.floor(maxFraction));
  const min = Math.min(max, Math.max(0, Math.floor(minFraction)));
  const scale = 10 ** max;
  const units = Math.round(Math.abs(n) * scale + 1e-9);
  const whole = Math.floor(units / scale);
  let fraction = max > 0 ? String(units % scale).padStart(max, "0") : "";
  while (fraction.length > min && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const sign = n < 0 && units > 0 ? "-" : "";
  return `${sign}${grouped}${fraction ? decimal + fraction : ""}`;
}

/**
 * Which side of the number the dollar sign sits on, per language.
 *   en  $10        (the symbol first, as CLDR writes it)
 *   ru  10 $       (a no-break space, then the symbol, as CLDR writes it)
 *   uz  $10        (the symbol first: how the Uzbek copy already writes
 *                   dollar amounts, "$5 dan $5 000 gacha"; the runtime's own
 *                   answer differs between Node, "10 US$", and Chromium, "$ 10",
 *                   which is what made the page hydrate wrongly)
 */
const DOLLAR: Record<string, "prefix" | "suffix"> = { en: "prefix", ru: "suffix", uz: "prefix" };
const NBSP = "\u00a0";

/**
 * US dollars for display, the same on the server and in every browser: the
 * three languages the app is written in are laid out here by table, never by
 * `Intl.NumberFormat`'s currency style, whose symbol and spacing are whatever
 * the runtime's ICU data says. The amount is only formatted: never converted,
 * re-rounded beyond `maxFraction`, or changed in currency. Pure; pinned by
 * tests/usd-format.test.ts.
 */
export function formatUsdAmount(amount: number, locale = "en", minFraction = 0, maxFraction = 2): string {
  if (!Number.isFinite(amount)) return "—";
  const base = (locale ?? "en").toLowerCase().split(/[-_]/)[0];
  const body = formatFixed(Math.abs(amount), locale, minFraction, maxFraction);
  const negative = amount < 0 && /[1-9]/.test(body);
  const text = (DOLLAR[base] ?? DOLLAR.en) === "suffix" ? `${body}${NBSP}$` : `$${body}`;
  return negative ? `-${text}` : text;
}
