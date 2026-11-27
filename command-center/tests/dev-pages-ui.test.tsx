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
import { publicNav, navHrefs } from "@/lib/public-nav";
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
  const mcp = (opts: { locale?: Locale; showCli?: boolean; oauthLive?: boolean; initialTab?: string } = {}) => (
    <McpPage
      dev={devDictionaries[opts.locale ?? "en"]}
      origin={ORIGIN}
      labels={labels}
      showCli={opts.showCli ?? false}
      oauthLive={opts.oauthLive ?? false}
      initialTab={opts.initialTab}
    />
  );
  const doc = (el: ReactNode) => new DOMParser().parseFromString(renderToStaticMarkup(el as React.ReactElement), "text/html");
  const selected = (d: Document) => d.querySelector('[role="tab"].st-pill[aria-selected="true"]')?.getAttribute("data-id");

  it("every API-key snippet names the server, carries the visible placeholder (or an editor prompt) and no real key", () => {
    for (const c of MCP_CLIENTS.filter((x) => !x.oauthOnly)) {
      const snippet = c.snippet(`${ORIGIN}/api/mcp`);
      expect(snippet, c.id).toContain(`${ORIGIN}/api/mcp`);
      expect(snippet.includes("<your API key>") || snippet.includes("${input:"), c.id).toBe(true);
      expect(snippet, c.id).not.toMatch(/nsk_live_[A-Za-z0-9]/);
    }
  });

  it("the sign-in snippets carry no key at all", () => {
    const withSignIn = MCP_CLIENTS.filter((x) => x.oauthSnippet);
    expect(withSignIn.map((c) => c.id)).toEqual(["cursor", "vscode"]);
    for (const c of withSignIn) {
      const snippet = c.oauthSnippet!(`${ORIGIN}/api/mcp`);
      expect(snippet, c.id).toContain(`${ORIGIN}/api/mcp`);
      expect(snippet, c.id).not.toMatch(/Bearer|API key|nsk_live_|headers/);
    }
  });

  it.each(LOCALES)("(%s) one h1; sign-in live: the six tabs in the owner's order, with no \"More clients\" group", (locale) => {
    const d = doc(mcp({ locale, oauthLive: true }));
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    const tabs = [...d.querySelectorAll('[role="tab"].st-pill')].map((t) => t.getAttribute("data-id"));
    expect(tabs).toEqual(["chatgpt", "claude", "gemini", "grok", "cursor", "vscode"]);
    expect(d.querySelector(".st-pill-more")).toBeNull();
    expect(d.querySelector(".st-cc-soon")).toBeNull();
  });

  // The four sign-in assistants used to lead the row as tabs that looked available and opened "Coming soon" (CLAUDE.md:
  // nothing is shown as available that is not). With the sign-in off only what connects today is a tab.
  it.each(LOCALES)("(%s) sign-in off: only Cursor and VS Code are tabs, and the other four are named in one Coming soon note, not as controls", (locale) => {
    const d = doc(mcp({ locale }));
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    expect([...d.querySelectorAll('[role="tab"].st-pill')].map((t) => t.getAttribute("data-id"))).toEqual(["cursor", "vscode"]);
    const note = d.querySelector(".st-cc-soon")!;
    expect(note.textContent).toContain(devDictionaries[locale].mcp.soon.badge);
    expect(note.textContent).toContain(devDictionaries[locale].mcp.soon.noteTitle);
    expect([...note.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["ChatGPT", "Claude", "Gemini", "Grok"]);
    expect(note.querySelectorAll("a, button, [role='tab'], [tabindex]")).toHaveLength(0);
  });

  it.each(LOCALES)("(%s) no internal wording, code names or status numbers, flag off and on", (locale) => {
    for (const oauthLive of [false, true]) {
      assertNoInternals(doc(mcp({ locale, oauthLive })).body.textContent ?? "", `/mcp ${locale} oauth=${oauthLive}`);
    }
  });

  it("picks the open tab on the server from ?tab=, so there is no flash and no-JS sees it", () => {
    expect(selected(doc(mcp({ initialTab: "cursor" })))).toBe("cursor");
    expect(selected(doc(mcp({ initialTab: "grok", oauthLive: true })))).toBe("grok");
    // Unknown, removed and missing values mean the default: Cursor (an API key) while sign-in is off, ChatGPT once it is on.
    expect(selected(doc(mcp({ initialTab: "nope" })))).toBe("cursor");
    expect(selected(doc(mcp({ initialTab: "claude-code" })))).toBe("cursor");
    expect(selected(doc(mcp()))).toBe("cursor");
    expect(selected(doc(mcp({ oauthLive: true })))).toBe("chatgpt");
  });

  it("renders every tab's steps in the page, for crawlers and for no-JS readers", () => {
    const html = renderToStaticMarkup(mcp());
    const text = doc(mcp()).body.textContent ?? "";
    for (const needle of ['"mcpServers"', '"servers"', "promptString", "Coming soon"]) {
      expect(text, needle).toContain(needle);
    }
    expect(html).toContain("<noscript>");
    expect(doc(mcp()).querySelectorAll(".st-tabpanel")).toHaveLength(MCP_CLIENTS.filter((c) => !c.oauthOnly).length);
    expect(doc(mcp({ oauthLive: true })).querySelectorAll(".st-tabpanel")).toHaveLength(MCP_CLIENTS.length);
  });

  it("puts a config block under the three steps, the card's full width, saying which step it belongs to", () => {
    const d = doc(mcp({ initialTab: "cursor" }));
    for (const panel of d.querySelectorAll(".st-tabpanel")) {
      // Never inside a step's column, where it was cut to a third of the card.
      expect(panel.querySelector(".st-step2 pre"), panel.id).toBeNull();
      const block = panel.querySelector(":scope > .st-steps2-code");
      expect(block, panel.id).toBeTruthy();
      expect(block!.previousElementSibling?.classList.contains("st-steps2")).toBe(true);
      expect(block!.querySelector(".st-steps2-code-label")?.textContent).toBe("2Paste the snippet");
      expect(block!.querySelector("pre")?.textContent).toMatch(/"(mcpServers|servers)"/);
    }
  });

  it("tabs are wired for assistive tech: each tab controls a labelled panel; only the open one is a Tab stop", () => {
    const d = doc(mcp({ initialTab: "cursor" }));
    for (const tab of d.querySelectorAll('[role="tab"].st-pill')) {
      const panel = d.getElementById(tab.getAttribute("aria-controls")!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(tab.getAttribute("tabindex")).toBe(tab.getAttribute("aria-selected") === "true" ? "0" : "-1");
    }
    expect(d.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBeTruthy();
  });

  it("flag off: the four sign-in assistants are no tab, are named in the Coming soon note with what works today, and show no connector link", () => {
    const html = renderToStaticMarkup(mcp());
    for (const host of ["claude.ai/customize", "developers.openai.com", "support.google.com", "docs.x.ai"]) expect(html).not.toContain(host);
    const d = doc(mcp());
    for (const id of ["chatgpt", "claude", "gemini", "grok"]) expect(d.querySelector(`[role="tab"][data-id="${id}"]`), id).toBeNull();
    const note = d.querySelector(".st-cc-soon")!;
    expect(note.textContent).toContain("Coming soon");
    expect(note.textContent).toMatch(/Cursor and VS Code work now with an API key/);
    expect(note.querySelector("a")).toBeNull();
    // Cursor and VS Code lead with the API-key steps.
    for (const id of ["cursor", "vscode"]) {
      const p = d.getElementById(d.querySelector(`[role="tab"][data-id="${id}"]`)!.getAttribute("aria-controls")!)!;
      expect(p.textContent, id).toMatch(/<your API key>|\$\{input:nightshift-key\}/);
      expect(p.querySelector("details"), id).toBeNull();
    }
  });

  it("flag on: the real connector steps — the prefilled Claude link, OpenAI’s custom-MCP-server guide, sign-in snippets with the key under a disclosure", () => {
    const d = doc(mcp({ oauthLive: true }));
    const panel = (id: string) => d.getElementById(d.querySelector(`[role="tab"][data-id="${id}"]`)!.getAttribute("aria-controls")!)!;
    const link = panel("claude").querySelector("a[href]")!.getAttribute("href")!;
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe("https://claude.ai/customize/connectors");
    expect(u.searchParams.get("modal")).toBe("add-custom-connector");
    expect(u.searchParams.get("connectorName")).toBe("Nightshift");
    expect(u.searchParams.get("connectorUrl")).toBe(`${ORIGIN}/api/mcp`);
    expect(panel("claude").querySelector("a")?.getAttribute("rel")).toContain("noopener");
    expect(panel("claude").textContent).toContain(`${ORIGIN}/api/mcp`);
    expect(panel("chatgpt").querySelector("a[href]")?.getAttribute("href")).toBe("https://developers.openai.com/api/docs/guides/custom-mcp-server");
    expect(panel("chatgpt").textContent).toContain("Add custom MCP server");
    // The developer-mode flow it replaced is gone, and its guide is a 404.
    expect(panel("chatgpt").textContent).not.toMatch(/developer mode/i);
    for (const id of ["chatgpt", "claude", "gemini", "grok"]) expect(panel(id).textContent).not.toContain("Coming soon");
    for (const id of ["cursor", "vscode"]) {
      expect(panel(id).querySelector("details summary")?.textContent, id).toBe("Use an API key instead");
      expect(panel(id).querySelector("details")!.textContent, id).toMatch(/<your API key>|\$\{input:nightshift-key\}/);
    }
  });

  // 0147: the sign-in door is open on every plan, Free included, and limited by credits (it was a paid-plan feature).
  it("says MCP sign-in works on every plan including Free, spends credits, and that keys and REST are billed separately (sign-in on)", () => {
    const d = doc(mcp({ oauthLive: true }));
    const banner = d.querySelector(".st-banner")!;
    expect(banner.textContent).toMatch(/every plan, Free included/);
    expect(banner.textContent).toMatch(/credits/);
    expect(banner.textContent).toMatch(/API keys/);
    expect(banner.textContent).not.toMatch(/paid plan/i);
    expect(banner.querySelector('a[href="/pricing"]')).toBeTruthy();
    expect(d.querySelector(".st-mcphero-paid")?.textContent).toMatch(/every plan, Free included/);
    expect(d.body.textContent).not.toMatch(/needs a paid plan|part of every paid plan/i);
  });

  it("with the sign-in off says only that keys work today and that the sign-in is coming soon, and still links the plans", () => {
    const d = doc(mcp());
    const banner = d.querySelector(".st-banner")!;
    expect(banner.textContent).toMatch(/API keys/);
    expect(banner.textContent).toMatch(/coming soon/i);
    expect(banner.querySelector('a[href="/pricing"]')).toBeTruthy();
    expect(d.querySelector(".st-mcphero-paid")?.textContent).toMatch(/coming soon/i);
    expect(d.querySelector(".st-mcphero-paid")?.textContent).not.toMatch(/needs a paid plan/i);
  });

  it("has no row of client logos in the hero (a chat card stands there), keeps the names in text for screen readers, and no image from anywhere", () => {
    const d = doc(mcp());
    expect(d.querySelector(".st-tiles")).toBeNull();
    // Pictures: only the example stills (img.ml-scene, same-origin build files); never video.
    expect(d.querySelectorAll("img:not(.ml-scene), picture, video")).toHaveLength(0);
    // Only the sprite may hold a picture, and only an embedded one (data: URI), never a remote file.
    for (const im of Array.from(d.querySelectorAll("image"))) {
      expect(im.getAttribute("href") ?? "").toMatch(/^data:image\/(png|webp);base64,/);
    }
    // With the sign-in off the four chat apps cannot connect yet, so the line names only what does.
    expect(d.querySelector(".sr-only")?.textContent).toBe("Works with: Cursor, VS Code (GitHub Copilot)");
    // With it on, ChatGPT and Claude meet their vendors' published rules but nobody has connected the products yet (rule 5,
    // lib/dev/mcp-availability.ts): they get their own "Ready to connect" line, and Gemini and Grok are named on neither.
    const live = [...doc(mcp({ oauthLive: true })).querySelectorAll(".st-mcphero .sr-only")].map((p) => p.textContent);
    expect(live.slice(0, 2)).toEqual(["Works with: Cursor, VS Code (GitHub Copilot)", "Ready to connect: ChatGPT, Claude"]);
  });

  describe("interaction", () => {
    beforeEach(() => {
      window.history.replaceState(null, "", "/mcp");
    });

    it("clicking a tab opens it, sets ?tab= without adding a history entry, and the copy key copies exactly that snippet", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const before = window.history.length;
      render(mcp());
      fireEvent.click(screen.getByRole("tab", { name: /Cursor/ }));
      expect(window.location.search).toBe("?tab=cursor");
      expect(window.history.length).toBe(before);
      const open = document.querySelector('[role="tabpanel"][data-active="true"]') as HTMLElement;
      expect(open.textContent).toContain('"mcpServers"');
      fireEvent.click(within(open).getByRole("button", { name: /Copy/ }));
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = String(writeText.mock.calls[0][0]);
      expect(JSON.parse(copied).mcpServers.nightshift.url).toBe(`${ORIGIN}/api/mcp`);
      expect(copied).toContain("Bearer <your API key>");
      // The state is announced in a live region, and the key shows a check mark (an inline icon).
      await vi.waitFor(() => expect(within(open).getAllByRole("status").some((s) => s.textContent === "Copied")).toBe(true));
      expect(open.querySelector('button[data-state="copied"] svg')).toBeTruthy();
    });

    it("the copied state returns to the icon after a moment", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
      render(mcp());
      const open = document.querySelector('[role="tabpanel"][data-active="true"]') as HTMLElement;
      fireEvent.click(within(open).getAllByRole("button", { name: /Copy/ })[0]);
      await vi.waitFor(() => expect(open.querySelector('button[data-state="copied"]')).toBeTruthy());
      await vi.advanceTimersByTimeAsync(1700);
      await vi.waitFor(() => expect(open.querySelector('button[data-state="copied"]')).toBeNull());
      vi.useRealTimers();
    });

    it("falls back to the selection copy where the clipboard API is refused, and says so when that fails too", async () => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("no")) }, configurable: true });
      document.execCommand = vi.fn().mockReturnValue(false);
      render(mcp());
      const open = document.querySelector('[role="tabpanel"][data-active="true"]') as HTMLElement;
      fireEvent.click(within(open).getAllByRole("button", { name: /Copy/ })[0]);
      await vi.waitFor(() => expect(within(open).getAllByRole("status").some((s) => /Could not copy/.test(s.textContent ?? ""))).toBe(true));
      (document.execCommand as unknown) = vi.fn().mockReturnValue(true);
      fireEvent.click(within(open).getAllByRole("button", { name: /Copy/ })[0]);
      await vi.waitFor(() => expect(within(open).getAllByRole("status").some((s) => s.textContent === "Copied")).toBe(true));
    });

    it("an old #hash link still opens its tab, and is rewritten to ?tab=", () => {
      window.history.replaceState(null, "", "/mcp#vscode");
      render(mcp());
      expect(screen.getByRole("tab", { name: /VS Code/ }).getAttribute("aria-selected")).toBe("true");
      expect(window.location.search).toBe("?tab=vscode");
      expect(window.location.hash).toBe("");
    });

    it("arrow keys, Home and End move between tabs and wrap; focus follows", () => {
      render(mcp());
      const tabs = () => screen.getAllByRole("tab").filter((t) => t.classList.contains("st-pill"));
      const start = tabs().findIndex((t) => t.getAttribute("aria-selected") === "true");
      fireEvent.keyDown(tabs()[start], { key: "ArrowRight" });
      expect(tabs()[start + 1].getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(tabs()[start + 1]);
      fireEvent.keyDown(tabs()[start + 1], { key: "ArrowLeft" });
      expect(tabs()[start].getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(tabs()[start], { key: "Home" });
      expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(tabs()[0], { key: "ArrowLeft" });
      expect(tabs().at(-1)!.getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(tabs().at(-1)!, { key: "End" });
      expect(tabs().at(-1)!.getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(tabs().at(-1)!, { key: "ArrowRight" });
      expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    });

    it("an old ?tab= link to a sign-in assistant opens a tab that works today while the sign-in is off", () => {
      render(mcp({ initialTab: "claude" }));
      expect(screen.getByRole("tab", { name: /Cursor/ }).getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByRole("tab", { name: /Claude/ })).toBeNull();
    });
  });

  it("lists the fourteen tools, free ones marked free and the three that spend money saying how they are charged", () => {
    const d = doc(mcp());
    const rows = [...d.querySelectorAll("table tbody tr")];
    expect(rows).toHaveLength(14);
    expect(rows.filter((r) => /Free$/.test(r.textContent ?? ""))).toHaveLength(11);
  });

  it("links the CLI and Skills pages only while they are switched on", () => {
    const off = renderToStaticMarkup(mcp({ showCli: false }));
    const on = renderToStaticMarkup(mcp({ showCli: true }));
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
    expect(skills).toContain(SKILLS_INSTALL.split("\n")[0]);
    expect(skills).toContain(CLI_INSTALL);
    expect((cli.match(/st-copy/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the public shell links the developer pages as one group", () => {
  const t = dictionaries.en;

  beforeEach(() => vi.stubEnv("DEV_CLI_PAGE", ""));

  it("the top menu has one Developers group: the API reference, MCP and API pricing, and CLI and Skills only when on", () => {
    const groups = publicNav(t, { devPages: false }).filter((e) => e.kind === "group" && e.id === "developers");
    expect(groups).toHaveLength(1);
    expect(navHrefs(groups)).toEqual(["/docs/api", "/mcp", "/docs/api#pricing"]);
    // Nowhere else in the bar: no API link beside the group.
    expect(navHrefs(publicNav(t, { devPages: false })).filter((h) => h.startsWith("/docs") || h === "/mcp")).toEqual(navHrefs(groups));
    expect(navHrefs(publicNav(t, { devPages: true }).filter((e) => e.kind === "group" && e.id === "developers"))).toEqual([
      "/docs/api",
      "/mcp",
      "/docs/api#pricing",
      "/docs/cli",
      "/docs/skills",
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
