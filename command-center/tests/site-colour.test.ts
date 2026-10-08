import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public site's one primary action is indigo (docs/design/COLOUR.md); amber stays the accent. The tokens live in
 * site.css on `.st` (light), on the dark theme and on the stages that are dark in both themes. The signed-in app's
 * tokens (app/globals.css) are not touched. Contrast is computed from the stylesheet, so a later edit cannot quietly
 * drop a pair below its floor.
 */
const root = join(__dirname, "..");
const site = readFileSync(join(root, "components/site/site.css"), "utf8");
const next = readFileSync(join(root, "components/site/site-next.css"), "utf8");
const globals = readFileSync(join(root, "app/globals.css"), "utf8");

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** The `--name: value` declarations of the first rule whose selector line starts with this text. */
function tokens(selector: string): Record<string, string> {
  const at = site.indexOf(selector);
  expect(at, selector).toBeGreaterThan(-1);
  const body = site.slice(site.indexOf("{", at) + 1, site.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const light = tokens(".st {");
const dark = tokens(':root[data-theme="dark"] .st,');
const GROUND = { light: "#f3f3f1", dark: "#131210" };
const STAGE = "#100f0d";

describe("the public primary key is indigo with a white legend", () => {
  it.each([
    ["light", light, GROUND.light],
    ["dark", dark, GROUND.dark],
  ] as const)("%s: legend 4.5:1 on the key, the key readable against the page, hover keeps the legend at 4.5:1", (name, t, ground) => {
    expect(t["--st-lit-fg"] ?? "#ffffff").toBe("#ffffff");
    expect(contrast("#ffffff", t["--st-lit-bg"]), "legend").toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", t["--st-lit-hover"]), "hover legend").toBeGreaterThanOrEqual(4.5);
    // The fill alone is 3:1 or better against the page; on the dark ground (3.8:1) the edge delimits it at 7:1.
    expect(contrast(t["--st-lit-bg"], ground), `${name} fill`).toBeGreaterThanOrEqual(3);
    expect(contrast(t["--st-lit-edge"], ground), `${name} edge`).toBeGreaterThanOrEqual(name === "dark" ? 7 : 5);
  });

  it("keeps the same pair on the stages that are dark in both themes (closing panel, sticky bar, sign-in stage)", () => {
    expect(site).toMatch(/:root\[data-theme="dark"\] \.st,\s*\n\.nx-final, \.nx-bar, \.st-auth-aside \{/);
    expect(contrast(dark["--st-lit-edge"], STAGE)).toBeGreaterThanOrEqual(7);
    expect(contrast("#ffffff", dark["--st-lit-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("uses the same numbers in the media-query dark block as in the data-theme dark block", () => {
    const m = site.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \.st \{([^}]*)\}/);
    expect(m).toBeTruthy();
    for (const k of ["--st-lit-bg", "--st-lit-hover", "--st-lit-edge", "--st-act-ink", "--ns-focus", "--st-focus-gap"]) expect(m![1]).toContain(`${k}: ${dark[k]};`);
  });

  it("gives no key, button or hover an amber fill on the public site's stylesheets", () => {
    const key = site.slice(site.indexOf(".st-key {"), site.indexOf("}", site.indexOf(".st-key {")));
    expect(key).toContain("var(--st-lit-bg)");
    const btn = next.slice(next.indexOf(".nx-btn {"), next.indexOf("}", next.indexOf(".nx-btn {")));
    expect(btn).toContain("var(--st-lit-bg)");
    expect(site).not.toMatch(/--st-lit-bg:\s*var\(--ns-amber/);
    for (const sel of [".nx-cta:hover", ".nx-try-pick:hover", ".nx-tool:hover", ".nx-aud-tab:hover", ".nx-link:hover", ".st-link:hover"]) {
      const at = (sel.startsWith(".st") ? site : next).indexOf(`${sel} {`);
      const src = sel.startsWith(".st") ? site : next;
      expect(src.slice(at, src.indexOf("}", at)), sel).not.toMatch(/amber/);
    }
  });
});

describe("the key's edge sits outside the key", () => {
  it("draws the light edge as a 1 px ring outside the box (border = the fill), so no pixel under the label is the edge (the label reads 4.5:1 on the rendered pixels)", () => {
    const body = (src: string, sel: string) => src.slice(src.indexOf(`${sel} {`), src.indexOf("}", src.indexOf(`${sel} {`)));
    for (const [src, sel] of [[site, ".st-key"], [next, ".nx-btn"]] as const) {
      const b = body(src, sel);
      expect(b, sel).toMatch(/border: 1px solid var\(--st-lit-bg\);/);
      expect(b, sel).toMatch(/box-shadow: 0 0 0 1px var\(--st-lit-edge\)/);
    }
    expect(body(next, ".nx-bar-go")).toMatch(/border: 1px solid var\(--st-lit-bg\);/);
    expect(body(next, ".nx-bar-go")).toMatch(/box-shadow: 0 0 0 1px var\(--st-lit-edge\)/);
  });
});

describe("the second headline line", () => {
  it("is the indigo ink of the theme, 4.5:1 or better on the page", () => {
    expect(next).toMatch(/\.nx-h1-b \{ display: block; color: var\(--st-act-ink\); \}/);
    expect(contrast(light["--st-act-ink"], GROUND.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark["--st-act-ink"], GROUND.dark)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("keyboard focus on the public site is amber, readable on the page", () => {
  it("light and dark rings are 3:1 on the page; the key carries a page-coloured gap so the ring is never read against the key", () => {
    expect(contrast(light["--ns-focus"], GROUND.light)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark["--ns-focus"], GROUND.dark)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark["--ns-focus"], STAGE)).toBeGreaterThanOrEqual(3);
    // The dark ring is also 3:1 against the key itself; the light one cannot be (an amber dark enough for the page is dark like the key), hence the gap.
    expect(contrast(dark["--ns-focus"], dark["--st-lit-bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(light["--st-focus-gap"], light["--st-lit-bg"])).toBeGreaterThanOrEqual(3);
    expect(site).toMatch(/\.st-key:focus-visible \{ box-shadow: 0 0 0 2px var\(--st-focus-gap\); \}/);
    expect(next).toMatch(/\.nx-btn:focus-visible, \.nx-bar-go:focus-visible \{ box-shadow: 0 0 0 2px var\(--st-focus-gap\); \}/);
    // Amber, not the app's blue cue.
    expect(light["--ns-focus"]).toBe("#a85a00");
    expect(site).not.toMatch(/outline: 2px solid var\(--ns-cue\)/);
    expect(next).not.toMatch(/outline: 2px solid var\(--ns-cue\)/);
  });
});

describe("the signed-in app keeps its colours", () => {
  it("has no indigo in the app's tokens and keeps its blue focus ring and amber key", () => {
    expect(globals).not.toMatch(/4f46e5|6558f5|4338ca|b3acff/i);
    expect(globals).toMatch(/--ns-focus: #2a5bc0;/);
    expect(globals).toMatch(/--ns-amber: #f29a1e;/);
    expect(globals).toMatch(/--ns-cta-bg: #ffa940;/);
  });
});
