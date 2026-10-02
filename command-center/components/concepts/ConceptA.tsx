import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";
import { conceptCopy } from "@/lib/i18n/site/concepts";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { Meter } from "@/components/ui/Meter";
import { Stagger, StaggerItem } from "@/components/motion/Reveal";
import { PriceFacts } from "@/components/concepts/PriceFacts";

/** Each rule's lamp, as the live page's Rules section lights them. */
const RULE_TONE: Record<string, LampTone> = { price: "ok", refund: "ok", approval: "run" };

type CueState = "done" | "yours" | "next";
const cueState = (id: string): CueState => (id === "approval" ? "yours" : id === "youtube" ? "next" : "done");

/**
 * Concept A, "The rack": the hero is the control room itself, drawn as one
 * instrument cluster as wide as the page. Three modules in one rack, split by
 * hairlines: the rundown of one video (six cues, a lamp each), the three rules
 * the product keeps (each with the lines of its ledger), and the approval
 * module (the one lit lamp, a six-step ladder, the price confirmation and the
 * Approve legend). The headline is deliberately smaller than on the live
 * page: here the picture is the claim.
 *
 * Truth: the cues, the rules and the lines are the live page's own copy
 * (t.site.rundown, t.site.rules). The ladder counts steps (four of six done,
 * the fifth waiting), not credits, so no figure is invented. The only number
 * in the hero is the welcome grant and whatever the price list holds.
 *
 * Motion (MOTION.md §5.1): the cluster prints in reading order once, on first
 * paint; the waiting lamp breathes. The headline, the lead and the key are
 * plain HTML. Reduced motion: complete and still.
 */
export function ConceptA({ t, locale, anchor }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  const h = t.site.hero;
  const r = t.site.rundown;
  const rules = t.site.rules;
  const c = conceptCopy[locale];
  const approvalRow = r.rows.find((row) => row.id === "approval");
  return (
    <section aria-labelledby="ca-title" className="ac-a">
      <div className="st-wrap ac-a-top">
        <div>
          <p className="st-kicker">{h.kicker}</p>
          <h1 id="ca-title" className="ac-a-h1 mt-5">
            {h.titleA} <span>{h.titleB}</span>
          </h1>
        </div>
        <div className="ac-a-side">
          <p className="st-lead">{h.lead}</p>
          <div className="st-hero-actions">
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
        </div>
      </div>

      <div className="st-wrap">
        <Stagger as="div" trigger="mount" firstPaint role="img" aria-label={c.rackFigure} className="ac-rack">
          {/* Module 1: the rundown */}
          <div className="ac-mod">
            <div className="ac-mod-head">
              <b>{c.rackHeads.rundown}</b>
              <span className="st-tag">{r.tag}</span>
            </div>
            <ol className="ac-cues">
              {r.rows.map((row, i) => {
                const state = cueState(row.id);
                return (
                  <StaggerItem as="li" index={i} key={row.id} className="ac-cue" data-state={state}>
                    <span className="ac-cue-no st-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0">
                      <span className="ac-cue-name">{row.name}</span>
                      <span className="ac-cue-detail">{row.detail}</span>
                    </span>
                    <span className="ac-cue-state">
                      {state === "done" && <StatusLamp tone="ok" label={r.done} />}
                      {state === "yours" && <StatusLamp tone="run" label={r.yours} live size="md" />}
                      {state === "next" && <StatusLamp tone="idle" label={r.next} />}
                    </span>
                  </StaggerItem>
                );
              })}
            </ol>
          </div>

          {/* Module 2: the three rules, lit */}
          <div className="ac-mod">
            <div className="ac-mod-head">
              <b>{c.rackHeads.rules}</b>
            </div>
            <ul className="ac-rules">
              {rules.items.map((item, i) => (
                <StaggerItem as="li" index={i + 2} key={item.id} className="ac-rule">
                  <StatusLamp tone={RULE_TONE[item.id] ?? "ok"} label={item.state} />
                  <span className="ac-rule-title">{item.title}</span>
                  <ol className="ac-lines">
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
                  </ol>
                </StaggerItem>
              ))}
            </ul>
          </div>

          {/* Module 3: approval */}
          <StaggerItem as="div" index={4} className="ac-mod ac-mod-approval">
            <div className="ac-mod-head">
              <b>{c.rackHeads.approval}</b>
            </div>
            <div className="ac-approval">
              <StatusLamp tone="run" label={r.yours} live size="md" className="ac-approval-lamp" />
              <p className="ac-approval-line">{approvalRow?.detail}</p>
              {/* Where the run stands: the fifth of six steps, a real position. */}
              <p aria-hidden className="ac-step st-num">
                <span className="ac-step-no">05</span>
                <span className="ac-step-of">/ 06</span>
              </p>
              <div className="ac-ladder">
                <Meter value={4} held={1} max={6} segments={6} size="lg" label={c.ladder} valueText={c.ladder} />
                <span aria-hidden className="ac-ladder-ticks st-num">
                  {["01", "02", "03", "04", "05", "06"].map((n) => (
                    <span key={n}>{n}</span>
                  ))}
                </span>
              </div>
              <p className="ac-approval-price">{r.price}</p>
              <span className="ac-approval-keys">
                <span className="st-fake-key">
                  <Play aria-hidden />
                  {r.watch}
                </span>
                <span className="st-fake-key" data-lit="true">
                  {r.approve}
                </span>
              </span>
            </div>
          </StaggerItem>
        </Stagger>
        <PriceFacts t={t} locale={locale} anchor={anchor} titleId="ca-cost" className="ac-a-facts" />
      </div>
    </section>
  );
}
