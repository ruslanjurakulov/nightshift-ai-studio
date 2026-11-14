// @vitest-environment jsdom
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
import { MCP_CLIENT_IDS } from "@/lib/dev/mcp-clients";
import { MCP_SIGN_IN, mcpClientAvailability, mcpConnectOffered } from "@/lib/dev/mcp-availability";
import { devDictionaries } from "@/lib/i18n/dev";
import type { Locale } from "@/lib/i18n";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const SIGN_IN_ONLY = ["chatgpt", "claude", "gemini", "grok"];
const page = (locale: Locale, oauthLive: boolean) =>
  renderToStaticMarkup(
    <McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={{ table: "Table", code: "Code" }} showCli={false} oauthLive={oauthLive} />,
  );
const readyNotes = (html: string) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll('[data-availability="ready"]')].map((n) => n.textContent ?? "");

describe("one availability per assistant (lib/dev/mcp-availability.ts)", () => {
  it("names every assistant the page shows, and nothing else", () => {
    expect(Object.keys(MCP_SIGN_IN).sort()).toEqual([...MCP_CLIENT_IDS].sort());
  });

  it("ChatGPT and Claude are ready, not confirmed: no real account has connected yet, so nothing may say they work", () => {
    expect(MCP_SIGN_IN.chatgpt).toBe("ready");
    expect(MCP_SIGN_IN.claude).toBe("ready");
    expect(Object.values(MCP_SIGN_IN)).not.toContain("confirmed");
  });

  it("with the sign-in off, every sign-in-only assistant is coming soon and no link may send anyone to connect it", () => {
    for (const id of SIGN_IN_ONLY) {
      expect(mcpClientAvailability(id, false)).toBe("soon");
      expect(mcpConnectOffered(id, false)).toBe(false);
    }
  });

  it("with the sign-in on, ChatGPT and Claude are ready to connect; Gemini and Grok are only the vendor's own steps", () => {
    expect(mcpClientAvailability("chatgpt", true)).toBe("ready");
    expect(mcpClientAvailability("claude", true)).toBe("ready");
    expect(mcpConnectOffered("chatgpt", true)).toBe(true);
    expect(mcpConnectOffered("claude", true)).toBe(true);
    for (const id of ["gemini", "grok"]) {
      expect(mcpClientAvailability(id, true)).toBe("unverified");
      expect(mcpConnectOffered(id, true)).toBe(false);
    }
  });

  it("Cursor and VS Code take an API key, so they are available whether or not the sign-in is on", () => {
    for (const id of ["cursor", "vscode"]) for (const live of [false, true]) expect(mcpClientAvailability(id, live)).toBe("available");
  });

  it("an id the page does not know is never offered", () => {
    for (const id of ["", "codex", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(mcpClientAvailability(id, true)).toBe("soon");
      expect(mcpConnectOffered(id, true)).toBe(false);
    }
  });
});

describe("/mcp says ready, never works, for ChatGPT and Claude", () => {
  it.each(LOCALES)("%s: with the sign-in on, the ChatGPT and Claude tabs carry the ready note naming the app, and no other tab does", (locale) => {
    const notes = readyNotes(page(locale, true));
    expect(notes).toHaveLength(2);
    const r = devDictionaries[locale].mcp.ready;
    expect(notes[0]).toContain(r.badge);
    expect(notes[0]).toContain("ChatGPT");
    expect(notes[1]).toContain("Claude");
    for (const n of notes) expect(n).not.toMatch(/\{app\}/);
  });

  it.each(LOCALES)("%s: with the sign-in off there is no ready note anywhere", (locale) => {
    expect(readyNotes(page(locale, false))).toEqual([]);
  });

  it.each(LOCALES)("%s: the ready copy claims nothing it cannot know (no works, tested or verified in the app itself)", (locale) => {
    const r = devDictionaries[locale].mcp.ready;
    expect(r.body).toContain("{app}");
    expect(`${r.badge} ${r.body}`).not.toMatch(/\b(works|worked|tested|verified|certified|approved)\b|работает|проверен|ishlaydi|tekshirilgan/i);
  });
});
