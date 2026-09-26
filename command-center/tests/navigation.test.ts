import { describe, expect, it } from "vitest";
import { SECTIONS } from "@/lib/channels";
import {
  HOME,
  MAX_TRACKED,
  NAV_ITEMS,
  breadcrumbs,
  isHomePath,
  parentPath,
  recordVisit,
  resolveBack,
  restoreStack,
  splitPath,
  titleKey,
} from "@/lib/navigation";

describe("navigation definitions", () => {
  it("lists every routed section, so no page is left without a breadcrumb label or tab title", () => {
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href.slice(1)));
    for (const section of SECTIONS) expect(hrefs, section).toContain(section);
  });

  it("has no duplicate routes or keys, which would make two rail entries light up", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
  });
});

describe("splitPath / isHomePath", () => {
  it("separates the channel from the section and ignores query and hash", () => {
    expect(splitPath("/chronos/videos/abc?x=1#top")).toEqual({ slug: "chronos", segments: ["videos", "abc"] });
    expect(splitPath("/")).toEqual({ slug: "", segments: [] });
  });

  it("treats each channel's Command Center as the ground floor, and nothing else", () => {
    expect(isHomePath("/chronos/command-center")).toBe(true);
    expect(isHomePath("/all-channels/command-center")).toBe(true);
    expect(isHomePath("/chronos/integrations")).toBe(false);
    expect(isHomePath("/chronos/command-center/x")).toBe(false);
  });
});

describe("breadcrumbs", () => {
  it("puts a section under the channel's Command Center", () => {
    expect(breadcrumbs("/chronos/integrations")).toEqual([
      { kind: "channel", slug: "chronos" },
      { kind: "section", key: "command", href: "/chronos/command-center" },
      { kind: "section", key: "integrations", href: "/chronos/integrations" },
    ]);
  });

  it("does not repeat the Command Center on its own page", () => {
    expect(breadcrumbs("/all-channels/command-center")).toEqual([
      { kind: "channel", slug: "all-channels" },
      { kind: "section", key: "command", href: "/all-channels/command-center" },
    ]);
  });

  it("labels a section by the sidebar's key even where URL and key differ", () => {
    expect(breadcrumbs("/c/intelligence")[2]).toMatchObject({ key: "advisory" });
    expect(breadcrumbs("/c/intelligence-map")[2]).toMatchObject({ key: "intelligence" });
    expect(breadcrumbs("/c/feedback-loop")[2]).toMatchObject({ key: "feedback" });
  });

  it("keeps a detail page's links on the same channel and decodes its segment", () => {
    const crumbs = breadcrumbs("/chronos/videos/a%20b");
    expect(crumbs[2]).toEqual({ kind: "section", key: "videos", href: "/chronos/videos" });
    expect(crumbs[3]).toEqual({ kind: "detail", segment: "a b", parent: "videos", href: "/chronos/videos/a%20b" });
  });

  it("survives a malformed escape instead of throwing during render", () => {
    expect(breadcrumbs("/c/videos/%E0%A4%A")[3]).toMatchObject({ segment: "%E0%A4%A" });
  });

  it("falls back to a detail crumb for a route the sidebar does not list", () => {
    expect(breadcrumbs("/c/unknown-page")[2]).toEqual({
      kind: "detail",
      segment: "unknown-page",
      parent: null,
      href: "/c/unknown-page",
    });
  });

  it("is empty outside a channel", () => {
    expect(breadcrumbs("/")).toEqual([]);
  });
});

describe("titleKey", () => {
  it("names the deepest known section", () => {
    expect(titleKey("/c/integrations")).toBe("integrations");
    expect(titleKey("/c/videos/abc")).toBe("videos");
    expect(titleKey("/c/command-center")).toBe("command");
    expect(titleKey("/")).toBeNull();
  });
});

describe("parentPath", () => {
  it("goes up one level on the same channel", () => {
    expect(parentPath("/chronos/videos/abc")).toBe("/chronos/videos");
    expect(parentPath("/chronos/channels/new")).toBe("/chronos/channels");
  });

  it("sends a top-level section to that channel's Command Center", () => {
    expect(parentPath("/chronos/integrations")).toBe(`/chronos${HOME}`);
  });

  it("has no parent on the ground floor", () => {
    expect(parentPath("/chronos/command-center")).toBeNull();
    expect(parentPath("/")).toBeNull();
  });
});

describe("recordVisit", () => {
  it("pushes ordinary navigations", () => {
    expect(recordVisit(["/c/a"], "/c/b", false)).toEqual(["/c/a", "/c/b"]);
  });

  it("does not double-count a re-render of the same page", () => {
    expect(recordVisit(["/c/a"], "/c/a", false)).toEqual(["/c/a"]);
  });

  it("pops when the browser steps back to the page underneath", () => {
    expect(recordVisit(["/c/a", "/c/b"], "/c/a", true)).toEqual(["/c/a"]);
  });

  it("restarts on a pop it cannot place, so back never guesses at another site", () => {
    expect(recordVisit(["/c/a", "/c/b"], "/c/z", true)).toEqual(["/c/z"]);
    expect(recordVisit(["/c/a"], "/c/b", true)).toEqual(["/c/b"]);
  });

  it("is bounded", () => {
    let stack: string[] = [];
    for (let i = 0; i < MAX_TRACKED + 20; i++) stack = recordVisit(stack, `/c/p${i}`, false);
    expect(stack).toHaveLength(MAX_TRACKED);
    expect(stack[stack.length - 1]).toBe(`/c/p${MAX_TRACKED + 19}`);
  });

  it("does not mutate the stack it was given", () => {
    const stack = ["/c/a"];
    recordVisit(stack, "/c/b", false);
    expect(stack).toEqual(["/c/a"]);
  });
});

describe("restoreStack", () => {
  it("resumes after a reload of the same page", () => {
    expect(restoreStack(["/c/a", "/c/b"], "/c/b", "reload")).toEqual(["/c/a", "/c/b"]);
  });

  it("starts fresh for a page reached any other way — the history behind it is unknown", () => {
    expect(restoreStack(["/c/a", "/c/b"], "/c/b", "navigate")).toEqual(["/c/b"]);
    expect(restoreStack(["/c/a", "/c/b"], "/c/b", "back_forward")).toEqual(["/c/b"]);
    expect(restoreStack(["/c/a", "/c/b"], "/c/b", null)).toEqual(["/c/b"]);
  });

  it("starts fresh when the stored stack is for another page or is not a stack", () => {
    expect(restoreStack(["/c/a", "/c/b"], "/c/x", "reload")).toEqual(["/c/x"]);
    expect(restoreStack({ nope: true }, "/c/x", "reload")).toEqual(["/c/x"]);
    expect(restoreStack(["https://evil.example", "/c/x"], "/c/x", "reload")).toEqual(["/c/x"]);
  });
});

describe("resolveBack", () => {
  it("uses the browser's back when an in-app page is behind", () => {
    expect(resolveBack("/c/integrations", 1)).toEqual({ kind: "history" });
    expect(resolveBack("/c/command-center", 2)).toEqual({ kind: "history" });
  });

  it("goes to the logical parent from a pasted link or a fresh tab, never out of the app", () => {
    expect(resolveBack("/c/integrations", 0)).toEqual({ kind: "navigate", href: "/c/command-center" });
    expect(resolveBack("/c/videos/abc", 0)).toEqual({ kind: "navigate", href: "/c/videos" });
  });

  it("does nothing on the ground floor with nothing behind", () => {
    expect(resolveBack("/c/command-center", 0)).toBeNull();
  });
});
