// @vitest-environment jsdom
// Breach on PR #744 (rule 5: never render an assumption as a measurement). lib/dev/mcp-availability.ts says "ready" means
// "show the steps, do not say works in …" and "unverified" means "nothing more is known", yet with MCP_OAUTH_LIVE on the same
// /mcp page still tells a reader (and a screen reader, first thing) that it WORKS with every sign-in-only assistant, and the
// FAQ answers "Which assistants work with it?" with all of them, Gemini and Grok included. Until the owner records a real
// connection ("confirmed"), only assistants whose availability is "available" may be named as working.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { McpPage } from "@/components/docs/McpPage";
import { MCP_CLIENTS } from "@/lib/dev/mcp-clients";
import { mcpClientAvailability } from "@/lib/dev/mcp-availability";
import { devDictionaries } from "@/lib/i18n/dev";
import type { Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const doc = (locale: Locale) =>
  new DOMParser().parseFromString(
    renderToStaticMarkup(
      <McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={{ table: "Table", code: "Code" }} showCli={false} oauthLive />,
    ),
    "text/html",
  );
const notYetWorking = MCP_CLIENTS.filter((c) => mcpClientAvailability(c.id, true) !== "available").map((c) => c.label);

describe("/mcp with the sign-in on names as working only what has been seen to work", () => {
  it("there is something to check: ChatGPT, Claude, Gemini and Grok are not yet available", () => {
    expect(notYetWorking).toEqual(expect.arrayContaining(["ChatGPT", "Claude", "Gemini", "Grok"]));
  });

  it.each(LOCALES)("%s: the 'Works with' line names no assistant that is only ready or unverified", (locale) => {
    const label = devDictionaries[locale].mcp.worksWith;
    const line = [...doc(locale).querySelectorAll("p")].map((p) => p.textContent ?? "").find((t) => t.startsWith(`${label}:`));
    expect(line, "the Works with line is on the page").toBeDefined();
    for (const name of notYetWorking) expect(line).not.toContain(name);
  });

  it.each(LOCALES)("%s: the FAQ's 'which assistants work with it' answer names no assistant that is only ready or unverified", (locale) => {
    const items = [...doc(locale).querySelectorAll("details.ml-faq-item")];
    const q = devDictionaries[locale].mcp.land.faq.items[2].q;
    const answer = items.find((d) => d.querySelector("summary")?.textContent === q)?.querySelector("p")?.textContent;
    expect(answer, "the FAQ item is on the page").toBeDefined();
    for (const name of notYetWorking) expect(answer).not.toContain(name);
  });
});
