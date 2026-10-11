import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIDEBAR_COOKIE, SIDEBAR_KEY, isSidebarCollapsed } from "@/lib/sidebar-pref";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the sidebar preference the layout reads on the server", () => {
  it("reads only the exact word 'collapsed' as collapsed (an allow-list, anything else is the open sidebar)", () => {
    expect(isSidebarCollapsed("collapsed")).toBe(true);
    for (const v of [undefined, null, "", "open", "Collapsed", "true", "1", "collapsed ", "collapsed;x"]) {
      expect(isSidebarCollapsed(v), String(v)).toBe(false);
    }
  });

  it("names are plain strings (the cookie the client writes is the cookie the server reads)", () => {
    expect(SIDEBAR_COOKIE).toBe("ns_sidebar");
    expect(SIDEBAR_KEY).toBe("ns-sidebar");
  });

  it("lives in a plain module: a constant imported from a client module into the server layout does not resolve", () => {
    expect(read("lib/sidebar-pref.ts")).not.toMatch(/["']use client["']/);
    expect(read("components/shell/SidebarState.tsx")).toMatch(/^"use client";/);
    const layout = read("app/(app)/layout.tsx");
    expect(layout).toMatch(/from "@\/lib\/sidebar-pref"/);
    // The layout takes the cookie name and reader from the plain module, never from the client module.
    expect(layout).not.toMatch(/import \{[^}]*SIDEBAR_COOKIE[^}]*\} from "@\/components\/shell\/SidebarState"/);
    expect(layout).toMatch(/isSidebarCollapsed\(\(await cookies\(\)\)\.get\(SIDEBAR_COOKIE\)\?\.value\)/);
  });
});
