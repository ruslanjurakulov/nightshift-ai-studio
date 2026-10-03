// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApiDocs } from "@/components/docs/ApiDocs";
import { McpPage } from "@/components/docs/McpPage";
import { CliPage, SkillsPage } from "@/components/docs/ToolPages";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { publicNavLinks } from "@/components/legal/PublicShell";
import { devDictionaries } from "@/lib/i18n/dev";
import { dictionaries, type Locale } from "@/lib/i18n";
import { MCP_CLIENTS } from "@/lib/dev/mcp-clients";
import { CLI_INSTALL, CLI_LOGIN, SKILLS_INSTALL } from "@/lib/dev/cli-skills";
import { openApiSpec } from "@/lib/api/openapi";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const LOCALES: Locale[] = ["en", "ru", "uz"];
const ORIGIN = "https://example.test";
const labels = { table: "Table", code: "Code" };
const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

/**
 * What a customer is not told on the public pages (owner's order): no Errors
 * section, no error-type or error-code name, no status-code prose, nothing about
 * how the server is wired inside (holds, queues, other organizations, a vendor's
 * policy). The OpenAPI document keeps the machine-readable error schema.
 */
const FORBIDDEN_CODES = [
  "queue_backend_required",
  "key_owner_not_admin",
  "no_master",
  "publish_refused",
  "downloads_unavailable",
  "capability_not_supported",
  "source_unavailable",
  "monthly_limit_reached",
  "key_limit_reached",
  "key_credit_limit_reached",
  "run_limit_reached",
  "concurrency_limit_exceeded",
  "api_not_activated",
  "entitlement_required",
  "pricing_unavailable",
  "insufficient_credits",
  "insufficient_balance",
  "insufficient_scope",
  "invalid_api_key",
  "rate_limit_exceeded",
  "model_not_sellable",
  "price_changed",
  "idempotency_key_reused",
  "api_unavailable",
  "channel_not_found",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "invalid_request_error",
  "rate_limit_error",
];

function assertNoInternals(page: string, where: string) {
  for (const code of FORBIDDEN_CODES) expect(page, `${where}: ${code}`).not.toContain(code);
  expect(page, where).not.toMatch(/_error\b/);
  expect(page, where).not.toMatch(/third-party API use|another organi[sz]ation|exactly like one that does not exist|vendor/i);
  expect(page, where).not.toMatch(/сторонн\w+ API|вендор|другой организации|boshqa tashkilot/i);
  // An HTTP status named in prose ("is 402", "refused with 409").
  expect(page, where).not.toMatch(/\b(?:400|401|402|403|404|409|422|429|503)\b/);
  expect(page, where).not.toMatch(/\b(?:ledger|worker|queue_)\b/i);
}

describe("the API reference carries no errors section and no internal mechanics", () => {
  const api = (locale: Locale) =>
    renderToStaticMarkup(<ApiDocs prices={null} origin={ORIGIN} labels={labels} dev={devDictionaries[locale]} />);

  it.each(LOCALES)("(%s) no code names, no status codes, no vendor or other-organization sentences", (locale) => {
    assertNoInternals(text(api(locale)), `/docs/api ${locale}`);
  });

  it.each(LOCALES)("(%s) has no Errors section, no #errors link and a continuous table of contents", (locale) => {
    const doc = new DOMParser().parseFromString(api(locale), "text/html");
    expect(doc.getElementById("errors")).toBeNull();
    expect(doc.querySelector('a[href="#errors"]')).toBeNull();
    const toc = [...doc.querySelectorAll(".st-doc-toc li")].map((li) => li.textContent ?? "");
    expect(toc).toHaveLength(6);
    const numbers = [...doc.querySelectorAll("section.st-doc-sec .st-doc-no")].map((n) => n.textContent);
    expect(numbers).toEqual(["01", "02", "03", "04", "05", "06"]);
    // The page ends on its closing band, then the shell's footer follows.
    const last = doc.querySelector(".st-doc")!.lastElementChild!;
    expect(last.id || last.getAttribute("aria-labelledby")).toBe("close-title");
  });

  it.each(LOCALES)("(%s) keeps what a developer must know to succeed", (locale) => {
    const page = text(api(locale));
    for (const s of ["x-request-id", "Idempotency-Key", "idempotent-replayed", "max_credits", "Retry-After", "completed", "failed"]) {
      expect(page, s).toContain(s);
    }
  });

  it("the quick start has three steps, each with its copy", () => {
    const doc = new DOMParser().parseFromString(api("en"), "text/html");
    expect(doc.getElementById("start")!.querySelectorAll("ol > li")).toHaveLength(3);
    expect(doc.querySelectorAll("button.st-copy").length).toBeGreaterThan(8);
  });

  it("the OpenAPI document carries none of the removed prose (its error schema stays machine-readable)", () => {
    const spec = openApiSpec(ORIGIN) as { components: { schemas: { Error: unknown } } };
    expect(spec.components.schemas.Error).toBeTruthy();
    // The prose: every description and summary, not the enum of codes.
    const prose: string[] = [];
    const walk = (n: unknown, key = "") => {
      if (typeof n === "string") {
        if (key === "description" || key === "summary") prose.push(n);
      } else if (Array.isArray(n)) n.forEach((x) => walk(x, key));
      else if (n && typeof n === "object") Object.entries(n).forEach(([k, v]) => k !== "enum" && walk(v, k));
    };
    walk(spec);
    const doc = prose.join("\n");
    expect(doc).not.toMatch(/third-party API|another organi[sz]ation|exactly like one that does not exist|vendor|worker|hold is|held/i);
    for (const c of ["source_unavailable", "model_not_sellable", "run_limit_reached", "key_credit_limit_reached", "insufficient_credits", "price_changed"]) {
      expect(doc, c).not.toContain(c);
    }
  });
});

describe("the MCP page", () => {
  const mcp = (locale: Locale = "en", showCli = false) => (
    <McpPage dev={devDictionaries[locale]} origin={ORIGIN} labels={labels} showCli={showCli} />
  );

  it("offers at least seven assistants, each with a snippet that names the server and has no real key", () => {
    expect(MCP_CLIENTS.length).toBeGreaterThanOrEqual(7);
    for (const c of MCP_CLIENTS) {
      const snippet = c.snippet(`${ORIGIN}/api/mcp`);
      expect(snippet, c.id).toContain(`${ORIGIN}/api/mcp`);
      // Visible placeholder, or (VS Code) a prompt the editor fills — never a key.
      expect(snippet.includes("<your API key>") || snippet.includes("${input:"), c.id).toBe(true);
      expect(snippet, c.id).not.toMatch(/nsk_live_[A-Za-z0-9]/);
    }
  });

  it.each(LOCALES)("(%s) one h1, a three-step flow, a tab per assistant and the placeholder", (locale) => {
    render(mcp(locale));
    assertNoInternals(document.body.textContent ?? "", `/mcp ${locale}`);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const dev = devDictionaries[locale].mcp;
    expect(screen.getByRole("list", { name: dev.stepsLabel }).querySelectorAll("li")).toHaveLength(3);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(MCP_CLIENTS.length);
    expect(screen.getByRole("tabpanel").textContent).toContain("claude mcp add");
    expect(screen.getByRole("tabpanel").textContent).toContain("<your API key>");
    expect(document.body.textContent).toContain(dev.notYet.title);
  });

  it("clicking a tab shows its snippet, and the copy button copies exactly that snippet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(mcp());
    fireEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain('"mcpServers"');
    fireEvent.click(within(panel).getByRole("button", { name: /Copy/ }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain(`${ORIGIN}/api/mcp`);
    expect(copied).toContain("Bearer <your API key>");
    expect(JSON.parse(copied).mcpServers.nightshift.url).toBe(`${ORIGIN}/api/mcp`);
    expect((await screen.findAllByText("Copied")).length).toBeGreaterThan(0);
  });

  it("arrow keys, Home and End move between tabs; only the chosen tab is a Tab stop", () => {
    render(mcp());
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getAllByRole("tab")[1], { key: "End" });
    expect(screen.getAllByRole("tab").at(-1)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getAllByRole("tab").at(-1)!, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("lists the ten tools, free ones marked free and the two that spend money saying so", () => {
    render(mcp());
    const table = screen.getByRole("table", { name: "Tools" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => /Free$/.test(r.textContent ?? ""))).toHaveLength(8);
  });

  it("says plainly that the Claude and ChatGPT app connectors cannot connect yet, and why", () => {
    render(mcp());
    expect(document.body.textContent).toMatch(/Not yet/);
    expect(document.body.textContent).toMatch(/OAuth/);
    expect(document.body.textContent).toMatch(/ChatGPT/);
  });

  it("links the CLI and Skills pages only while they are switched on", () => {
    const off = renderToStaticMarkup(mcp("en", false));
    const on = renderToStaticMarkup(mcp("en", true));
    expect(off).not.toContain("/docs/cli");
    expect(off).not.toContain("/docs/skills");
    expect(on).toContain("/docs/cli");
    expect(on).toContain("/docs/skills");
  });
});

describe("the CLI and Skills pages", () => {
  it.each(LOCALES)("(%s) show the install and login commands in one place, copyable", (locale) => {
    const dev = devDictionaries[locale];
    const cli = renderToStaticMarkup(<CliPage dev={dev} labels={labels} />);
    expect(cli).toContain(CLI_INSTALL);
    expect(cli).toContain(CLI_LOGIN);
    expect(CLI_INSTALL).toBe("npm i -g @nightshift/cli");
    expect(CLI_LOGIN).toBe("nightshift login");
    const skills = renderToStaticMarkup(<SkillsPage dev={dev} labels={labels} />);
    expect(skills).toContain(SKILLS_INSTALL);
    expect(skills).toContain(CLI_INSTALL);
    expect((cli.match(/st-copy/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the public shell links the developer pages as one group", () => {
  const t = dictionaries.en;

  beforeEach(() => vi.stubEnv("DEV_CLI_PAGE", ""));

  it("the top menu has one Developers entry, not an API link beside an MCP one", () => {
    const links = publicNavLinks(t);
    expect(links.filter((l) => l.href.startsWith("/docs") || l.href === "/mcp")).toEqual([
      { href: "/docs/api", label: "Developers", section: "docs" },
    ]);
  });

  it("the footer has a Developers column: API reference and MCP, and CLI and Skills only when on", () => {
    const hrefs = (html: string) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("footer a")].map((a) => a.getAttribute("href"));
    const off = hrefs(renderToStaticMarkup(<PublicFooter t={t} />));
    expect(off).toEqual(expect.arrayContaining(["/docs/api", "/mcp"]));
    expect(off).not.toContain("/docs/cli");
    expect(off).not.toContain("/docs/skills");
    vi.stubEnv("DEV_CLI_PAGE", "1");
    const on = hrefs(renderToStaticMarkup(<PublicFooter t={t} />));
    expect(on).toEqual(expect.arrayContaining(["/docs/api", "/mcp", "/docs/cli", "/docs/skills"]));
  });
});
