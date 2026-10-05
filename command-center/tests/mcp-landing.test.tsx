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
import { dictionaries } from "@/lib/i18n";
import { chatCopy } from "@/components/landing/HeroCard";
import { MCP_CLIENTS, MCP_TOOL_IDS } from "@/lib/dev/mcp-clients";
import { ASK_IDS, CAPABILITY_ROWS, EXAMPLE_SCENES } from "@/lib/dev/mcp-landing";

afterEach(() => cleanup());

const LOCALES: Locale[] = ["en", "ru", "uz"];
const labels = { table: "Table", code: "Code" };
const css = readFileSync(join(__dirname, "..", "components", "site", "site.css"), "utf8");

const chatFor = (locale: Locale) => chatCopy(dictionaries[locale], "mcp.card", devDictionaries[locale].mcp.land.asks.items[0].prompt);
const page = (locale: Locale = "en", tab?: string, oauthLive = false) =>
  renderToStaticMarkup(
    <McpPage dev={devDictionaries[locale]} chat={chatFor(locale)} origin="https://example.test" labels={labels} showCli={false} oauthLive={oauthLive} initialTab={tab} />,
  );
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("the long /mcp page: order of sections", () => {
  it.each(LOCALES)("%s: hero, six asks, examples, tools, questions, explore, closing, in that order (no walk-through, no works-with row)", (locale) => {
    const html = page(locale);
    const order = ["mcp-title", "every-title", "examples-title", "faq-title", "explore-title", "mcp-close-title"].map((id) => html.indexOf(`id="${id}"`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The tool list sits between the examples and the questions.
    const tools = html.indexOf('id="tools"');
    expect(tools).toBeGreaterThan(html.indexOf('id="examples-title"'));
    expect(tools).toBeLessThan(html.indexOf('id="faq-title"'));
    for (const gone of ["how-title", "asks-title", "works-title"]) expect(html).not.toContain(`id="${gone}"`);
  });

  it("has six asks as plain cards, in the planned order, each with a label, a headline, a paragraph and one button that copies the ask", () => {
    const d = doc(page());
    const rows = [...d.querySelectorAll(".nx-mcp-ask")];
    expect(rows.map((r) => r.getAttribute("data-id"))).toEqual(["video", "channels", "language", "approval", "credits", "batch"]);
    for (const r of rows) {
      expect(r.querySelector(".ml-pillbadge")?.textContent?.trim()).toBeTruthy();
      expect(r.querySelector("h3")?.textContent?.trim()).toBeTruthy();
      expect(r.querySelector(".ml-cap-body")?.textContent?.trim().length).toBeGreaterThan(40);
      expect(r.querySelectorAll(".ml-cap-cta button")).toHaveLength(1);
      // Plain cards: no drawn frame, no picture (the pictures are the hero's chat card and the examples).
      expect(r.querySelector("img, .ml-frame, .ml-fig")).toBeNull();
    }
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

  it("keeps the ten tools one tap away: a native disclosure around the table, every tool still in the page", () => {
    const d = doc(page());
    const box = d.querySelector("details.nx-mcp-tools")!;
    expect(box).toBeTruthy();
    expect(box.hasAttribute("open")).toBe(false);
    for (const id of MCP_TOOL_IDS) expect(box.textContent).toContain(id);
  });
});

describe("the hero: a chat card instead of a row of client logos", () => {
  it.each(LOCALES)("%s: the ask, an \"example reply\", an example still with its badge and note, a drawn button nobody can press, and no logo row", (locale) => {
    const d = doc(page(locale));
    const top = d.querySelector(".nx-mcp-top")!;
    const card = top.querySelector("figure.nx-chat")!;
    const land = devDictionaries[locale].mcp.land;
    const site = dictionaries[locale].site;
    expect(top.querySelector("h1")).toBeTruthy();
    expect(card.querySelector(".nx-bubble")?.textContent).toBe(land.asks.items[0].prompt);
    expect(card.querySelector(".nx-reply span")?.textContent?.trim()).toBe(site.caps.exampleReply);
    expect(card.querySelector(".nx-result-badge")?.textContent).toBe(site.samples.tag);
    expect(card.querySelector(".nx-demo-note")?.textContent).toBe(site.samples.note);
    const img = card.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe(site.samples.alts.lighthouse);
    expect(img.getAttribute("loading")).toBe("eager");
    expect(card.querySelector(".nx-chat-foot")?.getAttribute("aria-hidden")).toBe("true");
    expect(card.querySelectorAll("button, a")).toHaveLength(0);
    expect(card.querySelector(".nx-ui-status svg, .nx-ui-play")).toBeNull();
    expect(d.querySelector(".st-tiles")).toBeNull();
  });
});

describe("one page for every tab", () => {
  it.each(MCP_CLIENTS.map((c) => [c.id] as const))("%s: opens its own install panel (sign-in on), and every tab still has its steps", (id) => {
    const d = doc(page("en", id, true));
    expect(d.querySelector(`.st-pill[data-id="${id}"]`)?.getAttribute("aria-selected")).toBe("true");
    expect(d.querySelectorAll(".st-tabpanel")).toHaveLength(MCP_CLIENTS.length);
  });

  it("is the same text under the card on two tabs", () => {
    const strip = (tab: string) => {
      const d = doc(page("en", tab));
      return ["every-title", "examples-title", "explore-title"].map((id) => d.getElementById(id)?.closest("section")?.textContent);
    };
    expect(strip("cursor")).toEqual(strip("hermes"));
  });
});

describe("the pictures are honest", () => {
  it.each(LOCALES)("%s: the example cards are labelled on the card, described, lazy, and only example stills (no video, audio or remote picture)", (locale) => {
    const d = doc(page(locale));
    const cards = [...d.querySelectorAll(".ml-ex")];
    expect(cards).toHaveLength(6);
    for (const c of cards) expect(c.querySelector(".ml-ex-badge")?.textContent).toBe(devDictionaries[locale].mcp.land.examples.sample);
    const alts = devDictionaries[locale].mcp.land.examples.alts;
    for (const c of cards) {
      const img = c.querySelector("img")!;
      expect(Object.values(alts)).toContain(img.getAttribute("alt"));
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("src") ?? "").not.toMatch(/^https?:/);
    }
    expect(d.querySelectorAll("video, audio, picture")).toHaveLength(0);
    // Every picture on the page: the hero's still plus the six examples.
    expect(d.querySelectorAll("img")).toHaveLength(7);
  });

  it.each([true, false])("names no model, provider or price (sign-in live: %s)", (live) => {
    const d = doc(page("en", undefined, live));
    expect(d.body.textContent ?? "").not.toMatch(/\b(?:GPT-?\d|Gemini \d|Sora|Veo|Imagen|Midjourney|Runway|Kling|ElevenLabs|OpenAI model)\b/);
    for (const locale of LOCALES) {
      const all = JSON.stringify(devDictionaries[locale].mcp.land);
      expect(all).not.toMatch(/[$€£]|\bUSD\b|\d\s?(?:cent|credits)\b/i);
    }
  });

  it.each(LOCALES)("%s: the trademark line sits under the connect card", (locale) => {
    const d = doc(page(locale));
    expect(d.querySelector(".st-trademarks")?.textContent).toBe(devDictionaries[locale].mcp.trademarks);
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
});

describe("with sign-in off the page never promises an app connection", () => {
  const strip = (html: string) => doc(html).body.textContent ?? "";
  it.each(LOCALES)("%s: the cost, limit and credits copy speak of the API key until MCP_OAUTH_LIVE is on", (locale) => {
    const l = devDictionaries[locale].mcp.land;
    const off = strip(page(locale, "cursor", false));
    const on = strip(page(locale, "cursor", true));
    for (const t of [l.keyMode.credits, l.keyMode.faq.assistants, l.keyMode.faq.cost, l.keyMode.faq.disconnect, l.keyMode.faq.credits]) expect(off).toContain(t);
    expect(off).not.toContain(l.every.rows.find((r) => r.id === "credits")!.body);
    expect(off).not.toContain(l.faq.items[4].a);
    expect(off).not.toContain(l.faq.items[2].a);
    for (const t of [l.keyMode.credits, l.keyMode.faq.assistants, l.keyMode.faq.cost]) expect(on).not.toContain(t);
    expect(on).toContain(l.faq.items[4].a);
  });

  it("the English sign-in-only answers carry the word 'sign-in' only with 'coming soon' while the flag is off", () => {
    const l = devDictionaries.en.mcp.land.keyMode;
    for (const t of [l.works, l.faq.assistants, l.faq.cost]) expect(t).toMatch(/coming soon/);
    expect(l.faq.disconnect).not.toMatch(/Connected apps/);
  });

  it.each(LOCALES)("%s: the lead, the notes and the connect answer use the key wording", (locale) => {
    const dev = devDictionaries[locale].mcp;
    const off = strip(page(locale, "cursor", false));
    const on = strip(page(locale, "cursor", true));
    expect(off).toContain(dev.signinOff.paidLine);
    expect(off).toContain(dev.signinOff.paidBody);
    expect(off).toContain(dev.land.keyMode.faq.connect);
    expect(off).not.toContain(dev.paidLine);
    expect(off).not.toContain(dev.paid.body);
    expect(on).toContain(dev.paidLine);
    expect(on).toContain(dev.paid.body);
    expect(on).not.toContain(dev.signinOff.paidLine);
  });

  it.each(LOCALES)("%s: the hero lead does not promise the app's price list (the key door has its own balance)", (locale) => {
    expect(devDictionaries[locale].mcp.lead).not.toMatch(/price list|прайс|narxlar roʻyxati/i);
    expect(devDictionaries[locale].mcp.lead).toMatch(/publish check|проверкой публикации|nashr tekshiruvi/);
  });

  it.each(LOCALES)("%s: the page description does not say Claude or ChatGPT connect while the flag is off", (locale) => {
    const m = devDictionaries[locale].mcp;
    expect(m.signinOff.description).not.toMatch(/(?:Connect|Подключите)\s+Claude,\s+ChatGPT/);
    expect(m.meta.description).toMatch(/Claude, ChatGPT/);
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

describe("the /mcp hero keeps its lead from jumping (round 4)", () => {
  it("left-aligned copy, so a font swap cannot re-centre its lines (the CLS of 0.082 on the English page), and the lead still holds three lines on a desktop", () => {
    const next = readFileSync(join(__dirname, "..", "components", "site", "site-next.css"), "utf8");
    expect(next).toMatch(/\.nx-mcp-top \{[^}]*text-align: start/);
    expect(next).toMatch(/\.nx-mcp-top \.st-mcphero-h1 \{ text-align: start/);
    expect(css).toMatch(/\.st-mcphero-lead \{ min-height: calc\(3 \* 1\.6em\); \}/);
  });
});
