import { beforeEach, describe, expect, it, vi } from "vitest";

// app/layout.tsx: the Desktop choice becomes a viewport width, nothing else changes it.

const req = vi.hoisted(() => ({ cookies: {} as Record<string, string>, headers: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n in req.cookies ? { value: req.cookies[n] } : undefined) }),
  headers: async () => ({ get: (n: string) => req.headers[n.toLowerCase()] ?? null }),
}));

const { generateViewport, default: RootLayout } = await import("@/app/layout");

beforeEach(() => {
  req.cookies = {};
  req.headers = {};
});

describe("generateViewport", () => {
  it("leaves the device's own width alone when nothing was chosen (the site as it was)", async () => {
    const v = await generateViewport();
    expect(v.width).toBeUndefined();
    expect(v.themeColor).toHaveLength(2);
  });

  it("is 1280 wide, with no initial scale, for Desktop", async () => {
    req.cookies.ns_view = "desktop";
    const v = await generateViewport();
    expect(v.width).toBe(1280);
    expect("initialScale" in v && v.initialScale === undefined).toBe(true);
  });

  it.each(["mobile", "tablet", "", "DESKTOP"])("ignores %j", async (value) => {
    req.cookies.ns_view = value;
    expect((await generateViewport()).width).toBeUndefined();
  });
});

describe("RootLayout", () => {
  const find = (node: unknown, pred: (n: { type?: unknown; props?: Record<string, unknown> }) => boolean): boolean => {
    if (!node || typeof node !== "object") return false;
    const n = node as { type?: unknown; props?: Record<string, unknown> };
    if (pred(n)) return true;
    const kids = n.props?.children;
    return (Array.isArray(kids) ? kids : [kids]).some((k) => find(k, pred));
  };
  const named = (name: string) => (n: { type?: unknown }) => typeof n.type === "function" && (n.type as { name: string }).name === name;
  const page = { type: "main", props: { id: "the-page" } };

  it("renders the page as it always did", async () => {
    const tree = await RootLayout({ children: page as never });
    expect(find(tree, (n) => n.props?.id === "the-page")).toBe(true);
    expect(find(tree, named("ViewFrame"))).toBe(false);
    expect(find(tree, named("EmbedBridge"))).toBe(false);
  });

  it("renders only the phone frame when the middleware asked for it", async () => {
    req.headers["x-ns-frame-src"] = "/pricing";
    const tree = await RootLayout({ children: page as never });
    expect(find(tree, named("ViewFrame"))).toBe(true);
    expect(find(tree, (n) => n.props?.id === "the-page")).toBe(false);
  });

  it("mounts the frame bridge, beside the page, in a document loaded as a frame", async () => {
    req.headers["sec-fetch-dest"] = "iframe";
    const tree = await RootLayout({ children: page as never });
    expect(find(tree, named("EmbedBridge"))).toBe(true);
    expect(find(tree, (n) => n.props?.id === "the-page")).toBe(true);
  });
});
