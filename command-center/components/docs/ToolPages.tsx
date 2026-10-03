import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CLI_COMMANDS, CLI_FIRST_RUN, CLI_INSTALL, CLI_LOGIN, SKILLS, SKILLS_INSTALL } from "@/lib/dev/cli-skills";
import type { DevDictionary } from "@/lib/i18n/dev";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { DevNav, DocSection, Statement, Table, type ScrollLabels } from "@/components/docs/doc-parts";

/**
 * /docs/cli and /docs/skills — the two pages that exist only while
 * DEV_CLI_PAGE=1 (lib/dev-pages.ts). A hero with the three-step setup card
 * (every command copyable), then the list of commands or skills. What they type
 * and the lists themselves are in lib/dev/cli-skills.ts, one place to change
 * the day the packages are published.
 */

type Step = { id: string; title: string; body: string; code?: string; codeName?: string };

function SetupCard({
  title,
  steps,
  dev,
  labels,
}: {
  title: string;
  steps: Step[];
  dev: DevDictionary;
  labels: ScrollLabels;
}) {
  return (
    <div className="st-connect st-setup">
      <div className="st-connect-head">
        <h2 className="st-connect-title">{title}</h2>
      </div>
      <ol className="st-setup-steps">
        {steps.map((s) => (
          <li key={s.id}>
            <h3 className="st-setup-step-title">{s.title}</h3>
            <p className="st-small">{s.body}</p>
            {s.code && <CodeBlock code={s.code} name={s.codeName ?? s.title} scrollLabel={labels.code} copy={dev.ui} />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Hero({
  id,
  current,
  kicker,
  title,
  lead,
  dev,
  card,
}: {
  id: string;
  current: "cli" | "skills";
  kicker: string;
  title: string;
  lead: string;
  dev: DevDictionary;
  card: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="st-wrap st-mcp-hero">
      <div className="st-mcp-intro">
        <DevNav nav={dev.nav} current={current} showCli />
        <p className="st-kicker mt-6">{kicker}</p>
        <h1 id={id} className="st-h1-page mt-3">
          {title}
        </h1>
        <p className="st-lead mt-6">{lead}</p>
      </div>
      <div className="st-mcp-card">{card}</div>
    </section>
  );
}

/** A command wraps between words; a flag or a [bracketed option] is never split across two lines. */
function keepTogether(command: string): React.ReactNode[] {
  return command.split(/(\[[^\]]*\]|--[\w-]+)/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="st-nb">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function Links({ items }: { items: { href: string; label: string }[] }) {
  return (
    <ul className="st-doc-links">
      {items.map((i) => (
        <li key={i.href}>
          <Link href={i.href} className="st-link">
            {i.label}
            <ArrowRight aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CliPage({ dev, labels }: { dev: DevDictionary; labels: ScrollLabels }) {
  const c = dev.cli;
  const code: Record<string, string> = { install: CLI_INSTALL, login: CLI_LOGIN, run: CLI_FIRST_RUN };
  return (
    <div className="st-doc">
      <Hero
        id="cli-hero-title"
        current="cli"
        kicker={c.kicker}
        title={c.title}
        lead={c.lead}
        dev={dev}
        card={<SetupCard title={c.cardTitle} steps={c.steps.map((s) => ({ ...s, code: code[s.id] }))} dev={dev} labels={labels} />}
      />
      <DocSection id="commands" no={1} title={c.commands.slug}>
        <Statement>{c.commands.title}</Statement>
        <Table name={c.commands.table} labels={labels} stack="rows">
          <thead>
            <tr>
              <th scope="col">{c.commands.cols.command}</th>
              <th scope="col">{c.commands.cols.what}</th>
            </tr>
          </thead>
          <tbody>
            {CLI_COMMANDS.map(({ id, command }) => (
              <tr key={id}>
                <td className="st-doc-path">{keepTogether(command)}</td>
                <td>{c.commands.list.find((x) => x.id === id)?.what}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Links
          items={[
            { href: "/docs/skills", label: c.more.skills },
            { href: "/mcp", label: c.more.mcp },
            { href: "/docs/api", label: c.more.api },
          ]}
        />
      </DocSection>
    </div>
  );
}

export function SkillsPage({ dev, labels }: { dev: DevDictionary; labels: ScrollLabels }) {
  const c = dev.skills;
  const code: Record<string, string> = { install: CLI_INSTALL, skills: SKILLS_INSTALL };
  return (
    <div className="st-doc">
      <Hero
        id="skills-hero-title"
        current="skills"
        kicker={c.kicker}
        title={c.title}
        lead={c.lead}
        dev={dev}
        card={<SetupCard title={c.cardTitle} steps={c.steps.map((s) => ({ ...s, code: code[s.id] }))} dev={dev} labels={labels} />}
      />
      <DocSection id="skills" no={1} title={c.list.slug}>
        <Statement>{c.list.title}</Statement>
        <Table name={c.list.table} labels={labels} stack="rows">
          <thead>
            <tr>
              <th scope="col">{c.list.cols.skill}</th>
              <th scope="col">{c.list.cols.what}</th>
            </tr>
          </thead>
          <tbody>
            {SKILLS.map(({ id, name }) => (
              <tr key={id}>
                <td className="st-doc-path">{name}</td>
                <td>{c.list.items.find((x) => x.id === id)?.what}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Links
          items={[
            { href: "/docs/cli", label: c.more.cli },
            { href: "/mcp", label: c.more.mcp },
            { href: "/docs/api", label: c.more.api },
          ]}
        />
      </DocSection>
    </div>
  );
}
