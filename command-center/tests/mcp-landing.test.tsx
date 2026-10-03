// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { McpPage } from "@/components/docs/McpPage";
import { ResultsCarousel } from "@/components/docs/ResultsCarousel";
import { devDictionaries } from "@/lib/i18n/dev";
import type { Locale } from "@/lib/i18n";
import { MCP_CLIENTS, MCP_TOOL_IDS } from "@/lib/dev/mcp-clients";
import { ASK_IDS, CAPABILITY_ROWS, EXAMPLE_SCENES, PUBLISH_TARGETS } from "@/lib/dev/mcp-landing";

afterEach(() => cleanup());

const LOCALES: Locale[] = ["en", "ru", "uz"];
const labels = { table: "Table", code: "Code" };
const css = readFileSync(join(__dirname, "..", "components", "site", "site.css"), "utf8");

const page = (locale: Locale = "en", tab?: string, oauthLive = false) =>
  renderToStaticMarkup(
    <McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={labels} showCli={false} oauthLive={oauthLive} initialTab={tab} />,
  );
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("the long /mcp page: order of sections", () => {
  it.each(LOCALES)("%s: hero, how it works, asks, capabilities, examples, works with, tools, questions, explore, closing, in that order", (locale) => {
    const html = page(locale);
    const order = ["mcp-title", "how-title", "asks-title", "every-title", "examples-title", "works-title", "faq-title", "explore-title", "mcp-close-title"].map((id) => html.indexOf(`id="${id}"`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The tool list sits between "works with" and the questions.
    const tools = html.indexOf('id="tools"');
    expect(tools).toBeGreaterThan(html.indexOf('id="works-title"'));
    expect(tools).toBeLessThan(html.indexOf('id="faq-title"'));
  });

  it("has six capability rows, in the planned order, each with a label, a headline, a paragraph, one button, an ask, a reply and a drawn frame", () => {
    const d = doc(page());
    const rows = [...d.querySelectorAll(".ml-cap")];
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["video", "channels", "language", "approval", "credits", "batch"]);
    for (const r of rows) {
      expect(r.querySelector(".ml-pillbadge")?.textContent?.trim()).toBeTruthy();
      expect(r.querySelector("h3")?.textContent?.trim()).toBeTruthy();
      expect(r.querySelector(".ml-cap-body")?.textContent?.trim().length).toBeGreaterThan(40);
      expect(r.querySelectorAll(".ml-cap-cta button")).toHaveLength(1);
      expect(r.querySelector(".ml-bubble")?.textContent?.trim()).toBeTruthy();
      expect(r.querySelector(".ml-reply b")?.textContent).toBe("Nightshift");
      expect(r.querySelector(".ml-frame")).toBeTruthy();
    }
    // Alternating sides on a wide screen, and three small pictures only on the batch row.
    expect(rows.map((r) => r.hasAttribute("data-flip"))).toEqual([false, true, false, true, false, true]);
    expect(rows.map((r) => r.querySelectorAll(".ml-thumb").length)).toEqual([0, 0, 0, 0, 0, 3]);
  });

  it("every capability is one the server really has: its tools are in the tool list", () => {
    expect(CAPABILITY_ROWS).toHaveLength(6);
    for (const row of CAPABILITY_ROWS) for (const t of row.tools) expect(MCP_TOOL_IDS as readonly string[]).toContain(t);
  });

  it("the copy has one entry per row, ask and example, in code order, in every language", () => {
    for (const locale of LOCALES) {
      const l = devDictionaries[locale].mcp.land;
      expect(l.every.rows.map((r) => r.id)).toEqual(CAPABILITY_ROWS.map((r) => r.id));
      expect(l.asks.items.map((i) => i.id)).toEqual([...ASK_IDS]);
      expect(l.examples.cards.map((c) => c.id)).toEqual([...EXAMPLE_SCENES]);
      expect(l.faq.items).toHaveLength(8);
    }
  });
});

describe("one page for every tab: only the assistant's name changes", () => {
  it.each(MCP_CLIENTS.map((c) => [c.id, c.id === "other" ? "Other" : c.label] as const))("%s: names the assistant in the how-it-works lead, the chat and the asks heading, and opens its own install panel", (id, name) => {
    const d = doc(page("en", id));
    expect(d.querySelector(".st-how-lead")?.textContent).toContain(`Brief the work in ${name}.`);
    expect(d.querySelector("#asks-title")?.textContent).toContain(`Ask ${name} like this`);
    expect(d.querySelector(".ml-msg-client")?.textContent).toContain(name);
    expect(d.querySelector(`.st-pill[data-id="${id}"]`)?.getAttribute("aria-selected")).toBe("true");
    // Every tab still has its own install steps (a panel each), whichever one is open.
    expect(d.querySelectorAll(".st-tabpanel")).toHaveLength(MCP_CLIENTS.length);
  });

  it("is the same text under the card on two tabs, bar the assistant's name", () => {
    const strip = (tab: string, name: string) => {
      const d = doc(page("en", tab));
      // (the "works with" row and one answer list the assistants by name, in order; they are checked on their own)
      return ["every-title", "examples-title", "explore-title"].map((id) => d.getElementById(id)?.closest("section")?.textContent?.split(name).join("{client}"));
    };
    expect(strip("cursor", "Cursor")).toEqual(strip("hermes", "Hermes"));
  });

  it("changing the tab changes the name in the long page (one tab state for the card and the page)", () => {
    render(<McpPage dev={devDictionaries.en} origin="https://example.test" labels={labels} showCli={false} oauthLive={false} initialTab="claude-code" />);
    expect(screen.getByRole("heading", { name: /Ask Claude Code like this/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByRole("heading", { name: /Ask Cursor like this/ })).toBeTruthy();
    expect(document.querySelector(".st-how-lead")?.textContent).toContain("Brief the work in Cursor.");
    expect(document.querySelector(".ml-msg-client")?.textContent).toContain("Cursor");
  });
});

describe("the pictures are honest", () => {
  it.each(LOCALES)("%s: every drawn frame is captioned as an illustration, carries no number and no image file", (locale) => {
    const d = doc(page(locale));
    const frames = [...d.querySelectorAll("figure.ml-fig")];
    expect(frames).toHaveLength(6);
    const note = devDictionaries[locale].mcp.land.frames.note;
    for (const f of frames) {
      expect(f.querySelector("figcaption")?.textContent).toBe(note);
      expect(f.querySelector(".ml-frame")?.getAttribute("aria-hidden")).toBe("true");
      expect(f.textContent ?? "").not.toMatch(/\d/);
      expect(f.querySelectorAll("img, picture, video, audio, image")).toHaveLength(0);
    }
    // Example cards: each is labelled as an illustration on the card itself.
    const cards = [...d.querySelectorAll(".ml-ex")];
    expect(cards).toHaveLength(6);
    for (const c of cards) expect(c.querySelector(".ml-ex-badge")?.textContent).toBe(devDictionaries[locale].mcp.land.examples.sample);
    expect(d.querySelector(".ml-land")?.querySelectorAll("img, picture, video")).toHaveLength(0);
  });

  it("names no model, provider or price: the 'works with' rows are the assistants and the publish targets only", () => {
    const d = doc(page());
    const sr = d.querySelector(".ml-works")?.querySelector(".sr-only")?.textContent ?? "";
    for (const c of MCP_CLIENTS.filter((x) => x.id !== "other")) expect(sr).toContain(c.label);
    for (const t of PUBLISH_TARGETS) expect(sr).toContain(t);
    // (a row repeats its pills so one set is wider than any screen; the names are the same)
    const pills = [...d.querySelectorAll(".ml-mq-pill")].map((p) => p.textContent?.trim());
    expect(new Set(pills.filter((p) => p && !MCP_CLIENTS.some((c) => c.label === p)))).toEqual(new Set(PUBLISH_TARGETS));
    for (const locale of LOCALES) {
      const all = JSON.stringify(devDictionaries[locale].mcp.land);
      expect(all).not.toMatch(/[$€£]|\bUSD\b|\d\s?(?:cent|credits)\b/i);
    }
  });

  it("makes no claim the docs do not: publishing keeps the gate, uploads stay private, a failed run costs nothing", () => {
    const en = devDictionaries.en.mcp.land;
    const rows = Object.fromEntries(en.every.rows.map((r) => [r.id, r.body]));
    expect(rows.approval).toMatch(/same publish check and approvals/);
    expect(rows.approval).toMatch(/private/);
    expect(rows.credits).toMatch(/charged only when it succeeds/);
    expect(rows.credits).toMatch(/given back when it fails/);
    expect(en.faq.items.find((i) => /without asking/.test(i.q))?.a).toMatch(/^No\./);
  });
});

describe("the examples carousel is operable by keyboard and screen reader", () => {
  const cards = ["a", "b", "c"].map((x) => <button key={x}>{x}</button>);
  const labelsC = { region: "Examples", track: "Cards", prev: "Previous", next: "Next" };
  // jsdom has no layout: say the row is wider than its box.
  const widths = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });
  };

  it("is a labelled carousel of numbered slides, with a focusable named track and two named buttons", () => {
    widths();
    render(<ResultsCarousel cards={cards} labels={labelsC} slideLabel="{n} of {total}" />);
    expect(screen.getByRole("group", { name: "Examples" }).getAttribute("aria-roledescription")).toBe("carousel");
    expect(screen.getByRole("group", { name: "Cards" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("group", { name: "1 of 3" }).getAttribute("aria-roledescription")).toBe("slide");
    expect(screen.getByRole("group", { name: "3 of 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });

  it("steps one card on a press, gliding unless motion is reduced", () => {
    widths();
    const scrollBy = vi.fn();
    Element.prototype.scrollBy = scrollBy as unknown as typeof Element.prototype.scrollBy;
    const mm = (reduce: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    mm(false);
    render(<ResultsCarousel cards={cards} labels={labelsC} slideLabel="{n} of {total}" />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "smooth" }));
    cleanup();
    mm(true);
    render(<ResultsCarousel cards={cards} labels={labelsC} slideLabel="{n} of {total}" />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: "auto" }));
    vi.unstubAllGlobals();
  });
});

describe("the marquee", () => {
  it("is decoration: hidden from assistive technology, nothing focusable inside, the loop copy of each row is a duplicate", () => {
    const d = doc(page());
    const mq = d.querySelector(".ml-mq")!;
    expect(mq.getAttribute("aria-hidden")).toBe("true");
    expect(mq.querySelectorAll("a, button, input, [tabindex]")).toHaveLength(0);
    const rows = [...mq.querySelectorAll(".ml-mq-row")];
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const sets = r.querySelectorAll(".ml-mq-set");
      expect(sets).toHaveLength(2);
      expect(sets[0].innerHTML).toBe(sets[1].innerHTML);
    }
    expect(rows[1].hasAttribute("data-reverse")).toBe(true);
  });

  it("drifts slowly and, with reduced motion, does not move at all (the rows wrap into still pills)", () => {
    expect(css).toMatch(/\.ml-mq-track\s*\{[^}]*animation:\s*ml-mq var\(--mq-s, 90s\) linear infinite/);
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".ml-mq-set li")));
    expect(reduce).toMatch(/\.ml-mq-track\s*\{[^}]*animation:\s*none/);
    expect(reduce).toMatch(/\.ml-mq-dup,\s*\.ml-mq-rep\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.ml-mq:hover \.ml-mq-track\s*\{\s*animation-play-state:\s*paused/);
  });
});

describe("the questions", () => {
  it.each(LOCALES)("%s: eight disclosures, native (keyboard and no-JS work), each with an answer", (locale) => {
    const d = doc(page(locale));
    const items = [...d.querySelectorAll("details.ml-faq-item")];
    expect(items).toHaveLength(8);
    for (const i of items) {
      expect(i.querySelector("summary")?.textContent?.trim().length).toBeGreaterThan(8);
      expect(i.querySelector("p")?.textContent?.trim().length).toBeGreaterThan(30);
    }
  });
});

describe("what did not change", () => {
  it("keeps the two flags' meaning: with sign-in off the Claude and ChatGPT tabs say 'Coming soon'; with it on they carry steps", () => {
    const off = doc(page("en", "claude", false));
    expect(off.querySelector('[role="tabpanel"] .st-soon')).toBeTruthy();
    const on = doc(page("en", "claude", true));
    expect(on.querySelectorAll(".st-soon")).toHaveLength(0);
    expect(on.querySelector('.st-pill[data-id="claude"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the CLI and skills links in 'explore more' only when the page flag is on", () => {
    const withFlag = renderToStaticMarkup(<McpPage dev={devDictionaries.en} origin="https://example.test" labels={labels} showCli oauthLive={false} />);
    expect(withFlag).toContain('href="/docs/cli"');
    expect(withFlag).toContain('href="/docs/skills"');
    const without = page();
    expect(without).not.toContain('href="/docs/cli"');
    expect(without).not.toContain('href="/docs/skills"');
  });
});
