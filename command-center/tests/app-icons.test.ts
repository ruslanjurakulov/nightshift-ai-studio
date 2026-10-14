import { describe, expect, it, vi } from "vitest";

// The root layout pulls in CSS and server-only helpers; only its `metadata` export is under test.
vi.mock("@/lib/i18n/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/components/site/fonts", () => ({ preloadFonts: () => null }));

/**
 * An explicit `metadata.icons` replaces Next's auto-generated icon links, so app/apple-icon.png is only linked
 * (<link rel="apple-touch-icon">) if the layout lists it. Without it, iOS "Add to Home Screen" draws a letter tile.
 */
describe("root layout icons", () => {
  it("links the 180 px apple icon and keeps the tab icons", async () => {
    const { metadata } = await import("@/app/layout");
    const icons = metadata.icons as { icon: { url: string; type?: string; sizes?: string }[]; apple: { url: string; type?: string; sizes?: string }[] };
    expect(icons.apple).toContainEqual({ url: "/apple-icon.png", sizes: "180x180", type: "image/png" });
    expect(icons.icon).toContainEqual({ url: "/icon.svg", type: "image/svg+xml" });
    expect(icons.icon).toContainEqual({ url: "/favicon.ico", sizes: "32x32" });
  });
});
