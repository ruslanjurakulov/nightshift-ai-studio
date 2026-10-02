import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// Components that once bypassed the design tokens and broke the light theme.
const TOKEN_ONLY = [
  "components/NeuralBackdrop.tsx",
  "components/auth/AuthShell.tsx",
  "components/legal/LegalFooter.tsx",
  "components/series/SeriesBoard.tsx",
  "components/review/ReviewPanel.tsx",
  "components/developers/DeveloperConsole.tsx",
  "components/providers/ProvidersBoard.tsx",
  "components/SystemStatus.tsx",
  "components/ui.tsx",
  "components/autonomy/AutonomyView.tsx",
  "components/autonomy/QualityGate.tsx",
  "components/autonomy/OperationsPanels.tsx",
  "components/intelligence/AdvisoryPanel.tsx",
  "components/social/SocialAccountsPanel.tsx",
  "components/alerts/SendTestAlert.tsx",
  "components/studio/GenerateSection.tsx",
  "components/studio/GeneratePanel.tsx",
  "components/studio/ModelSheet.tsx",
  "components/studio/TierMarks.tsx",
  "components/studio/JobFeed.tsx",
  "components/studio/TemplateGallery.tsx",
  "components/editor/EditorHome.tsx",
  "components/editor/TimelineEditor.tsx",
  "components/editor/TimelineStrip.tsx",
];

// Tailwind palette colours (text-rose-300, bg-white/10, border-sky-400/60 ...).
const PALETTE =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|divide|outline|shadow)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?\b/;
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
const RAW_RGB = /\brgba?\(/;
const COLOR_FALLBACK = /var\(--color-[a-z0-9-]+\s*,/;

describe("light theme: components use tokens, not raw colours", () => {
  for (const file of TOKEN_ONLY) {
    it(`${file} has no palette classes, hex, rgb() or var() colour fallbacks`, () => {
      // A video player's letterbox is black by nature, in either theme.
      const src = read(file).replace('border-[var(--color-border)] bg-black"', 'border-[var(--color-border)]"');
      expect(src.match(PALETTE)?.[0]).toBeUndefined();
      expect(src.match(RAW_HEX)?.[0]).toBeUndefined();
      expect(src.match(RAW_RGB)?.[0]).toBeUndefined();
      expect(src.match(COLOR_FALLBACK)?.[0]).toBeUndefined();
    });
  }

  it("no component refers to the undefined --color-danger token", () => {
    expect(read("components/developers/DeveloperConsole.tsx")).not.toContain("--color-danger");
  });

  it("idle-coloured text uses --color-muted (idle stays for dots)", () => {
    expect(read("components/ui.tsx")).toMatch(/idle: \{ fg: "var\(--color-idle\)", text: "var\(--color-muted\)"/);
    expect(read("components/SystemStatus.tsx")).toMatch(/idle: "var\(--color-muted\)"/);
    expect(read("components/autonomy/OperationsPanels.tsx")).not.toContain("--color-idle");
  });
});

describe("light theme: globals.css defines the backdrop and CTA per theme", () => {
  const css = read("app/globals.css");
  const TOKENS = [
    "--backdrop-video-display",
    "--backdrop-base",
    "--veil-rgb",
    "--backdrop-glow",
    "--backdrop-dim",
    "--cta-fg",
    "--cta-base",
    "--cta-sheen",
    "--cta-glow",
    "--cta-glow-hover",
  ];

  it("declares each token in the light, prefers-dark and data-theme=dark blocks", () => {
    for (const token of TOKENS) {
      const declarations = css.split(`${token}:`).length - 1;
      expect(declarations, token).toBe(3);
    }
  });

  // The identity layer (docs/design/IDENTITY.md): every --ns-* colour role is
  // declared once per theme block plus once for the style guide's scoped dark
  // specimen, which shares the data-theme=dark block — so three, like the rest.
  const IDENTITY = [
    "--ns-ground",
    "--ns-console",
    "--ns-key",
    "--ns-key-hi",
    "--ns-rule",
    "--ns-rule-strong",
    "--ns-text",
    "--ns-text-dim",
    "--ns-amber",
    "--ns-amber-ink",
    "--ns-on-amber",
    "--ns-cta-bg",
    "--ns-cta-fg",
    "--ns-cta-price",
    "--ns-tally",
    "--ns-go",
    "--ns-cue",
    "--ns-caution",
    "--ns-lamp-off",
    "--ns-hover",
    "--ns-select",
    "--ns-scrim",
    "--ns-lift",
    "--ns-focus",
  ];

  it("declares every identity token in the light, prefers-dark and data-theme=dark blocks", () => {
    for (const token of IDENTITY) {
      expect(css.split(`${token}:`).length - 1, token).toBe(3);
    }
  });

  it("remaps the older role names onto the identity, so screens adopt it unedited", () => {
    for (const [old, ns] of [
      ["--color-bg", "--ns-ground"],
      ["--color-panel", "--ns-console"],
      ["--color-fg", "--ns-text"],
      ["--color-muted", "--ns-text-dim"],
      ["--color-primary", "--ns-amber-ink"],
      ["--studio-cta-bg", "--ns-cta-bg"],
      ["--studio-cta-fg", "--ns-cta-fg"],
      ["--shell-bg", "--ns-console"],
    ]) {
      expect(css.split(`${old}: var(${ns});`).length - 1, old).toBe(3);
    }
  });

  it("lets a box carry its own theme (the style guide's side-by-side specimens)", () => {
    expect(css).toMatch(/:root\[data-theme="light"\],\s*\[data-theme-scope="light"\] \{/);
    expect(css).toMatch(/:root\[data-theme="dark"\],\s*\[data-theme-scope="dark"\] \{/);
  });

  it("the shared radius, motion and type-scale tokens exist once", () => {
    for (const token of ["--ns-r-frame", "--ns-r-key", "--ns-r-panel", "--ns-r-sheet", "--ns-ease", "--ns-dur-2", "--ns-t-body"]) {
      expect(css.split(`${token}:`).length - 1, token).toBe(1);
    }
  });

  it("focus is the cue blue, never the amber that means selected", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 2px solid var\(--ns-focus\);/);
  });

  it("hides the dark footage on the light theme and keeps it on dark", () => {
    expect(css).toMatch(/--backdrop-video-display: none;/);
    expect(css).toMatch(/--backdrop-video-display: block;/);
  });

  it("the CTA and backdrop rules read tokens, not literal colours", () => {
    const block = css.slice(css.indexOf(".neural-video {"), css.indexOf(".cta-glass:active"));
    expect(block).toContain("var(--cta-fg)");
    expect(block).toContain("var(--backdrop-base)");
    expect(block).not.toMatch(/color:\s*#fff/);
  });
});
