// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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
import { devDictionaries } from "@/lib/i18n/dev";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const URL_ = "https://example.test/api/mcp";

/**
 * Every snippet the MCP page offers is syntactically what it claims to be, so a
 * copy-and-paste never hands a person a broken file. (Lens, PR 385.)
 */
describe("the MCP snippets parse", () => {
  it("every JSON snippet is valid JSON, and OpenClaw's inline JSON is too", () => {
    for (const c of MCP_CLIENTS) {
      for (const s of [c.snippet(URL_), c.oauthSnippet?.(URL_)]) {
        if (!s) continue;
        if (c.lang === "json") expect(() => JSON.parse(s), c.id).not.toThrow();
        if (c.id === "openclaw") {
          const inline = s.match(/'([\s\S]*)'$/);
          expect(inline, c.id).not.toBeNull();
          expect(() => JSON.parse(inline![1]), c.id).not.toThrow();
        }
      }
    }
  });

  it("a key never sits in a file a project would commit: the Cursor key snippet points to the user-level file only", () => {
    for (const dict of Object.values(devDictionaries)) {
      const where = dict.mcp.clients.find((x) => x.id === "cursor")!.where;
      expect(where).toContain("~/.cursor/mcp.json");
      expect(where).not.toMatch(/(?<!~\/)\.cursor\/mcp\.json/);
    }
  });
});

describe("the connect card ignores an address it cannot read", () => {
  it.each(["#%", "#%E0%A4%A", "#%zz"])("a malformed fragment (%s) does not crash the page", (hash) => {
    window.history.replaceState(null, "", `/mcp${hash}`);
    expect(() =>
      render(
        <McpPage dev={devDictionaries.en} origin="https://example.test" labels={{ table: "T", code: "C" }} showCli={false} oauthLive={false} />,
      ),
    ).not.toThrow();
  });
});
