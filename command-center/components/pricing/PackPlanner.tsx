import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { creditUnit, formatCredits } from "@/lib/credits";
import { displayPriceText, type PricingPack } from "@/lib/pricing";
import type { PriceRates } from "@/lib/site/price-check";
import { PlanSlider, type PlanRow } from "@/components/pricing/PlanSlider";

/** The slider's own range: a control's bounds, not a claim about what can be made. */
const MIN = 10;
const MAX = 400;
const STEP = 10;
const START = 60;

/**
 * "Plan your month": slide to the minutes of finished video you expect to make, read the credits that takes at the
 * published per-minute rate, and the pack that covers it. It is arithmetic on two things the pricing source holds, the
 * per-minute rate and the packs it lists (their credits and their display prices), and nothing else: it picks the
 * smallest listed pack that covers the credits, or the largest one several times when none does, and prints that pack's
 * own price text (a pack the source lists without a price reads "Price at checkout", and times a count is written as
 * "2 × $160", never added up into a figure the source did not publish). With no per-minute rate the section is absent
 * (components/pricing/PricingView.tsx), so it cannot show a default or a zero. A Server Component: it builds the table
 * here, with the page's formatters, and the browser only picks a row.
 */
export function PackPlanner({ t, locale, rates, packs }: { t: Dictionary; locale: Locale; rates: PriceRates; packs: PricingPack[] }) {
  const p = t.site.planner;
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  const sorted = [...packs].sort((a, b) => a.credits - b.credits);
  if (sorted.length === 0) return null;
  const largest = sorted[sorted.length - 1];
  const rows: PlanRow[] = [];
  for (let m = MIN; m <= MAX; m += STEP) {
    const need = Math.ceil(m * rates.perMinute);
    const one = sorted.find((x) => x.credits >= need);
    const pack = one ?? largest;
    const count = one ? 1 : Math.ceil(need / largest.credits);
    const name = t.credits.buy.pack[pack.id];
    const price = pack.displayPrice ? displayPriceText(pack.displayPrice, locale) : t.site.pricingTeaser.atCheckout;
    const total = pack.credits * count;
    rows.push({
      minutes: m,
      length: fmt(t.site.calc.minutes, { n: formatCredits(m, locale) }),
      need: fmt(p.need, { n: formatCredits(need, locale), unit: unit(need) }),
      cover: count === 1 ? name : fmt(p.count, { n: String(count), pack: name }),
      credits: fmt(p.inPack, { n: formatCredits(total, locale), unit: unit(total) }),
      price: count === 1 ? price : `${count} × ${price}`,
    });
  }
  return (
    <section id="planner" aria-labelledby="planner-title" className="st-section">
      <div className="st-wrap grid gap-8 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-14">
        <div>
          <h2 id="planner-title" className="st-h2">
            {p.title}
          </h2>
          <p className="st-lead mt-5">{p.lead}</p>
        </div>
        <div className="nx-calc nx-plan" data-spot>
          <PlanSlider rows={rows} start={START} label={p.label} needLabel={p.needLabel} coversLabel={p.covers} />
          <p className="nx-calc-rule">{p.rule}</p>
        </div>
      </div>
    </section>
  );
}
