import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Stagger, StaggerItem } from "@/components/motion/Reveal";
import { PriceFacts, PriceLine } from "@/components/concepts/PriceFacts";

const RULE_TONE: Record<string, LampTone> = { price: "ok", refund: "ok", approval: "run" };

/**
 * Concept B, "The ledger": no machine, no screenshot, no device. One editorial
 * statement set at the width of the page, and under it the product's three
 * promises written the way a ledger writes entries: a number, the rule in
 * display type, its lines as journal entries with a lamp each, and the state
 * it stands in. The last line is the price, because that is what a ledger is
 * for. The ledger is the hero image; the type is the picture.
 *
 * Truth: every word is the live page's (t.site.hero, t.site.rules,
 * t.site.anchor). The ledger replaces the Rules section on the page (see
 * ATELIER_CONCEPTS.md): the three rules are said once, here, not twice.
 *
 * Motion: the ledger's rows print in order once (the one entrance the public
 * hero may have, never the statement, the lead or the key). Reduced motion:
 * everything in place.
 */
export function ConceptB({ t, locale, anchor }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  const h = t.site.hero;
  const rules = t.site.rules;
  return (
    <section aria-labelledby="cb-title" className="ac-b">
      <div className="st-wrap">
        <p className="st-kicker ac-b-kicker">{h.kicker}</p>
        <h1 id="cb-title" className="ac-b-h1">
          <span className="ac-b-a">{h.titleA}</span>
          <span className="ac-b-b">{h.titleB}</span>
        </h1>
        <div className="ac-b-deck">
          <p className="st-lead">{h.lead}</p>
          <div>
            <div className="st-hero-actions" style={{ marginTop: 0 }}>
              <Link href="/signup" className="st-key">
                {h.cta}
                <ArrowRight aria-hidden />
              </Link>
              <Link href="/pricing" className="st-link">
                {h.secondary}
              </Link>
            </div>
            <p className="st-hero-note">
              <span aria-hidden className="ns-lamp" data-tone="ok" />
              {fmt(h.note, { n: formatCredits(WELCOME_CREDITS, locale) })}
            </p>
            <PriceLine t={t} locale={locale} anchor={anchor} />
          </div>
        </div>

        <Stagger as="ol" trigger="mount" firstPaint aria-label={rules.slug} className="ac-ledger">
          {rules.items.map((item, i) => (
            <StaggerItem as="li" index={i} key={item.id} className="ac-entry" data-id={item.id}>
              <span aria-hidden className="ac-entry-no st-num">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="ac-entry-title">{item.title}</span>
              <ul className="ac-entry-lines" aria-label={item.title}>
                {item.lines.map((line, j) => {
                  const last = j === item.lines.length - 1;
                  const tone: LampTone = item.id === "refund" && j === 1 ? "fail" : last && item.id === "approval" ? "run" : "ok";
                  return (
                    <li key={line}>
                      <span aria-hidden className="ns-lamp" data-tone={tone} />
                      {line}
                    </li>
                  );
                })}
              </ul>
              <span className="ac-entry-state">
                <StatusLamp tone={RULE_TONE[item.id] ?? "ok"} label={item.state} live={item.id === "approval"} size="md" />
              </span>
            </StaggerItem>
          ))}
        </Stagger>
        <PriceFacts t={t} locale={locale} anchor={anchor} titleId="cb-cost" className="ac-b-facts" />
      </div>
    </section>
  );
}
