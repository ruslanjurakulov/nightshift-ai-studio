import { Check } from "lucide-react";
import type { PublicDictionary } from "@/lib/i18n/public";
import { TypedText } from "@/components/site/TypedText";

/**
 * Brief, plan, approve: the three moves of a video, drawn on the sign-in and sign-up stages and played once in CSS (the
 * topic types, the plan's four lines arrive, the lamps light, the drawn button lights last; ".nx-fcard" in site-next.css).
 * It is an example and says so (the tag, the figure's description), the words are the landing's own (components/landing/
 * HeroCard.tsx reads the same `stage` strings), nothing in it is pressable (the key is a span, the group is aria-hidden
 * apart from the text), and what the server renders is the last state, which is what reduced motion, the pause switch and
 * a page without script show. `compact` is the phone's version: the topic and the approval, no plan.
 */
export function FlowCard({ stage, compact = false }: { stage: PublicDictionary["site"]["stage"]; compact?: boolean }) {
  const brief = stage.steps.find((s) => s.id === "brief") as Extract<(typeof stage.steps)[number], { field: string }>;
  const plan = stage.steps.find((s) => s.id === "plan") as Extract<(typeof stage.steps)[number], { items: { name: string; detail: string }[] }>;
  const approve = stage.steps.find((s) => s.id === "approve") as Extract<(typeof stage.steps)[number], { check: string }>;
  return (
    <figure className="nx-fcard" data-compact={compact ? "true" : undefined} aria-label={stage.figure}>
      <span className="nx-demo-tag" aria-hidden>
        {stage.tag}
      </span>
      <ol className="nx-flow-rows">
        <li data-s="brief">
          <span className="nx-flow-tab">{brief.tab}</span>
          <p className="nx-flow-brief">
            <TypedText text={brief.field} />
          </p>
        </li>
        <li data-s="plan">
          <span className="nx-flow-tab">{plan.tab}</span>
          <ul className="nx-flow-plan">
            {plan.items.map((it, i) => (
              <li key={it.name} style={{ "--k": i } as React.CSSProperties}>
                <Check aria-hidden />
                <b>{it.name}</b>
                <span>{it.detail}</span>
              </li>
            ))}
          </ul>
        </li>
        <li data-s="approve">
          <span className="nx-flow-tab">{approve.tab}</span>
          <ul className="nx-flow-lamps">
            <li>
              <span className="nx-dot" data-tone="ok" />
              {approve.lamp}
            </li>
            <li>
              <span className="nx-dot" data-tone="ok" />
              {approve.check}
            </li>
            <li data-lit="true">
              <span className="nx-dot" data-tone="run" />
              {approve.waiting}
            </li>
          </ul>
          <span className="nx-chat-key" aria-hidden>
            {approve.key}
          </span>
        </li>
      </ol>
    </figure>
  );
}
