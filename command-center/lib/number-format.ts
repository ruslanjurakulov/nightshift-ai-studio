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
