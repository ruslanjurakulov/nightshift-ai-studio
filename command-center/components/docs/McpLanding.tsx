import Link from "next/link";
import { MCP_CLIENTS } from "@/lib/dev/mcp-clients";
import { ASK_IDS, CAPABILITY_ROWS, EXAMPLE_SCENES, PUBLISH_TARGETS } from "@/lib/dev/mcp-landing";
import type { DevDictionary } from "@/lib/i18n/dev";
import { BrandLogo, logoTile } from "@/components/docs/BrandLogo";
import { ClientMark, ClientText } from "@/components/docs/McpClientContext";
import { CopyButton } from "@/components/docs/CopyButton";
import { Marquee } from "@/components/docs/Marquee";
import { MarqueePause, MarqueeToggle } from "@/components/docs/MarqueePause";
import { ResultsCarousel } from "@/components/docs/ResultsCarousel";
import { Scene, SampleFrame } from "@/components/docs/SampleFrame";
import { BrandMark } from "@/components/site/BrandMark";

/**
 * The long part of /mcp, between "How it works" and the tool list: ready-to-copy
 * asks, six capability rows (label, two-line headline, paragraph, one button, and
 * a demo card: the ask, Nightshift's reply and a DRAWN frame), a carousel of
 * example asks, the "works with" marquee, and the questions people ask. The
 * same text on every tab except the assistant's name (ClientText / ClientMark);
 * the install steps above are the part that differs per assistant.
 *
 * Every picture is drawn here and captioned as an illustration; no model,
 * provider or price is named (see lib/dev/mcp-landing.ts). Original work on a
 * known pattern: the proportions are measured from a reference page and nothing
 * else is taken from it (no text, image or logo).
 */
export function McpLanding({ dev, oauthLive }: { dev: DevDictionary; oauthLive: boolean }) {
  const c = dev.mcp;
  const l = c.land;
  const clientNames = MCP_CLIENTS.filter((x) => x.id !== "other").map((x) => x.label);
  // Every client once, in the connect card's order: one row is wider than a wide screen, so nothing repeats in view.
  const clients = MCP_CLIENTS.filter((x) => x.id !== "other");

  const clientPill = (id: string, label: string) => (
    <span className="ml-mq-pill">
      <span className="st-pill-glyph" data-tile={logoTile(id)}>
        <BrandLogo id={id} />
      </span>
      {label}
    </span>
  );

  return (
    <>
      <section aria-labelledby="asks-title" className="ml-land ml-asks">
        <div className="ml-land-in">
          <p className="ml-label">{l.asks.label}</p>
          <h2 id="asks-title" className="ml-land-h2">
            <span className="ml-asks-mark">
              <ClientMark />
            </span>{" "}
            <ClientText template={l.asks.title} />
          </h2>
          <p className="ml-land-lead">{l.asks.lead}</p>
          <ul className="ml-ask-grid">
            {ASK_IDS.map((id) => {
              const item = l.asks.items.find((x) => x.id === id)!;
              return (
                <li key={id} className="ml-ask">
                  <h3 className="ml-ask-title">{item.title}</h3>
                  <p className="ml-ask-prompt">{item.prompt}</p>
                  <div className="ml-ask-copy">
                    <CopyButton text={item.prompt} name={`${l.asks.copyName} (${item.title})`} labels={dev.ui} variant="label" />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section aria-labelledby="every-title" className="ml-land ml-every" data-tone="ground">
        <div className="ml-land-in ml-every-in">
          <h2 id="every-title" className="ml-land-h2 ml-land-h2-lg">
            {l.every.title}
          </h2>
          <p className="ml-land-lead">{l.every.lead}</p>
          <div className="ml-caps">
            {CAPABILITY_ROWS.map((row, i) => {
              const t = l.every.rows.find((x) => x.id === row.id)!;
              return (
                <article key={row.id} className="ml-cap" data-flip={i % 2 === 1 || undefined} data-id={row.id}>
                  <div className="ml-cap-copy">
                    <p className="ml-pillbadge">{t.label}</p>
                    <h3 className="ml-cap-h3">{t.title}</h3>
                    <p className="ml-cap-body">{row.id === "credits" && !oauthLive ? l.keyMode.credits : t.body}</p>
                    <div className="ml-cap-cta">
                      <CopyButton text={t.prompt} name={`${l.asks.copyName} (${t.title})`} labels={{ ...dev.ui, copy: t.cta }} variant="label" />
                    </div>
                  </div>
                  <div className="ml-demo">
                    <div className="ml-bubble-row">
                      <p className="ml-bubble">{t.prompt}</p>
                    </div>
                    {row.thumbs > 0 && (
                      <div className="ml-thumbs" aria-hidden>
                        {EXAMPLE_SCENES.slice(0, row.thumbs).map((s, k) => (
                          <span key={s} className="ml-thumb">
                            <Scene kind={(["stars", "waves", "dunes"] as const)[k]} />
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="ml-reply">
                      <BrandMark size={28} />
                      <b>{l.every.replyName}</b>
                      <span>{t.reply}</span>
                    </div>
                    <SampleFrame kind={row.frame} words={l.frames} />
                  </div>
                </article>
              );
            })}
          </div>
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
                  <Scene kind={scene} />
                  <span className="ml-ex-badge">{l.examples.sample}</span>
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

      <section aria-labelledby="works-title" className="ml-land ml-works">
        <MarqueePause>
          <div className="ml-land-in ml-works-in">
            <p className="ml-label">{l.works.label}</p>
            <h2 id="works-title" className="ml-land-h2">
              {l.works.title}
            </h2>
            <p className="ml-land-lead">{oauthLive ? l.works.lead : l.keyMode.works}</p>
            <MarqueeToggle label={l.works.pause} />
          </div>
          <p className="sr-only">
            {l.works.label}: {clientNames.join(", ")}, {l.works.more}.
          </p>
          <Marquee
            rows={[
              { id: "a", items: clients.map((x) => clientPill(x.id, x.label)), seconds: 130 },
              { id: "b", items: [...clients.slice(8), ...clients.slice(0, 8)].map((x) => clientPill(x.id, x.label)), reverse: true, seconds: 130 },
            ]}
          />
          <div className="ml-publish">
            <p className="ml-publish-label">{l.works.publishes}</p>
            <ul>
              {PUBLISH_TARGETS.map((name) => (
                <li key={name}>
                  <span className="ml-mq-pill ml-mq-text">{name}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="ml-works-tm">{c.trademarks}</p>
        </MarqueePause>
      </section>
    </>
  );
}

/** The questions people ask, then the "explore more" pills. Rendered after the tool list. */
export function McpAfter({ dev, showCli, oauthLive }: { dev: DevDictionary; showCli: boolean; oauthLive: boolean }) {
  const c = dev.mcp;
  const l = c.land;
  // Until the sign-in is switched on (MCP_OAUTH_LIVE) the page must not promise an app connection: four answers speak of the key.
  const keyAnswers: Record<number, string> = oauthLive ? {} : { 2: l.keyMode.faq.assistants, 4: l.keyMode.faq.cost, 6: l.keyMode.faq.disconnect, 7: l.keyMode.faq.credits };
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
