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
import type { DevDictionary } from "@/lib/i18n/dev";
import { BrandLogo, BrandSprite, logoTile } from "@/components/docs/BrandLogo";
import { ConnectCard, type ConnectTab } from "@/components/docs/ConnectCard";
import { Field } from "@/components/docs/Field";
import { InstallButton } from "@/components/docs/InstallButton";
import { McpAfter, McpLanding } from "@/components/docs/McpLanding";
import { McpClientProvider } from "@/components/docs/McpClientContext";
import { DevNav, DocSection, Statement, Table, type ScrollLabels } from "@/components/docs/doc-parts";
import { ChatCard, type ChatCopy } from "@/components/landing/HeroCard";
import { MotionToggle } from "@/components/site/MotionToggle";

/**
 * /mcp — how to connect an AI assistant, laid out the way the best connect
 * pages are: a centred hero (a row of client tiles around the Nightshift tile,
 * one headline, one sentence), then one card with pill tabs and, under each
 * tab, three numbered steps with their action pinned to the bottom of the step
 * (a copyable field or one button). Under the card a link to the reference,
 * then "How it works", the ten tools, and a closing line.
 *
 * Original work on a known pattern: the tiles carry the clients' own logos where
 * their owners' rules allow (lib/dev/brand-logos.ts) and a plain icon where not;
 * the palette, type, radii and motion are the site's own (components/site/site.css).
 *
 * What it promises is only what exists. The server takes API keys today; the
 * sign-in (OAuth) flow is switched on by MCP_OAUTH_LIVE (lib/mcp-oauth.ts).
 * Until then the sign-in-only tabs (ChatGPT, Claude, Gemini, Grok) say "Coming soon",
 * every other tab shows its API-key steps, and no "Add to …" button is drawn:
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

/** Where a "Coming soon" tab points while the sign-in is off: the two that work today with an API key. */
const SOON_GOTO = ["cursor", "vscode"];

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
}) {
  const c = dev.mcp;
  const url = `${origin}/api/mcp`;

  function stepsList(tabLabel: string, steps: { title: string; body: string }[], actions: Action[]) {
    return (
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
                {a?.kind === "code" && (
                  <Field kind="code" text={a.text} name={`${tabLabel} · ${s.title}`} scrollLabel={labels.code} copy={dev.ui} />
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

  const tabs: ConnectTab[] = MCP_CLIENTS.map((client): ConnectTab => {
    const base = { id: client.id, glyph: <BrandLogo id={client.id} />, tile: logoTile(client.id), group: "primary" as const, label: client.label };
    // Connector-only tabs: the real steps when sign-in is live, an honest "Coming soon" until then.
    if (client.oauthOnly) {
      const o = c.oauth[client.id as "chatgpt" | "claude" | "gemini" | "grok"];
      if (!oauthLive) {
        const soon = c.soon[client.id as "chatgpt" | "claude" | "gemini" | "grok"];
        const goto = SOON_GOTO;
        return {
          ...base,
          soon: {
            badge: c.soon.badge,
            title: soon.title,
            body: soon.body,
            use: c.soon.use,
            goto: goto.map((g) => {
              const t = MCP_CLIENTS.find((x) => x.id === g)!;
              return { id: g, label: t.label };
            }),
          },
        };
      }
      return {
        ...base,
        panel: (
          <>
            {stepsList(client.label, o.steps, oauthActions(client.id, url, client, o))}
            {"note" in o && o.note && (
              <div className="st-panel-foot">
                <p className="st-small">{o.note}</p>
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
  const worksWith = MCP_CLIENTS.filter((x) => oauthLive || !x.oauthOnly).map((x) => x.label);

  // With the sign-in off (MCP_OAUTH_LIVE) Claude and ChatGPT are "coming soon": nothing on the page may read as if they connect today.
  const soonIds = oauthLive ? [] : MCP_CLIENTS.filter((x) => x.oauthOnly).map((x) => x.id);
  const names = Object.fromEntries(MCP_CLIENTS.map((x) => [x.id, x.label]));
  const marks = Object.fromEntries(MCP_CLIENTS.map((x) => [x.id, <span key={x.id} className="st-pill-glyph" data-tile={logoTile(x.id)}><BrandLogo id={x.id} /></span>]));

  return (
    <McpClientProvider initialId={open} names={names} marks={marks} soonIds={soonIds}>
    <div className="st-doc st-mcp">
      <BrandSprite ids={MCP_CLIENTS.map((x) => x.id)} />
      <section aria-labelledby="mcp-title" className="st-mcphero">
        <div className="st-wrap st-mcphero-in">
          <DevNav nav={dev.nav} current="mcp" showCli={showCli} />
          <p className="sr-only">
            {c.worksWith}: {worksWith.join(", ")}
          </p>
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

      <McpLanding dev={dev} oauthLive={oauthLive} />

      <DocSection id="tools" no={1} title={c.tools.slug}>
        <Statement>{c.tools.title}</Statement>
        <p className="st-body">{c.tools.lead}</p>
        {/* The ten tools open on a tap: a visitor who only wants to connect is not walked past a table first. */}
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
