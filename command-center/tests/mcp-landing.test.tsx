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

  it("names no model, provider or price: the moving rows are the assistants only; the publish targets are a still line of three", () => {
    const d = doc(page());
    const sr = d.querySelector(".ml-works")?.querySelector(".sr-only")?.textContent ?? "";
    for (const c of MCP_CLIENTS.filter((x) => x.id !== "other")) expect(sr).toContain(c.label);
    const mq = d.querySelector(".ml-mq")!;
    const pills = [...mq.querySelectorAll(".ml-mq-set:not(.ml-mq-dup) .ml-mq-pill")].map((p) => p.textContent?.trim());
    // Every client once per row: nothing repeats inside one row's first set, and no row is a provider or a filler.
    expect(pills).toHaveLength(MCP_CLIENTS.length - 1 + MCP_CLIENTS.length - 1);
    for (const row of mq.querySelectorAll(".ml-mq-row")) {
      const names = [...row.querySelectorAll(".ml-mq-set:not(.ml-mq-dup) .ml-mq-pill")].map((p) => p.textContent?.trim());
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(MCP_CLIENTS.some((c) => c.label === n)).toBe(true);
    }
    const pub = [...d.querySelectorAll(".ml-publish li")].map((li) => li.textContent?.trim());
    expect(pub).toEqual([...PUBLISH_TARGETS]);
    expect(d.querySelector(".ml-publish")?.closest(".ml-mq")).toBeNull();
    for (const locale of LOCALES) {
      const all = JSON.stringify(devDictionaries[locale].mcp.land);
      expect(all).not.toMatch(/[$€£]|\bUSD\b|\d\s?(?:cent|credits)\b/i);
    }
  });

  it.each(LOCALES)("%s: the trademark line sits next to the marquee", (locale) => {
    const d = doc(page(locale));
    expect(d.querySelector(".ml-works .ml-works-tm")?.textContent).toBe(devDictionaries[locale].mcp.trademarks);
  });

  it("makes no claim the docs do not: publishing keeps the gate, uploads stay private, the price is set aside when queued and charged only on success", () => {
    const en = devDictionaries.en.mcp.land;
    const rows = Object.fromEntries(en.every.rows.map((r) => [r.id, r.body]));
    expect(rows.approval).toMatch(/same publish check and approvals/);
    expect(rows.approval).toMatch(/private/);
    expect(rows.credits).toMatch(/queued, its price is set aside/);
    expect(rows.credits).toMatch(/charged only when the video succeeds/);
    expect(rows.credits).toMatch(/given back when it fails/);
    expect(en.faq.items.find((i) => /without asking/.test(i.q))?.a).toMatch(/^No\./);
    expect(en.frames.approve.lines.at(-1)).toMatch(/in the app/);
    expect(en.frames.approve.button).toMatch(/in the app/);
  });

  it.each(LOCALES)("%s: never says a price is shown or quoted before a video starts (no tool does that), nor promises a worse-voice fallback", (locale) => {
    const all = JSON.stringify(devDictionaries[locale].mcp.land);
    expect(all).not.toMatch(/shown first|shows its price before|price before|tell me the price|before it starts|narx avval|narxini koʻrsatadi|показан[аы]? заранее|показывает цену|назови цену|скажи цену/i);
    expect(all).not.toMatch(/worse one|yomonroq ovoz|голос похуже/i);
  });

  it("calls the last row a list of topics in one ask, not a batch (no batch tool exists)", () => {
    expect(devDictionaries.en.mcp.land.every.rows.find((r) => r.id === "batch")?.title).toBe("Run a whole list of topics in one ask");
    expect(MCP_TOOL_IDS.some((t) => /batch/i.test(t))).toBe(false);
  });

  it("uses two different words in Uzbek for the card badge and the frame caption", () => {
    const uz = devDictionaries.uz.mcp.land;
    expect(uz.examples.sample).toBe("Rasm (namuna)");
    expect(uz.frames.note).toBe("Tasvir, haqiqiy natija emas");
  });
});

describe("with sign-in off the page never promises an app connection", () => {
  const strip = (html: string) => doc(html).body.textContent ?? "";
  it.each(LOCALES)("%s: the cost, limit, assistants and disconnect copy speak of the API key until MCP_OAUTH_LIVE is on", (locale) => {
    const l = devDictionaries[locale].mcp.land;
    const off = strip(page(locale, "cursor", false));
    const on = strip(page(locale, "cursor", true));
    // Off: the key variants are on the page, the sign-in-only sentences are not.
    for (const t of [l.keyMode.credits, l.keyMode.works, l.keyMode.faq.assistants, l.keyMode.faq.cost, l.keyMode.faq.disconnect, l.keyMode.faq.credits]) expect(off).toContain(t);
    expect(off).not.toContain(l.every.rows.find((r) => r.id === "credits")!.body);
    expect(off).not.toContain(l.works.lead);
    expect(off).not.toContain(l.faq.items[4].a);
    expect(off).not.toContain(l.faq.items[2].a);
    // On: the plain copy, no key-only variant.
    for (const t of [l.keyMode.credits, l.keyMode.works, l.keyMode.faq.assistants, l.keyMode.faq.cost]) expect(on).not.toContain(t);
    expect(on).toContain(l.faq.items[4].a);
    expect(on).toContain(l.works.lead);
  });

  it("the English sign-in-only answers carry the word 'sign-in' only with 'coming soon' while the flag is off", () => {
    const l = devDictionaries.en.mcp.land.keyMode;
    for (const t of [l.works, l.faq.assistants, l.faq.cost]) expect(t).toMatch(/coming soon/);
    expect(l.faq.disconnect).not.toMatch(/Connected apps/);
  });
});

describe("the tab id from the address", () => {
  it("an unknown or inherited name ('constructor') opens the default tab, never throws", () => {
    for (const tab of ["constructor", "__proto__", "toString", "nope"]) {
      const d = doc(page("en", tab));
      expect(d.querySelector(".st-pill[aria-selected='true']")?.getAttribute("data-id"), tab).toBe("claude-code");
    }
  });
});

describe("the moving rows can be paused", () => {
  it.each(LOCALES)("%s: a 44 px toggle named in the page's language, pressed = paused, next to the heading", (locale) => {
    render(<McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={labels} showCli={false} oauthLive={false} />);
    const btn = screen.getByRole("button", { name: devDictionaries[locale].mcp.land.works.pause });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.closest(".ml-works-in")?.querySelector("#works-title")).toBeTruthy();
    const wrap = document.querySelector(".ml-works-wrap")!;
    expect(wrap.hasAttribute("data-paused")).toBe(false);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(wrap.hasAttribute("data-paused")).toBe(true);
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(wrap.hasAttribute("data-paused")).toBe(false);
  });

  it("is a native button (Enter and Space work), at least 44 px tall, and pauses every row; with reduced motion it is hidden because nothing moves", () => {
    expect(css).toMatch(/\.ml-mq-toggle\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.ml-works-wrap\[data-paused\] \.ml-mq-track\s*\{\s*animation-play-state:\s*paused/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.ml-mq-toggle \{ display: none; \} \}/);
    const d = doc(page());
    expect(d.querySelector(".ml-mq-toggle")?.tagName).toBe("BUTTON");
    expect(d.querySelector(".ml-mq-toggle")?.getAttribute("type")).toBe("button");
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
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const sets = r.querySelectorAll(".ml-mq-set");
      expect(sets).toHaveLength(2);
      expect(sets[0].innerHTML).toBe(sets[1].innerHTML);
    }
    expect(rows[1].hasAttribute("data-reverse")).toBe(true);
    expect(rows[0].hasAttribute("data-reverse")).toBe(false);
  });

  it("drifts slowly and, with reduced motion, does not move at all (the rows wrap into still pills)", () => {
    expect(css).toMatch(/\.ml-mq-track\s*\{[^}]*animation:\s*ml-mq var\(--mq-s, 90s\) linear infinite/);
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".ml-mq-set li")));
    expect(reduce).toMatch(/\.ml-mq-track\s*\{[^}]*animation:\s*none/);
    expect(reduce).toMatch(/\.ml-mq-dup\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.ml-mq:hover \.ml-mq-track,\s*\.ml-works-wrap\[data-paused\] \.ml-mq-track\s*\{\s*animation-play-state:\s*paused/);
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
