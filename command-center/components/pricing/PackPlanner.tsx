import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { creditUnit, formatCredits } from "@/lib/credits";
import { displayPriceCents, displayPriceText, type PricingPack } from "@/lib/pricing";
import type { PriceRates } from "@/lib/site/price-check";
import { PlanSlider, type PlanRow } from "@/components/pricing/PlanSlider";

/** The slider's own range: a control's bounds, not a claim about what can be made. */
const MIN = 10;
const MAX = 400;
const STEP = 10;
const START = 60;

/**
 * "Plan your month": slide to the minutes of finished video you expect to make, read the credits that takes at the
 * published per-minute rate, and the cheapest packs that cover it. It is arithmetic on two things the pricing source holds,
 * the per-minute rate and the packs it lists (their credits and their display prices), and nothing else: it picks the
 * cheapest mix of listed packs that reaches the credits (`cheapestCover`) and prints each pack's own price text (a pack
 * the source lists without a price reads "Price at checkout"; a count is written "2 × $10", a mix "$45 + $10", never
 * added up into a figure the source did not publish). With no per-minute rate the section is absent
 * (components/pricing/PricingView.tsx), so it cannot show a default or a zero. A Server Component: it builds the table
 * here, with the page's formatters, and the browser only picks a row.
 */
/**
 * The cheapest cover: the packs (any mix, any count) whose credits reach `need` at the lowest total of the listed prices,
 * found by trying every count of each pack up to what alone would cover it (a handful of packs, so a few hundred
 * combinations). Only when every pack's display price is a plain US-dollar amount can packs be compared; otherwise it
 * falls back to the smallest single pack that covers it (or the largest, several times).
 */
function cheapestCover(packs: PricingPack[], need: number): { pack: PricingPack; count: number }[] {
  const cents = packs.map((p) => displayPriceCents(p.displayPrice));
  const largest = packs[packs.length - 1];
  if (cents.some((c) => c === null)) {
    const one = packs.find((x) => x.credits >= need);
    return one ? [{ pack: one, count: 1 }] : [{ pack: largest, count: Math.ceil(need / largest.credits) }];
  }
  const max = packs.map((p) => Math.ceil(need / p.credits));
  let best: { cost: number; n: number; counts: number[] } | null = null;
  const counts = packs.map(() => 0);
  const walk = (i: number, credits: number, cost: number, n: number) => {
    if (i === packs.length) {
      if (credits >= need && (!best || cost < best.cost || (cost === best.cost && n < best.n))) best = { cost, n, counts: [...counts] };
      return;
    }
    for (let k = 0; k <= max[i]; k++) {
      counts[i] = k;
      walk(i + 1, credits + k * packs[i].credits, cost + k * (cents[i] as number), n + k);
      if (credits + k * packs[i].credits >= need) break;
    }
    counts[i] = 0;
  };
  walk(0, 0, 0, 0);
  const pick = best as { counts: number[] } | null;
  return packs.flatMap((pack, i) => (pick && pick.counts[i] > 0 ? [{ pack, count: pick.counts[i] }] : []));
}

export function PackPlanner({ t, locale, rates, packs }: { t: Dictionary; locale: Locale; rates: PriceRates; packs: PricingPack[] }) {
  const p = t.site.planner;
  const unit = (n: number) => creditUnit(n, locale, t.shell.creditUnit);
  const sorted = [...packs].sort((a, b) => a.credits - b.credits);
  if (sorted.length === 0) return null;
  const rows: PlanRow[] = [];
  for (let m = MIN; m <= MAX; m += STEP) {
    const need = Math.ceil(m * rates.perMinute);
    const cover = cheapestCover(sorted, need);
    const name = (x: PricingPack) => t.credits.buy.pack[x.id];
    const price = (x: PricingPack) => (x.displayPrice ? displayPriceText(x.displayPrice, locale) : t.site.pricingTeaser.atCheckout);
    const total = cover.reduce((n, c) => n + c.pack.credits * c.count, 0);
    // Written as the sum's own terms ("2 × $10", "$45 + 2 × $10"), never added into a figure the pricing source did not publish.
    const term = (c: { pack: PricingPack; count: number }) => (c.count === 1 ? price(c.pack) : `${c.count} × ${price(c.pack)}`);
    rows.push({
      minutes: m,
      length: fmt(t.site.calc.minutes, { n: formatCredits(m, locale) }),
      need: fmt(p.need, { n: formatCredits(need, locale), unit: unit(need) }),
      cover: cover.map((c) => (c.count === 1 ? name(c.pack) : fmt(p.count, { n: String(c.count), pack: name(c.pack) }))).join(" + "),
      credits: fmt(p.inPack, { n: formatCredits(total, locale), unit: unit(total) }),
      price: cover.map(term).join(" + "),
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
