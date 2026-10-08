import Link from "next/link";
import { CAPABILITY_ROWS, EXAMPLE_SCENES } from "@/lib/dev/mcp-landing";
import type { DevDictionary } from "@/lib/i18n/dev";
import { CopyButton } from "@/components/docs/CopyButton";
import { ResultsCarousel } from "@/components/docs/ResultsCarousel";
import { Scene, SCENE_SAMPLE } from "@/components/docs/SampleFrame";
import { creditLine } from "@/lib/site/media";

/**
 * The middle of /mcp, between the connect card and the tool list: six things to
 * ask for (a plain card each, with one button that copies the ask) and a
 * carousel of example asks over example stills. The hero's chat card is the
 * picture of what asking looks like, so there is no second walk-through here.
 *
 * Every picture is labelled an example and credited (they are stock photos by Pexels contributors, not output of
 * any account); no model, provider or price is named (see lib/dev/mcp-landing.ts).
 */
export function McpLanding({ dev, oauthLive }: { dev: DevDictionary; oauthLive: boolean }) {
  const c = dev.mcp;
  const l = c.land;
  return (
    <>
      <section aria-labelledby="every-title" className="ml-land ml-every" data-tone="ground">
        <div className="ml-land-in ml-every-in">
          <h2 id="every-title" className="ml-land-h2 ml-land-h2-lg">
            {l.every.title}
          </h2>
          <p className="ml-land-lead">{l.every.lead}</p>
          {/* Six things to ask, as plain cards: the label, what it is, and one button that copies the ask. The pictures live in the hero and the examples. */}
          <ul className="nx-mcp-asks">
            {CAPABILITY_ROWS.map((row) => {
              const t = l.every.rows.find((x) => x.id === row.id)!;
              return (
                <li key={row.id} className="nx-mcp-ask" data-id={row.id} data-spot>
                  <p className="ml-pillbadge">{t.label}</p>
                  <h3 className="ml-cap-h3">{t.title}</h3>
                  <p className="ml-cap-body">{row.id === "credits" && !oauthLive ? l.keyMode.credits : t.body}</p>
                  <div className="ml-cap-cta">
                    <CopyButton text={t.prompt} name={`${l.asks.copyName} (${t.title})`} labels={{ ...dev.ui, copy: t.cta }} variant="label" />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section aria-labelledby="examples-title" className="ml-land ml-examples" data-tone="soft">
        <div className="ml-land-in">
          <div className="ml-examples-head">
            <div>
              <p className="ml-label">{l.examples.label}</p>
              <h2 id="examples-title" className="ml-land-h2 ml-land-h2-left">
                {l.examples.title}
              </h2>
            </div>
            <p className="ml-land-lead ml-examples-lead">{l.examples.lead}</p>
          </div>
        </div>
        <div className="ml-land-bleed">
          <ResultsCarousel
            slideLabel={l.examples.slide}
            labels={{ region: l.examples.region, track: l.examples.track, prev: l.examples.prev, next: l.examples.next }}
            cards={EXAMPLE_SCENES.map((scene) => {
              const card = l.examples.cards.find((x) => x.id === scene)!;
              return (
                <div key={scene} className="ml-ex" data-scene={scene}>
                  <Scene kind={scene} alt={l.examples.alts[scene]} />
                  <span className="ml-ex-badge">{l.examples.sample}</span>
                  <span className="ml-ex-credit">{creditLine(SCENE_SAMPLE[scene].id, { photo: l.examples.credit.photo, video: l.examples.credit.photo })}</span>
                  <div className="ml-ex-over">
                    <span className="ml-ex-tag">{card.tag}</span>
                    <p className="ml-ex-q">{card.prompt}</p>
                    <div className="ml-ex-copy">
                      <CopyButton text={card.prompt} name={`${l.asks.copyName} (${card.tag})`} labels={{ ...dev.ui, copy: l.examples.copy }} variant="label" />
                    </div>
                  </div>
                </div>
              );
            })}
          />
        </div>
      </section>
    </>
  );
}

/** The questions people ask, then the "explore more" pills. Rendered after the tool list. */
export function McpAfter({ dev, showCli, oauthLive }: { dev: DevDictionary; showCli: boolean; oauthLive: boolean }) {
  const c = dev.mcp;
  const l = c.land;
  // Until the sign-in is switched on (MCP_OAUTH_LIVE) the page must not promise an app connection: four answers speak of the key.
  const keyAnswers: Record<number, string> = oauthLive ? {} : { 2: l.keyMode.faq.assistants, 3: l.keyMode.faq.connect, 4: l.keyMode.faq.cost, 6: l.keyMode.faq.disconnect, 7: l.keyMode.faq.credits };
  return (
    <>
      <section aria-labelledby="faq-title" className="ml-land ml-faq" data-tone="soft">
        <div className="ml-land-in ml-faq-in">
          <h2 id="faq-title" className="ml-land-h2 ml-land-h2-left">
            {l.faq.title}
          </h2>
          <div className="ml-faq-list">
            {l.faq.items.map((item, i) => (
              <details key={item.q} className="ml-faq-item">
                <summary>{item.q}</summary>
                <p>{keyAnswers[i] ?? item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="explore-title" className="ml-land ml-explore">
        <div className="ml-land-in">
          <h2 id="explore-title" className="ml-land-h2">
            {c.more.title}
          </h2>
          <ul className="ml-explore-list">
            <li>
              <Link href="/docs/api" className="ml-explore-pill">
                {c.more.api}
              </Link>
            </li>
            <li>
              <Link href="/pricing" className="ml-explore-pill">
                {l.explore.pricing}
              </Link>
            </li>
            <li>
              <a href="#tools" className="ml-explore-pill">
                {l.explore.tools}
              </a>
            </li>
            {showCli && (
              <>
                <li>
                  <Link href="/docs/cli" className="ml-explore-pill">
                    {c.more.cli}
                  </Link>
                </li>
                <li>
                  <Link href="/docs/skills" className="ml-explore-pill">
                    {c.more.skills}
                  </Link>
                </li>
              </>
            )}
          </ul>
        </div>
      </section>
    </>
  );
}
