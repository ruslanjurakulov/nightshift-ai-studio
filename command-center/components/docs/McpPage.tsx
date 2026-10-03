import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { MCP_CLIENTS, MCP_TOOL_IDS } from "@/lib/dev/mcp-clients";
import type { DevDictionary } from "@/lib/i18n/dev";
import { ConnectCard, type ConnectTab } from "@/components/docs/ConnectCard";
import { DevNav, DocSection, Statement, Table, type ScrollLabels } from "@/components/docs/doc-parts";

/**
 * /mcp — how to connect an AI assistant. The first screen carries the whole
 * job, the way the best developer pages do: the three steps on one side, the
 * connect card on the other (a tab per assistant, the snippet to copy, the
 * `<your API key>` placeholder printed as is). Under it, what the ten tools do
 * and cost, and — said plainly — what cannot connect yet and why.
 *
 * Every assistant on the card has a snippet verified against its own
 * documentation (lib/dev/mcp-clients.ts). The page promises nothing the server
 * does not do: it uses API keys, not OAuth, so the Claude and ChatGPT apps'
 * own connector screens cannot reach it (docs/MCP.md).
 */
export function McpPage({
  dev,
  origin,
  labels,
  showCli,
}: {
  dev: DevDictionary;
  origin: string;
  labels: ScrollLabels;
  showCli: boolean;
}) {
  const c = dev.mcp;
  const url = `${origin}/api/mcp`;
  const tabs: ConnectTab[] = MCP_CLIENTS.map((client) => {
    const words = c.clients.find((w) => w.id === client.id);
    return {
      id: client.id,
      // "Other" is the one label that is a word, not a product name.
      label: client.id === "other" ? dev.ui.other : client.label,
      where: words?.where ?? "",
      hint: words?.hint ?? "",
      code: client.snippet(url),
    };
  });

  return (
    <div className="st-doc">
      <section aria-labelledby="mcp-title" className="st-wrap st-mcp-hero">
        <div className="st-mcp-intro">
          <DevNav nav={dev.nav} current="mcp" showCli={showCli} />
          <h1 id="mcp-title" className="st-h1-page mt-6">
            {c.title}
          </h1>
          <p className="st-lead mt-6">{c.lead}</p>
          <ol className="st-mcp-steps" aria-label={c.stepsLabel}>
            {c.steps.map((s) => (
              <li key={s.id}>
                <h2 className="st-mcp-step-title">{s.title}</h2>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="st-small">{c.needs}</p>
        </div>
        <div className="st-mcp-card">
          <ConnectCard
            tabs={tabs}
            title={c.cardTitle}
            tablistLabel={c.tablist}
            whereLabel={dev.ui.where}
            placeholderNote={dev.ui.keyPlaceholder}
            scrollLabel={labels.code}
            copy={dev.ui}
          />
          <p className="st-small st-mcp-secret">{c.secret}</p>
        </div>
      </section>

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

      <DocSection id="not-yet" no={2} title={c.notYet.slug}>
        <div className="st-notyet">
          <Statement>{c.notYet.title}</Statement>
          <p className="st-body">{c.notYet.body}</p>
          <Link href="/docs/api" className="st-link">
            {c.notYet.link}
            <ArrowRight aria-hidden />
          </Link>
        </div>
      </DocSection>

      <DocSection id="more" no={3} title={c.more.title}>
        <p className="st-body">{c.more.body}</p>
        <ul className="st-doc-links">
          <li>
            <Link href="/docs/api" className="st-link">
              {c.more.api}
              <ArrowRight aria-hidden />
            </Link>
          </li>
          {showCli && (
            <>
              <li>
                <Link href="/docs/cli" className="st-link">
                  {c.more.cli}
                  <ArrowRight aria-hidden />
                </Link>
              </li>
              <li>
                <Link href="/docs/skills" className="st-link">
                  {c.more.skills}
                  <ArrowRight aria-hidden />
                </Link>
              </li>
            </>
          )}
        </ul>
      </DocSection>
    </div>
  );
}
