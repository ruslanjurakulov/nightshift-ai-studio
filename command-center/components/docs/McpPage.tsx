import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import {
  MCP_CLIENTS,
  MCP_GUIDES,
  MCP_TOOL_IDS,
  claudeConnectorLink,
  installLink,
  vscodeWebInstallLink,
  type InstallLink,
  type McpClient,
} from "@/lib/dev/mcp-clients";
import { mcpClientAvailability } from "@/lib/dev/mcp-availability";
import { fmt } from "@/lib/i18n/core";
import type { DevDictionary } from "@/lib/i18n/dev";
import type { Dictionary } from "@/lib/i18n";
import { BrandLogo, BrandSprite, logoTile } from "@/components/docs/BrandLogo";
import { ConnectCard, type ConnectTab } from "@/components/docs/ConnectCard";
import { Field } from "@/components/docs/Field";
import { InstallButton } from "@/components/docs/InstallButton";
import { McpAfter, McpLanding } from "@/components/docs/McpLanding";
import { McpClientProvider } from "@/components/docs/McpClientContext";
import { McpPrompts } from "@/components/docs/McpPrompts";
import { DevNav, DocSection, Statement, Table, type ScrollLabels } from "@/components/docs/doc-parts";
import { ChatCard, type ChatCopy } from "@/components/landing/HeroCard";
import { MotionToggle } from "@/components/site/MotionToggle";

/**
 * /mcp — how to connect an AI assistant, laid out the way the best connect
 * pages are: a centred hero (a row of client tiles around the Nightshift tile,
 * one headline, one sentence), then one card with pill tabs and, under each
 * tab, three numbered steps with their action pinned to the bottom of the step
 * (a copyable field or one button). Under the card a link to the reference,
 * then "How it works", the tools, and a closing line.
 *
 * Original work on a known pattern: the tiles carry the clients' own logos where
 * their owners' rules allow (lib/dev/brand-logos.ts) and a plain icon where not;
 * the palette, type, radii and motion are the site's own (components/site/site.css).
 *
 * What it promises is only what exists. The server takes API keys today; the
 * sign-in (OAuth) flow is switched on by MCP_OAUTH_LIVE (lib/mcp-oauth.ts).
 * Until then only Cursor and VS Code are tabs (their API-key steps), the sign-in-only
 * assistants (ChatGPT, Claude, Gemini, Grok) are named in one "Coming soon" note under
 * the card rather than as tabs that look available, and no "Add to …" button is drawn:
 * each one starts a sign-in the server would not yet accept. No error codes or
 * internal mechanics appear here.
 */

type Action =
  | { kind: "url"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "install"; link: InstallLink; label: string; hint?: string; extra?: { link: InstallLink; label: string } }
  | null;

/** A tab's sign-in words (dev.mcp.oauth[id]): the install button's label, what it needs, a second link, a footnote. */
type OauthWords = { button?: string; hint?: string; extra?: string; note?: string; steps: { title: string; body: string }[] };

/** The copyable server address, the command or the button each of a tab's three steps pins to its bottom. */
function oauthActions(id: string, url: string, client: McpClient, o: OauthWords): [Action, Action, Action] {
  const snippet: Action = { kind: "code", text: client.oauthSnippet?.(url) ?? "" };
  // The one-click button leads; the steps by hand are the next step, right beside it, because none of these links has
  // been tried end to end and a custom-scheme link does nothing where the app is not installed.
  const install = (extra?: InstallLink): Action => {
    const link = installLink(id, url);
    if (!link) return null;
    return { kind: "install", link, label: o.button ?? "", hint: o.hint, extra: extra && o.extra ? { link: extra, label: o.extra } : undefined };
  };
  switch (id) {
    case "chatgpt":
    case "gemini":
    case "grok":
      // No documented install link: the vendor's own guide, then the address to paste.
      return [{ kind: "link", href: MCP_GUIDES[id], label: o.button ?? "" }, { kind: "url", text: url }, null];
    case "claude":
      return [install({ href: claudeConnectorLink(url, "organization"), opens: "web" }), { kind: "url", text: url }, null];
    case "cursor":
      return [install(), snippet, null];
    case "vscode":
      return [install({ href: vscodeWebInstallLink(url, "insiders"), opens: "web" }), snippet, null];
    default:
      return [null, null, null];
  }
}

export function McpPage({
  dev,
  origin,
  labels,
  showCli,
  oauthLive,
  initialTab,
  chat,
  bleed,
  pause,
  site,
}: {
  dev: DevDictionary;
  origin: string;
  labels: ScrollLabels;
  showCli: boolean;
  /** MCP_OAUTH_LIVE (lib/mcp-oauth.ts). */
  oauthLive: boolean;
  /** `?tab=` from the address; an unknown value means the default tab. */
  initialTab?: string;
  /** The chat card above the fold (its words come from the site dictionary, so the page passes them in). */
  chat?: ChatCopy;
  /** The picture behind the header panel (components/landing/HeroBleed.tsx): an atmosphere, labelled an example, not a picture of the product at work. */
  bleed?: ReactNode;
  /** The pause switch's label (the site's "Pause motion"): the card's drawing moves, so the page offers the switch. */
  pause?: string;
  /** The site dictionary, for a scene card that shows one of our samples (its AI-generated label and model credit). */
  site?: Dictionary["site"];
}) {
  const c = dev.mcp;
  const url = `${origin}/api/mcp`;

  function stepsList(tabLabel: string, steps: { title: string; body: string }[], actions: Action[]) {
    // A config block is not a step's button: in the middle of three columns it was cut to about a third of the card (at 1440px
    // and at 390px alike). It runs the card's full width under the steps, and its long lines scroll sideways.
    const codeAt = actions.findIndex((a) => a?.kind === "code");
    const code = codeAt >= 0 ? actions[codeAt] : null;
    return (
      <>
      <ol className="st-steps2" aria-label={tabLabel}>
        {steps.map((s, i) => {
          const a = actions[i];
          return (
            <li key={i} className="st-step2">
              <div className="st-step2-head">
                <span className="st-circle" aria-hidden>
                  {i + 1}
                </span>
                <h3 className="st-step2-title">{s.title}</h3>
              </div>
              <p className="st-step2-body">{s.body}</p>
              <div className="st-step2-action">
                {a?.kind === "url" && (
                  <Field kind="url" text={a.text} name={`${tabLabel} · ${s.title}`} scrollLabel={labels.code} copy={dev.ui} />
                )}
                {a?.kind === "install" && (
                  <div className="st-install">
                    <InstallButton link={a.link} label={a.label} newTab={dev.ui.newTab} className="st-key" size="sm" />
                    {a.extra && <InstallButton link={a.extra.link} label={a.extra.label} newTab={dev.ui.newTab} className="st-key" size="sm" tone="quiet" />}
                    {a.hint && <p className="st-small st-install-hint">{a.hint}</p>}
                  </div>
                )}
                {a?.kind === "link" && (
                  <a href={a.href} className="st-key" data-size="sm" target="_blank" rel="noopener noreferrer">
                    {a.label}
                    <ArrowUpRight aria-hidden />
                    <span className="sr-only">{dev.ui.newTab}</span>
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {code?.kind === "code" && (
        <div className="st-steps2-code">
          {/* Under all three steps, so it says which one it belongs to. */}
          <p className="st-steps2-code-label">
            <span className="st-circle" aria-hidden>
              {codeAt + 1}
            </span>
            {steps[codeAt].title}
          </p>
          <Field kind="code" text={code.text} name={`${tabLabel} · ${steps[codeAt].title}`} scrollLabel={labels.code} copy={dev.ui} />
        </div>
      )}
      </>
    );
  }

  /** The API-key steps: create a key, paste the snippet, ask. */
  function keyPanel(client: McpClient, idSuffix = "") {
    const words = c.clients.find((w) => w.id === client.id);
    const steps = c.steps.map((s, i) => ({ title: s.title, body: i === 1 ? (words?.where ?? "") : s.body }));
    return (
      <>
        {stepsList(`${client.label}${idSuffix}`, steps, [null, { kind: "code", text: client.snippet(url) }, null])}
        <div className="st-panel-foot">
          <p className="st-small">{words?.hint}</p>
          <p className="st-small">{dev.ui.keyPlaceholder}</p>
          <p className="st-small">{c.secret}</p>
        </div>
      </>
    );
  }

  // Only an assistant that can connect today is a tab. With the sign-in off that is Cursor and VS Code (an API key); the four
  // sign-in assistants led the row as tabs that looked available and opened a "Coming soon" panel, so they are named
  // together in one note under the card instead. Once the sign-in is live all six are tabs, in the order the owner set.
  // Both lists come from lib/dev/mcp-availability.ts, so this note and the tabs' "Ready to connect" line cannot disagree.
  const tabClients = MCP_CLIENTS.filter((x) => mcpClientAvailability(x.id, oauthLive) !== "soon");
  const soonClients = MCP_CLIENTS.filter((x) => mcpClientAvailability(x.id, oauthLive) === "soon");
  const tabs: ConnectTab[] = tabClients.map((client): ConnectTab => {
    const base = { id: client.id, glyph: <BrandLogo id={client.id} />, tile: logoTile(client.id), group: "primary" as const, label: client.label };
    // Connector-only tabs (sign-in live): the real steps.
    if (client.oauthOnly) {
      const o = c.oauth[client.id as "chatgpt" | "claude" | "gemini" | "grok"];
      const availability = mcpClientAvailability(client.id, oauthLive);
      return {
        ...base,
        panel: (
          <>
            {stepsList(client.label, o.steps, oauthActions(client.id, url, client, o))}
            {(availability === "ready" || availability === "unverified" || ("note" in o && o.note)) && (
              <div className="st-panel-foot">
                {/* "Ready", not "works": the server meets the vendor's published rules, and no real account has connected yet (lib/dev/mcp-availability.ts). */}
                {availability === "ready" && (
                  <p className="st-small" data-availability="ready">
                    <strong>{c.ready.badge}.</strong> {fmt(c.ready.body, { app: client.label })}
                  </p>
                )}
                {/* "Unverified": the steps are the vendor's own and nothing more is known, so the tab says so before anyone follows them. */}
                {availability === "unverified" && (
                  <p className="st-small" data-availability="unverified">
                    <strong>{c.unverified.badge}.</strong> {fmt(c.unverified.body, { app: client.label })}
                  </p>
                )}
                {"note" in o && o.note && <p className="st-small">{o.note}</p>}
              </div>
            )}
          </>
        ),
      };
    }
    // Clients with a sign-in variant lead with it once it is live, and keep the key under a disclosure.
    const o = (c.oauth as Record<string, OauthWords>)[client.id];
    if (oauthLive && o && client.oauthSnippet) {
      return {
        ...base,
        panel: (
          <>
            {stepsList(client.label, o.steps, oauthActions(client.id, url, client, o))}
            {o.note && (
              <div className="st-panel-foot">
                <p className="st-small">{o.note}</p>
              </div>
            )}
            <details className="st-keyalt">
              <summary>{c.apiKeyInstead}</summary>
              <p className="st-small">{c.apiKeyInsteadBody}</p>
              {keyPanel(client, " (API key)")}
            </details>
          </>
        ),
      };
    }
    return { ...base, panel: keyPanel(client) };
  });

  // The first tab that connects: ChatGPT once the sign-in is live, Cursor (an API key) until then.
  const defaultTab = oauthLive ? "chatgpt" : "cursor";
  const open = initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : defaultTab;
  // "Works with" names only what has been seen to connect (rule 5): a "ready" assistant meets its vendor's published rules
  // but nobody has connected the product itself yet, so it gets its own line, and an "unverified" one is named on neither.
  const worksWith = MCP_CLIENTS.filter((x) => mcpClientAvailability(x.id, oauthLive) === "available").map((x) => x.label);
  const readyWith = MCP_CLIENTS.filter((x) => mcpClientAvailability(x.id, oauthLive) === "ready").map((x) => x.label);

  // Only the tabs: the page below names the assistant the person picked, and with the sign-in off that is always one that connects.
  const names = Object.fromEntries(tabClients.map((x) => [x.id, x.label]));
  const marks = Object.fromEntries(tabClients.map((x) => [x.id, <span key={x.id} className="st-pill-glyph" data-tile={logoTile(x.id)}><BrandLogo id={x.id} /></span>]));

  return (
    <McpClientProvider initialId={open} names={names} marks={marks}>
    <div className="st-doc st-mcp">
      <BrandSprite ids={MCP_CLIENTS.map((x) => x.id)} />
      <section aria-labelledby="mcp-title" className="st-mcphero">
        <div className="st-wrap st-mcphero-in">
          <DevNav nav={dev.nav} current="mcp" showCli={showCli} />
          <p className="sr-only">
            {c.worksWith}: {worksWith.join(", ")}
          </p>
          {readyWith.length > 0 && (
            <p className="sr-only">
              {c.ready.badge}: {readyWith.join(", ")}
            </p>
          )}
          <div className="nx-mcp-top">
            <div className={bleed ? "nx-mcp-copy nx-bleed-panel" : "nx-mcp-copy"}>
              {bleed}
              <h1 id="mcp-title" className="st-mcphero-h1">
                <span>{c.title}</span> <span className="st-mcphero-dim">{c.titleDim}</span>
              </h1>
              <p className="st-mcphero-lead">{c.lead}</p>
              <p className="st-small st-mcphero-paid">{oauthLive ? c.paidLine : c.signinOff.paidLine}</p>
            </div>
            {chat && (
              <div className="nx-mcp-visual">
                <ChatCard copy={chat} bare />
                {pause && <MotionToggle pause={pause} />}
              </div>
            )}
          </div>

          <ConnectCard
            tabs={tabs}
            title={c.cardTitle}
            tablistLabel={c.tablist}
            moreLabel={c.moreLabel}
            banner={
              <>
                <strong>{oauthLive ? c.paid.title : c.signinOff.paidTitle}.</strong> {oauthLive ? c.paid.body : c.signinOff.paidBody}{" "}
                <Link href="/pricing" className="st-doc-a">
                  {c.paid.link}
                </Link>
              </>
            }
            after={
              soonClients.length > 0 && (
                // Keyed: without one, React's development check warned about a list child when this server element reached the client card.
                <div key="soon" className="st-cc-soon">
                  <span className="st-soon-badge">{c.soon.badge}</span>
                  <p className="st-cc-soon-title">{c.soon.noteTitle}</p>
                  {/* The names, each with its mark as its owner provides it (never faded): text, not a control, nothing to press. */}
                  <ul className="st-cc-soon-list">
                    {soonClients.map((x) => (
                      <li key={x.id} data-id={x.id}>
                        <span className="st-pill-glyph" data-tile={logoTile(x.id)} aria-hidden>
                          <BrandLogo id={x.id} />
                        </span>
                        {x.label}
                      </li>
                    ))}
                  </ul>
                  <p className="st-small">{c.soon.noteBody}</p>
                </div>
              )
            }
          />
          <p className="st-mcphero-docs">
            <Link href="/docs/api" className="st-link">
              {c.docs}
              <ArrowRight aria-hidden />
            </Link>
          </p>
          <p className="st-small st-trademarks">{c.trademarks}</p>
        </div>
      </section>

      <McpLanding dev={dev} site={site} oauthLive={oauthLive} />

      <McpPrompts dev={dev} oauthLive={oauthLive} />

      <DocSection id="tools" no={1} title={c.tools.slug}>
        <Statement>{c.tools.title}</Statement>
        <p className="st-body">{c.tools.lead}</p>
        {/* 0175: a sign-in connection's Studio tools, said only as "for models that allow it" (CLAUDE.md #5: no model is named or promised). */}
        <p className="st-body">{c.tools.assistantStudio}</p>
        {/* The tool table opens on a tap: a visitor who only wants to connect is not walked past a table first. */}
        <details className="nx-math nx-mcp-tools">
          <summary>
            <span>{c.tools.table}</span>
            <span className="st-faq-mark" aria-hidden />
          </summary>
          <Table name={c.tools.table} labels={labels} stack="rows">
          <thead>
            <tr>
              <th scope="col">{c.tools.cols.tool}</th>
              <th scope="col">{c.tools.cols.what}</th>
              <th scope="col">{c.tools.cols.cost}</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOL_IDS.map((id) => {
              const tool = c.tools.list.find((t) => t.id === id);
              const paid = (c.tools.paid as Record<string, string>)[id];
              return (
                <tr key={id}>
                  <td className="st-doc-path">{id}</td>
                  <td>{tool?.what}</td>
                  <td className={paid ? "st-doc-cost" : "st-doc-none"}>{paid ?? c.tools.free}</td>
                </tr>
              );
            })}
          </tbody>
          </Table>
        </details>
      </DocSection>

      <McpAfter dev={dev} showCli={showCli} oauthLive={oauthLive} />

      <section aria-labelledby="mcp-close-title" className="ml-land ml-close">
        <div className="ml-land-in ml-close-in">
          <h2 id="mcp-close-title" className="ml-land-h2 ml-close-h2">
            {c.closing.title}
          </h2>
          <p className="ml-land-lead">{c.closing.body}</p>
          <a href="#connect" className="st-key">
            {c.closing.cta}
            <ArrowRight aria-hidden />
          </a>
        </div>
      </section>
    </div>
    </McpClientProvider>
  );
}
