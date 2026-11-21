// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: [], error: null })));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("@/lib/i18n/en");
  return { useI18n: () => ({ t: en, locale: "en" }) };
});

import {
  CHATGPT_MCP_GUIDE,
  MCP_GUIDES,
  INSTALL_CLIENT_IDS,
  MCP_CLIENTS,
  OAUTH_CLIENT_IDS,
  claudeConnectorLink,
  cursorInstallLink,
  installLink,
  vscodeInstallLink,
  vscodeWebInstallLink,
} from "@/lib/dev/mcp-clients";
import { McpPage } from "@/components/docs/McpPage";
import { validateRedirectUri } from "@/lib/oauth/redirect";
import { ConnectedApps } from "@/components/developers/ConnectedApps";
import { devDictionaries } from "@/lib/i18n/dev";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import type { Locale } from "@/lib/i18n";

/**
 * "Add to Claude / Cursor / VS Code", and the steps by hand for ChatGPT, Gemini and Grok. Each link is
 * a format read in the vendor's own docs and never tried end to end, so these
 * tests pin the exact bytes (a wrong encoding fails silently in someone else's
 * app), that no key can ever ride in one, that the steps by hand stay beside
 * every button, that the page names only the six assistants the owner kept,
 * and that no button is drawn while the server's sign-in is off (it would start
 * a flow the server cannot finish).
 */

const PROD = "https://nightshift-ai.studio/api/mcp";
const LOCALES: Locale[] = ["en", "ru", "uz"];
const SIX = ["chatgpt", "claude", "gemini", "grok", "cursor", "vscode"];
const STEPS_ONLY = ["chatgpt", "gemini", "grok"];

afterEach(() => cleanup());

describe("the install links, byte for byte", () => {
  it("Claude: the add-connector dialog, prefilled, for a person or for an organization", () => {
    expect(claudeConnectorLink(PROD)).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Nightshift&connectorUrl=https%3A%2F%2Fnightshift-ai.studio%2Fapi%2Fmcp",
    );
    expect(claudeConnectorLink(PROD, "organization")).toBe(
      "https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Nightshift&connectorUrl=https%3A%2F%2Fnightshift-ai.studio%2Fapi%2Fmcp",
    );
  });

  it("Cursor: base64 of the server object itself ({url}), not of an mcpServers map, with nothing that a query parser would turn into a space", () => {
    const link = cursorInstallLink(PROD);
    expect(link).toBe("cursor://anysphere.cursor-deeplink/mcp/install?name=nightshift&config=eyJ1cmwiOiJodHRwczovL25pZ2h0c2hpZnQtYWkuc3R1ZGlvL2FwaS9tY3AifQ==");
    const config = link.split("&config=")[1];
    expect(config).toMatch(/^[A-Za-z0-9]+=*$/);
    expect(JSON.parse(atob(config))).toEqual({ url: PROD });
  });

  it("VS Code: the encoded server JSON with its name, for stable and Insiders, and the vscode.dev wrapper a web page uses", () => {
    const stable = "vscode:mcp/install?%7B%22name%22%3A%22nightshift%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fnightshift-ai.studio%2Fapi%2Fmcp%22%7D";
    expect(vscodeInstallLink(PROD)).toBe(stable);
    expect(vscodeInstallLink(PROD, "insiders")).toBe(stable.replace(/^vscode:/, "vscode-insiders:"));
    expect(JSON.parse(decodeURIComponent(stable.split("?")[1]))).toEqual({ name: "nightshift", type: "http", url: PROD });
    expect(vscodeWebInstallLink(PROD)).toBe(`https://vscode.dev/redirect?url=${encodeURIComponent(stable)}`);
    expect(new URL(vscodeWebInstallLink(PROD, "insiders")).searchParams.get("url")).toBe(vscodeInstallLink(PROD, "insiders"));
  });

  it("carry no key, no header and no placeholder for one: a sign-in is the only way these connect", () => {
    const all = [claudeConnectorLink(PROD), claudeConnectorLink(PROD, "organization"), cursorInstallLink(PROD), vscodeInstallLink(PROD), vscodeInstallLink(PROD, "insiders"), vscodeWebInstallLink(PROD)];
    for (const link of all) {
      const decoded = decodeURIComponent(link) + (link.includes("config=") ? atob(link.split("config=")[1]) : "");
      expect(decoded, link).not.toMatch(/bearer|authorization|api key|headers|nsk_|<your/i);
    }
  });

  it("https pages open in a new tab; Cursor's scheme is followed in the same one; ChatGPT, Gemini and Grok have no button", () => {
    expect(INSTALL_CLIENT_IDS).toEqual(["claude", "cursor", "vscode"]);
    expect(installLink("claude", PROD)).toEqual({ href: claudeConnectorLink(PROD), opens: "web" });
    expect(installLink("vscode", PROD)).toEqual({ href: vscodeWebInstallLink(PROD), opens: "web" });
    expect(installLink("cursor", PROD)).toEqual({ href: cursorInstallLink(PROD), opens: "app" });
    for (const id of STEPS_ONLY) expect(installLink(id, PROD), id).toBeNull();
  });

  it("the steps-only tabs link the vendors' current pages (ChatGPT's developer-mode guide is a 404)", () => {
    expect(CHATGPT_MCP_GUIDE).toBe("https://developers.openai.com/api/docs/guides/custom-mcp-server");
    expect(MCP_GUIDES).toEqual({
      chatgpt: CHATGPT_MCP_GUIDE,
      gemini: "https://support.google.com/gemini/answer/17209137",
      grok: "https://docs.x.ai/grok/connectors",
    });
  });

  it("the sign-in callbacks Gemini and Grok document already pass the redirect rule", () => {
    for (const uri of ["https://grok.com/connectors-oauth-exchange-code/", "https://oauth-redirect.googleusercontent.com/r/x", "https://oauth-redirect.googleusercontent.com/a/x"])
      expect(validateRedirectUri(uri), uri).toEqual({ ok: true });
  });
});

describe("/mcp", () => {
  const html = (oauthLive: boolean, locale: Locale = "en") =>
    renderToStaticMarkup(<McpPage dev={devDictionaries[locale]} origin="https://nightshift-ai.studio" labels={{ table: "Table", code: "Code" }} showCli={false} oauthLive={oauthLive} />);
  const doc = (oauthLive: boolean, locale: Locale = "en") => new DOMParser().parseFromString(html(oauthLive, locale), "text/html");
  const panel = (d: Document, id: string) => d.getElementById(d.querySelector(`[role="tab"][data-id="${id}"]`)!.getAttribute("aria-controls")!)!;

  it.each(LOCALES)("(%s) six assistants in the owner's order (tabs with the sign-in live; Cursor and VS Code tabs and the other four in the note without it), and no other assistant is named anywhere on the page", (locale) => {
    for (const oauthLive of [false, true]) {
      const d = doc(oauthLive, locale);
      const tabs = [...d.querySelectorAll('[role="tab"].st-pill')].map((t) => t.getAttribute("data-id"));
      const noted = [...d.querySelectorAll(".st-cc-soon-list li")].map((li) => li.getAttribute("data-id"));
      expect(tabs).toEqual(oauthLive ? SIX : ["cursor", "vscode"]);
      expect(noted).toEqual(oauthLive ? [] : ["chatgpt", "claude", "gemini", "grok"]);
      expect(SIX.filter((id) => tabs.includes(id) || noted.includes(id))).toEqual(SIX);
      const text = d.body.textContent ?? "";
      for (const gone of ["Claude Code", "OpenClaw", "Hermes", "Windsurf", "Gemini CLI", "Codex", "Zed", "Warp", "Cline", "Goose", "Roo Code", "LM Studio", "Raycast", "Claude Desktop", "mcp-remote"])
        expect(text, `${locale} ${oauthLive} ${gone}`).not.toContain(gone);
    }
  });

  it.each(LOCALES)("(%s) flag off: no Add-to button and no install link anywhere; the four sign-in assistants are one Coming soon note that names Cursor and VS Code", (locale) => {
    const page = html(false, locale);
    for (const needle of ["cursor://", "vscode:", "vscode-insiders:", "vscode.dev/redirect", "claude.ai/customize", "claude.ai/admin-settings", "st-install", 'data-opens="', "developers.openai.com", "support.google.com", "docs.x.ai"])
      expect(page, needle).not.toContain(needle);
    const d = doc(false, locale);
    const note = d.querySelector(".st-cc-soon")!;
    expect(note.textContent).toContain(devDictionaries[locale].mcp.soon.badge);
    expect(note.querySelector("a, button")).toBeNull();
    expect(note.textContent).toContain("Cursor");
    expect(note.textContent).toContain("VS Code");
    for (const id of ["chatgpt", "claude", "gemini", "grok"]) expect(d.querySelector(`[role="tab"][data-id="${id}"]`), id).toBeNull();
    expect(panel(d, "cursor").textContent).toContain("<your API key>");
  });

  it.each(LOCALES)("(%s) flag on: Claude, Cursor and VS Code have their button, with the steps by hand beside it in the same panel; ChatGPT, Gemini and Grok have steps only", (locale) => {
    const d = doc(true, locale);
    const words = devDictionaries[locale].mcp.oauth as Record<string, { button?: string; hint?: string }>;
    for (const id of INSTALL_CLIENT_IDS) {
      const p = panel(d, id);
      const key = p.querySelector<HTMLAnchorElement>(".st-install a.st-key")!;
      expect(key, id).toBeTruthy();
      expect(key.getAttribute("href"), id).toBe(installLink(id, PROD)!.href);
      expect(key.textContent, id).toContain(words[id].button);
      expect(p.querySelector(".st-install-hint")?.textContent, id).toBe(words[id].hint);
      // The way by hand: the server address in the next step, or the config to paste in the block under the steps.
      expect(`${p.querySelectorAll(".st-step2")[1].textContent}${p.querySelector(":scope > .st-steps2-code")?.textContent ?? ""}`, id).toMatch(/nightshift-ai\.studio\/api\/mcp/);
      // No vendor mark on a button: a generic icon and the product's name in text.
      expect(key.querySelector("use"), id).toBeNull();
    }
    for (const id of STEPS_ONLY) {
      const p = panel(d, id);
      expect(p.querySelector(".st-install, a[data-opens]"), id).toBeNull();
      expect(p.querySelector("a[href]")?.getAttribute("href"), id).toBe(MCP_GUIDES[id]);
      expect(p.querySelector("a[href]")?.getAttribute("rel"), id).toContain("noopener");
      expect(p.textContent, id).toContain(PROD);
      expect(p.textContent, id).not.toContain("Coming soon");
    }
    expect(panel(d, "chatgpt").textContent).toContain("Add custom MCP server");
    expect(panel(d, "gemini").textContent).toContain("Add a custom app");
    expect(panel(d, "grok").textContent).toContain("New Connector");
  });

  it.each(LOCALES)("(%s) flag on: Gemini states its limits and Grok tells people to leave Client ID empty, and what happens if it insists", (locale) => {
    const d = doc(true, locale);
    const o = devDictionaries[locale].mcp.oauth;
    expect(panel(d, "gemini").textContent).toContain(o.gemini.note);
    expect(o.gemini.note).toMatch(/18/);
    expect(o.gemini.note).toContain("Keep Activity");
    expect(panel(d, "grok").textContent).toContain(o.grok.note);
    expect(o.grok.note).toContain("Client ID");
    expect(o.grok.note).toContain("Client Secret");
  });

  it("flag on: https buttons open a new tab safely; cursor: stays in this tab (a new tab for an app link is left blank)", () => {
    const d = doc(true);
    // Claude and its organization variant, Cursor, VS Code and Insiders.
    expect(d.querySelectorAll("a[data-opens]")).toHaveLength(5);
    for (const a of d.querySelectorAll<HTMLAnchorElement>("a[data-opens]")) {
      const href = a.getAttribute("href")!;
      if (a.dataset.opens === "web") {
        expect(href).toMatch(/^https:\/\//);
        expect(a.getAttribute("target")).toBe("_blank");
        expect(a.getAttribute("rel")).toContain("noopener");
      } else {
        expect(href).toMatch(/^cursor:\/\//);
        expect(a.hasAttribute("target")).toBe(false);
      }
    }
    expect(panel(d, "claude").querySelector(`a[href="${claudeConnectorLink(PROD, "organization")}"]`)).toBeTruthy();
    expect(panel(d, "vscode").querySelector(`a[href="${vscodeWebInstallLink(PROD, "insiders")}"]`)).toBeTruthy();
  });

  it("flag on: Cursor and VS Code lead with the sign-in config and keep the key under a disclosure", () => {
    const d = doc(true);
    expect(panel(d, "vscode").textContent).toContain('"type": "http"');
    for (const id of ["cursor", "vscode"]) {
      expect(panel(d, id).querySelector("details summary"), id).toBeTruthy();
      expect(panel(d, id).querySelector("details")!.textContent, id).toMatch(/<your API key>|\$\{input:nightshift-key\}/);
    }
  });

  it("the Claude tab tells people to keep “Register automatically” and that a Free plan has one custom connector", () => {
    for (const locale of LOCALES) {
      const note = devDictionaries[locale].mcp.oauth.claude.note;
      expect(note, locale).toContain("Register automatically");
      expect(note, locale).toContain("Use Claude’s published identity");
      expect(note, locale).toMatch(/Free/);
    }
  });
});

describe("copy for the buttons, in en, ru and uz", () => {
  it("every sign-in client has its words, and the button labels are translated, not copied", () => {
    for (const locale of LOCALES) {
      const o = devDictionaries[locale].mcp.oauth as Record<string, { button?: string; hint?: string; steps: unknown[] }>;
      expect(Object.keys(o).sort(), locale).toEqual([...OAUTH_CLIENT_IDS].sort());
      expect(Object.keys(o), locale).toEqual(SIX);
      for (const id of INSTALL_CLIENT_IDS) {
        expect(o[id].button?.trim(), `${locale} ${id}`).toBeTruthy();
        expect(o[id].hint?.trim(), `${locale} ${id}`).toBeTruthy();
      }
    }
    for (const id of INSTALL_CLIENT_IDS) {
      const labels = LOCALES.map((l) => (devDictionaries[l].mcp.oauth as Record<string, { button?: string }>)[id].button);
      expect(new Set(labels).size, id).toBe(3);
    }
    for (const dict of [en, ru, uz]) {
      const c = dict.connectedApps;
      for (const k of ["addTitle", "addLead", "addTo", "addSteps", "addUrl", "newTab"] as const) expect(c[k].trim().length, k).toBeGreaterThan(0);
      expect(c.addTo).toContain("{app}");
    }
    expect(new Set([en, ru, uz].map((d) => d.connectedApps.addLead)).size).toBe(3);
  });
});

describe("Developers → Connected apps", () => {
  it("draws nothing to add while the sign-in is off, nor when the page did not pass the address", async () => {
    const { unmount } = render(<ConnectedApps mcpUrl={PROD} oauthLive={false} />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByTestId("add-assistant")).toBeNull();
    expect(document.querySelector("a[data-opens]")).toBeNull();
    unmount();
    render(<ConnectedApps oauthLive />);
    expect(screen.queryByTestId("add-assistant")).toBeNull();
  });

  it("with the sign-in on: the six in the owner's order; three buttons, and every row has its steps by hand on /mcp beside it", async () => {
    render(<ConnectedApps mcpUrl={PROD} oauthLive />);
    const box = await screen.findByTestId("add-assistant");
    const rows = [...box.querySelectorAll("li")];
    expect(rows.map((r) => r.textContent)).toEqual([
      "ChatGPTSteps by hand",
      expect.stringContaining("Add to Claude"),
      "GeminiSteps by hand",
      "GrokSteps by hand",
      expect.stringContaining("Add to Cursor"),
      expect.stringContaining("Add to VS Code"),
    ]);
    for (const i of [0, 2, 3]) expect(rows[i].querySelector("a[data-opens]")).toBeNull();
    const keys = [...box.querySelectorAll<HTMLAnchorElement>("a[data-opens]")];
    expect(keys.map((a) => a.getAttribute("href"))).toEqual(INSTALL_CLIENT_IDS.map((id) => installLink(id, PROD)!.href));
    expect(keys.map((a) => a.textContent?.replace(en.connectedApps.newTab, "").trim())).toEqual(["Add to Claude", "Add to Cursor", "Add to VS Code"]);
    for (const id of SIX) expect(box.querySelector(`a[href="/mcp?tab=${id}"]`), id).toBeTruthy();
    expect(box.textContent).toContain(PROD);
    expect(MCP_CLIENTS.map((c) => c.id)).toEqual(SIX);
  });
});
