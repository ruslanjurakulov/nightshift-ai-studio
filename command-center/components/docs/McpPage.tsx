import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import {
  CHATGPT_DEVMODE_GUIDE,
  MCP_CLIENTS,
  MCP_TOOL_IDS,
  claudeConnectorLink,
  type McpClient,
} from "@/lib/dev/mcp-clients";
import type { DevDictionary } from "@/lib/i18n/dev";
import { BrandLogo, BrandSprite, logoTile } from "@/components/docs/BrandLogo";
import { ConnectCard, type ConnectTab } from "@/components/docs/ConnectCard";
import { Field } from "@/components/docs/Field";
import { McpAfter, McpLanding } from "@/components/docs/McpLanding";
import { ClientText, McpClientProvider } from "@/components/docs/McpClientContext";
import { HowTabs } from "@/components/docs/HowTabs";
import { DevNav, DocSection, Statement, Table, type ScrollLabels } from "@/components/docs/doc-parts";
import { BrandMark } from "@/components/site/BrandMark";

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
 * Until then the Claude and ChatGPT tabs say "Coming soon" and every other tab
 * shows its API-key steps. No error codes or internal mechanics appear here.
 */

type Action =
  | { kind: "url"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; label: string }
  | null;

/** The copyable server address, the command or the button each of a tab's three steps pins to its bottom. */
function oauthActions(id: string, url: string, client: McpClient, button: string): [Action, Action, Action] {
  switch (id) {
    case "claude":
      return [{ kind: "url", text: url }, { kind: "link", href: claudeConnectorLink(url), label: button }, null];
    case "chatgpt":
      return [{ kind: "link", href: CHATGPT_DEVMODE_GUIDE, label: button }, { kind: "url", text: url }, null];
    case "claude-code":
      return [{ kind: "code", text: client.oauthSnippet?.(url) ?? "" }, null, null];
    case "openclaw":
      return [{ kind: "code", text: client.oauthSnippet?.(url) ?? "" }, null, { kind: "code", text: "openclaw mcp login nightshift" }];
    case "cursor":
      return [null, { kind: "code", text: client.oauthSnippet?.(url) ?? "" }, null];
    case "hermes":
      return [{ kind: "code", text: client.oauthSnippet?.(url) ?? "" }, null, { kind: "code", text: "hermes mcp login nightshift" }];
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
}: {
  dev: DevDictionary;
  origin: string;
  labels: ScrollLabels;
  showCli: boolean;
  /** MCP_OAUTH_LIVE (lib/mcp-oauth.ts). */
  oauthLive: boolean;
  /** `?tab=` from the address; an unknown value means the default tab. */
  initialTab?: string;
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
    const base = { id: client.id, glyph: <BrandLogo id={client.id} />, tile: logoTile(client.id), group: client.group, label: client.id === "other" ? dev.ui.other : client.label };
    // Connector-only tabs: the real steps when sign-in is live, an honest "Coming soon" until then.
    if (client.oauthOnly) {
      const o = c.oauth[client.id as "claude" | "chatgpt"];
      if (!oauthLive) {
        const soon = c.soon[client.id as "claude" | "chatgpt"];
        const goto = client.id === "claude" ? ["claude-code", "claude-desktop"] : ["cursor", "other"];
        return {
          ...base,
          soon: {
            badge: c.soon.badge,
            title: soon.title,
            body: soon.body,
            use: c.soon.use,
            goto: goto.map((g) => {
              const t = MCP_CLIENTS.find((x) => x.id === g)!;
              return { id: g, label: g === "other" ? dev.ui.other : t.label };
            }),
          },
        };
      }
      return {
        ...base,
        panel: (
          <>
            {stepsList(client.label, o.steps, oauthActions(client.id, url, client, o.button))}
            {o.note && (
              <div className="st-panel-foot">
                <p className="st-small">{o.note}</p>
              </div>
            )}
          </>
        ),
      };
    }
    // Clients with a sign-in variant lead with it once it is live, and keep the key under a disclosure.
    const o = (c.oauth as Record<string, { button?: string; note?: string; steps: { title: string; body: string }[] }>)[client.id];
    if (oauthLive && o && client.oauthSnippet) {
      return {
        ...base,
        panel: (
          <>
            {stepsList(client.label, o.steps, oauthActions(client.id, url, client, o.button ?? ""))}
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

  const defaultTab = oauthLive ? "claude" : "claude-code";
  const open = initialTab && tabs.some((t) => t.id === initialTab) ? initialTab : defaultTab;
  // Real logos only around the N, balanced in colour and weight: a white mark and a red one to the left,
  // Anthropic's orange and a blue one to the right. No "+" tile any more: every client has a mark.
  const hero = ["cursor", "chatgpt", "openclaw", "nightshift", "claude", "vscode", "windsurf"] as const;
  const firstSix = ["claude", "chatgpt", "claude-code", "openclaw", "cursor", "hermes"].map((id) => MCP_CLIENTS.find((x) => x.id === id)!.label);

  const names = Object.fromEntries(MCP_CLIENTS.map((x) => [x.id, x.id === "other" ? dev.ui.other : x.label]));
  const marks = Object.fromEntries(MCP_CLIENTS.map((x) => [x.id, <span key={x.id} className="st-pill-glyph" data-tile={logoTile(x.id)}><BrandLogo id={x.id} /></span>]));

  return (
    <McpClientProvider initialId={open} names={names} marks={marks}>
    <div className="st-doc st-mcp">
      <BrandSprite ids={MCP_CLIENTS.map((x) => x.id)} />
      <section aria-labelledby="mcp-title" className="st-mcphero">
        <div className="st-wrap st-mcphero-in">
          <DevNav nav={dev.nav} current="mcp" showCli={showCli} />
          <div className="st-tiles" aria-hidden>
            <span className="st-tiles-glow" />
            {hero.map((id, i) => (
              <span key={id} className="st-tile" data-slot={id === "nightshift" ? "brand" : Math.abs(i - 3)} data-id={id} data-tile={id === "nightshift" ? undefined : logoTile(id, "hero")}>
                {id === "nightshift" ? (
                  // The product's own mark, exactly as the owner drew it: the shaded N on its black tile.
                  <BrandMark size={104} className="st-tile-n" />
                ) : (
                  <BrandLogo id={id} variant="hero" />
                )}
              </span>
            ))}
          </div>
          <p className="sr-only">
            {c.worksWith}: {firstSix.join(", ")}
          </p>
          <h1 id="mcp-title" className="st-mcphero-h1">
            <span>{c.title}</span> <span className="st-mcphero-dim">{c.titleDim}</span>
          </h1>
          <p className="st-mcphero-lead">{c.lead}</p>
          <p className="st-small st-mcphero-paid">{c.paidLine}</p>

          <ConnectCard
            tabs={tabs}
            title={c.cardTitle}
            tablistLabel={c.tablist}
            moreLabel={c.moreLabel}
            banner={
              <>
                <strong>{c.paid.title}.</strong> {c.paid.body}{" "}
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

      <section aria-labelledby="how-title" className="st-how">
        <div className="st-wrap">
          <p className="st-how-badge">{c.how.badge}</p>
          <h2 id="how-title" className="st-how-h2">
            {c.how.title}
          </h2>
          <p className="st-how-lead">
            <ClientText template={c.how.lead} />
          </p>
          <HowTabs
            tabs={c.how.tabs}
            labels={{ tablist: c.how.tablist, you: c.how.you, agent: c.how.agent, tool: c.how.tool, pane: c.how.pane, example: c.how.example }}
          />
        </div>
      </section>

      <McpLanding dev={dev} oauthLive={oauthLive} />

      <DocSection id="tools" no={1} title={c.tools.slug}>
        <Statement>{c.tools.title}</Statement>
        <p className="st-body">{c.tools.lead}</p>
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
