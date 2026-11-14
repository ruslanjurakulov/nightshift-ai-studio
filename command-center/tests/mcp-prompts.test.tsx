// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
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
import { McpPrompts } from "@/components/docs/McpPrompts";
import { PROMPT_GALLERY, promptDoor } from "@/lib/dev/mcp-prompts";
import { MCP_CLIENTS, claudeDesktopPromptLink } from "@/lib/dev/mcp-clients";
import { mcpClientAvailability, mcpConnectOffered } from "@/lib/dev/mcp-availability";
import { OAUTH_TOOL_SCOPES } from "@/lib/api/mcp-oauth";
import { STUDIO_TOOL_NAMES, TOOL_NAMES } from "@/lib/api/mcp";
import { devDictionaries } from "@/lib/i18n/dev";
import type { Locale } from "@/lib/i18n";

/**
 * /mcp's prompt gallery, the "Not tested yet" tab note and the two new questions. What would break: a card promising a
 * tool the server does not have, a Studio prompt labelled as working in a chat app (a sign-in is never offered the
 * Studio's tools), an "Open in Claude" link drawn where connecting is not offered or on a card Claude cannot run, a copy
 * button that copies something other than the prompt, an assistant whose steps nobody tested shown without saying so.
 */

afterEach(() => cleanup());

const LOCALES: Locale[] = ["en", "ru", "uz"];
const page = (locale: Locale, oauthLive: boolean, tab?: string) =>
  renderToStaticMarkup(<McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={{ table: "Table", code: "Code" }} showCli={false} oauthLive={oauthLive} initialTab={tab} />);
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("the prompt gallery's data", () => {
  it("has 6 to 8 prompts, and every tool a card names is one the server really has", () => {
    expect(PROMPT_GALLERY.length).toBeGreaterThanOrEqual(6);
    expect(PROMPT_GALLERY.length).toBeLessThanOrEqual(8);
    for (const p of PROMPT_GALLERY) for (const t of p.tools) expect(TOOL_NAMES as readonly string[], `${p.id}: ${t}`).toContain(t);
  });

  it("covers the asks people come for: balance, models, a 10-second quote, planning the next video", () => {
    const by = Object.fromEntries(PROMPT_GALLERY.map((p) => [p.id, p.tools as readonly string[]]));
    expect(by.balance).toContain("get_balance");
    expect(by.models).toContain("list_models");
    expect(by.quote).toContain("quote_generation");
    expect(by.plan).toEqual(expect.arrayContaining(["list_channels", "list_videos"]));
    expect(devDictionaries.en.mcp.land.prompts.items.find((i) => i.id === "quote")!.prompt).toMatch(/10-second/);
  });

  it("a card works over a sign-in only when every tool it needs is offered to a sign-in (OAUTH_TOOL_SCOPES)", () => {
    for (const p of PROMPT_GALLERY) {
      const signIn = p.tools.every((t) => Object.hasOwn(OAUTH_TOOL_SCOPES, t));
      expect(promptDoor(p.tools), p.id).toBe(signIn ? "both" : "key");
    }
    // The Studio's tools are never offered to a sign-in, so every card that uses one is key-only, and every key-only card uses one
    // (its label says "with Studio permissions").
    for (const t of STUDIO_TOOL_NAMES) expect(Object.hasOwn(OAUTH_TOOL_SCOPES, t), t).toBe(false);
    for (const p of PROMPT_GALLERY) {
      const studio = p.tools.some((t) => (STUDIO_TOOL_NAMES as readonly string[]).includes(t));
      expect(promptDoor(p.tools) === "key", p.id).toBe(studio);
    }
  });

  it("has one card of copy per prompt id, in code order, in every language, and no copy says a video's price is shown first", () => {
    for (const locale of LOCALES) {
      const p = devDictionaries[locale].mcp.land.prompts;
      expect(p.items.map((i) => i.id)).toEqual(PROMPT_GALLERY.map((x) => x.id));
      expect(JSON.stringify(p)).not.toMatch(/price before|tell me the price|before it starts|показывает цену|назови цену|скажи цену|narxini koʻrsatadi|narx avval/i);
    }
  });
});

describe.each(LOCALES)("the prompt gallery on the page (%s)", (locale) => {
  const p = devDictionaries[locale].mcp.land.prompts;

  it("sits after the examples and before the tool list, one card per prompt, each with exactly one copy button and its tools", () => {
    const html = page(locale, true);
    const at = html.indexOf('id="prompts-title"');
    expect(at).toBeGreaterThan(html.indexOf('id="examples-title"'));
    expect(at).toBeLessThan(html.indexOf('id="tools"'));
    const cards = [...doc(html).querySelectorAll(".mp-card")];
    expect(cards.map((c) => c.getAttribute("data-id"))).toEqual(PROMPT_GALLERY.map((x) => x.id));
    for (const card of cards) {
      const item = PROMPT_GALLERY.find((x) => x.id === card.getAttribute("data-id"))!;
      expect(card.querySelectorAll("button.st-copy")).toHaveLength(1);
      expect([...card.querySelectorAll(".mp-tool")].map((c) => c.textContent)).toEqual([...item.tools]);
      expect(card.querySelector(".mp-prompt")?.textContent).toBe(p.items.find((i) => i.id === item.id)!.prompt);
    }
  });

  it("with the sign-in on: 'Open in Claude' only on cards a sign-in can run, each the documented desktop link with that exact prompt", () => {
    expect(mcpConnectOffered("claude", true)).toBe(true);
    const cards = [...doc(page(locale, true)).querySelectorAll(".mp-card")];
    for (const card of cards) {
      const item = PROMPT_GALLERY.find((x) => x.id === card.getAttribute("data-id"))!;
      const links = [...card.querySelectorAll("a")];
      const prompt = p.items.find((i) => i.id === item.id)!.prompt;
      if (promptDoor(item.tools) === "both") {
        expect(links, item.id).toHaveLength(1);
        const href = links[0].getAttribute("href")!;
        expect(href).toBe(claudeDesktopPromptLink(prompt));
        expect(href.startsWith("claude://claude.ai/new?q=")).toBe(true);
        expect(decodeURIComponent(href.slice("claude://claude.ai/new?q=".length))).toBe(prompt);
        // A custom scheme: same tab, never a blank new one.
        expect(links[0].getAttribute("target")).toBeNull();
        expect(card.querySelector(".mp-door")?.textContent).toBe(p.door.either);
      } else {
        expect(links, item.id).toHaveLength(0);
        expect(card.querySelector(".mp-door")?.textContent).toBe(p.door.studioKey);
      }
    }
    expect(doc(page(locale, true)).body.textContent).toContain(p.openClaudeHint);
  });

  it("with the sign-in off: no 'Open in Claude' anywhere, and no card says it works with a sign-in", () => {
    expect(mcpConnectOffered("claude", false)).toBe(false);
    const d = doc(page(locale, false));
    expect(d.querySelectorAll('.mp-card a[href^="claude:"]')).toHaveLength(0);
    expect(d.body.textContent).not.toContain(p.openClaudeHint);
    const doors = [...d.querySelectorAll(".mp-door")].map((x) => x.textContent);
    expect(doors).not.toContain(p.door.either);
    expect(new Set(doors)).toEqual(new Set([p.door.key, p.door.studioKey]));
  });

  it("never uses a web prefill link (claude.ai/new?q= over https and chatgpt.com/?q= are not in their vendors' docs)", () => {
    for (const on of [true, false]) {
      const html = page(locale, on);
      expect(html).not.toMatch(/https:\/\/claude\.ai\/new\?q=|chatgpt\.com\/\?q=|chat\.openai\.com\/\?q=/);
    }
  });
});

describe("the copy buttons copy the prompt itself", () => {
  it.each(LOCALES)("%s: pressing a card's 'Copy prompt' puts exactly that prompt on the clipboard and says it was copied", async (locale) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = render(<McpPrompts dev={devDictionaries[locale]} oauthLive />);
    const p = devDictionaries[locale].mcp.land.prompts;
    for (const item of PROMPT_GALLERY) {
      const card = container.querySelector(`.mp-card[data-id="${item.id}"]`) as HTMLElement;
      const words = p.items.find((i) => i.id === item.id)!;
      const button = within(card).getByRole("button", { name: devDictionaries[locale].ui.copyName.replace("{name}", `${p.copyName} (${words.title})`) });
      expect(button.textContent).toBe(p.copy);
      fireEvent.click(button);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(words.prompt));
      await waitFor(() => expect(button.textContent).toBe(devDictionaries[locale].ui.copied));
    }
    expect(writeText).toHaveBeenCalledTimes(PROMPT_GALLERY.length);
  });
});

describe("a tab whose sign-in nobody has tested says so", () => {
  const unverified = MCP_CLIENTS.filter((c) => mcpClientAvailability(c.id, true) === "unverified");
  const ready = MCP_CLIENTS.filter((c) => mcpClientAvailability(c.id, true) === "ready");

  it("there is something to check: Gemini and Grok are only their vendors' steps; ChatGPT and Claude are ready", () => {
    expect(unverified.map((c) => c.id)).toEqual(["gemini", "grok"]);
    expect(ready.map((c) => c.id)).toEqual(["chatgpt", "claude"]);
  });

  it.each(LOCALES)("%s: 'Not tested yet' on exactly the unverified tabs, 'Ready to connect' on exactly the ready ones", (locale) => {
    const c = devDictionaries[locale].mcp;
    const d = doc(page(locale, true));
    for (const client of MCP_CLIENTS) {
      const panel = d.querySelector(`[role="tabpanel"][id$="-panel-${client.id}"]`);
      expect(panel, client.id).not.toBeNull();
      const note = panel!.querySelector('[data-availability="unverified"]');
      const isUnverified = unverified.some((u) => u.id === client.id);
      if (isUnverified) expect(note?.textContent, client.id).toContain(c.unverified.badge);
      else expect(note, client.id).toBeNull();
    }
    // Every tab panel is in the page; the notes are counted across all of them.
    const all = doc(page(locale, true));
    expect(all.querySelectorAll('[data-availability="unverified"]')).toHaveLength(unverified.length);
    expect(all.querySelectorAll('[data-availability="ready"]')).toHaveLength(ready.length);
  });

  it.each(LOCALES)("%s: with the sign-in off no tab says 'Not tested yet' (those assistants are not tabs at all)", (locale) => {
    expect(doc(page(locale, false)).querySelectorAll('[data-availability="unverified"]')).toHaveLength(0);
  });
});

describe.each(LOCALES)("the two new questions (%s)", (locale) => {
  const l = devDictionaries[locale].mcp.land;
  const answers = (html: string) =>
    Object.fromEntries([...doc(html).querySelectorAll("details.ml-faq-item")].map((d) => [d.querySelector("summary")?.textContent ?? "", d.querySelector("p")?.textContent ?? ""]));

  it("'does connecting spend credits' and 'what does my assistant see' are asked, with the key wording while the sign-in is off", () => {
    const [spend, sees] = [l.faq.items[8], l.faq.items[9]];
    const on = answers(page(locale, true));
    const off = answers(page(locale, false));
    expect(on[spend.q]).toBe(spend.a);
    expect(on[sees.q]).toBe(sees.a);
    expect(off[spend.q]).toBe(l.keyMode.faq.spend);
    expect(off[sees.q]).toBe(l.keyMode.faq.sees);
    // The key answers do not speak of a connected app's limit or of Connected apps.
    expect(l.keyMode.faq.spend).not.toMatch(/Connected apps|Подключённые приложения|Ulangan ilovalar/);
  });

  it("the spend answer names the three tools that spend, quote vs create, max_credits and the monthly limit", () => {
    for (const a of [l.faq.items[8].a, l.keyMode.faq.spend]) {
      for (const tool of ["create_video", "request_download", "create_generation", "quote_generation", "max_credits"]) expect(a).toContain(tool);
    }
    expect(l.faq.items[8].a).toMatch(/\b0\b/);
  });
});

describe("the new stylesheet keeps the type rules", () => {
  it("no size below 13px, no tracking, no capitals, weights 400/500/600 only", () => {
    const css = readFileSync(join(__dirname, "..", "components", "docs", "mcp-prompts.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect([...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1])).filter((n) => n < 13)).toEqual([]);
    expect([...css.matchAll(/letter-spacing:\s*(\d*\.?\d+)(?:em|px)/g)].map((m) => Number(m[1])).filter((n) => n > 0)).toEqual([]);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    expect([...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => ![400, 500, 600].includes(w))).toEqual([]);
  });
});
