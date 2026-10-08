// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { AudienceTabs } from "@/components/site/AudienceTabs";
import { BrandArt, ThumbArt, thumbWords } from "@/components/site/BrandArt";
import { TypedText } from "@/components/site/TypedText";
import { FlowCard } from "@/components/auth/FlowCard";
import { PackPlanner } from "@/components/pricing/PackPlanner";
import { ToolStrip } from "@/components/landing/ToolStrip";
import { CLIPS } from "@/components/site/samples";
import type { PricingPack } from "@/lib/pricing";

afterEach(cleanup);

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");

/** The CSS inside the first `@media (prefers-reduced-motion: no-preference)` blocks, as one string. */
function motionParts() {
  const out: string[] = [];
  const rest: string[] = [];
  let i = 0;
  let last = 0;
  const key = "@media (prefers-reduced-motion: no-preference)";
  while ((i = css.indexOf(key, i)) !== -1) {
    const open = css.indexOf("{", i);
    let depth = 1;
    let j = open + 1;
    while (depth > 0 && j < css.length) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    out.push(css.slice(open + 1, j - 1));
    rest.push(css.slice(last, i));
    last = j;
    i = j;
  }
  rest.push(css.slice(last));
  return { inside: out.join("\n"), outside: rest.join("\n") };
}
const motionCss = () => motionParts().inside;

describe("typed text: no script, nothing flashes, the whole line for assistive tech", () => {
  it("renders every letter as its own span with its turn, plus the full text once as screen-reader text", () => {
    const { container } = render(<TypedText text="Hi, you" />);
    expect(container.querySelector(".sr-only")?.textContent).toBe("Hi, you");
    const chars = [...container.querySelectorAll(".nx-ch")];
    expect(chars.map((c) => c.textContent).join("")).toBe("Hi, you");
    expect(chars.map((c) => (c as HTMLElement).style.getPropertyValue("--i"))).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(container.querySelector(".nx-typed")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("reveals letters with a step that starts at once (a step that ends leaves them hidden), and only where motion is allowed", () => {
    expect(css).toMatch(/@keyframes nx-show\s*\{\s*from\s*\{\s*visibility:\s*hidden;?\s*\}\s*to\s*\{\s*visibility:\s*visible;?\s*\}\s*\}/);
    expect(css).not.toMatch(/nx-show[^;]*steps\(1,\s*end\)/);
    expect(motionCss()).toMatch(/\.nx-ch\b[^}]*animation:\s*nx-show[^;]*steps\(1,\s*start\)/);
    // Outside the motion block the letters have no hidden state at all.
    expect(motionParts().outside).not.toMatch(/\.nx-ch\s*\{[^}]*visibility:\s*hidden/);
  });
});

describe("the tabbed audiences (/solutions)", () => {
  const tabs = [
    { id: "a", label: "Alpha", panel: <p>first</p> },
    { id: "b", label: "Beta", panel: <p>second</p> },
    { id: "c", label: "Gamma", panel: <p>third</p> },
  ];

  it("is a tablist in the full sense: one tab stop, arrows, Home and End, every panel in the page", () => {
    render(<AudienceTabs label="Who" tabs={tabs} />);
    const list = screen.getByRole("tablist", { name: "Who" });
    const t = within(list).getAllByRole("tab");
    expect(t.map((x) => x.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(t[0].getAttribute("aria-selected")).toBe("true");
    // All three panels exist (so the page reads whole to a search engine); only the open one is shown.
    const panels = document.querySelectorAll("[role=tabpanel]");
    expect(panels).toHaveLength(3);
    expect([...panels].map((p) => p.hasAttribute("hidden"))).toEqual([false, true, true]);
    fireEvent.keyDown(t[0], { key: "ArrowRight" });
    expect(t[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(t[1]);
    fireEvent.keyDown(t[1], { key: "End" });
    expect(t[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(t[2], { key: "ArrowRight" });
    expect(t[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(t[0], { key: "ArrowLeft" });
    expect(t[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(t[1]);
    expect([...document.querySelectorAll("[role=tabpanel]")].map((p) => p.hasAttribute("hidden"))).toEqual([true, false, true]);
    // Each tab names its panel.
    expect(t[1].getAttribute("aria-controls")).toBe(document.querySelectorAll("[role=tabpanel]")[1].id);
  });
});

describe("the credit planner (/pricing)", () => {
  const priced: PricingPack[] = [
    { id: "starter", credits: 1000, displayPrice: "$10", priceId: null },
    { id: "creator", credits: 5000, displayPrice: "$45", priceId: null },
    { id: "studio", credits: 20000, displayPrice: "$160", priceId: null },
  ];
  const unpriced: PricingPack[] = [priced[0], priced[1], { ...priced[2], displayPrice: null }];
  const rates = { perMinute: 25, minimum: 10, centsPerCredit: null, pack: null } as never;

  function planner(over: PricingPack[] = priced, r: never = rates) {
    return render(<PackPlanner t={dictionaries.en} locale="en" rates={r} packs={over} />);
  }
  const dollars = (price: string) => price.split(" + ").reduce((n, term) => {
    const m = /^(?:(\d+) × )?\$(\d+)$/.exec(term)!;
    return n + Number(m[1] ?? 1) * Number(m[2]);
  }, 0);
  /** An independent search: the least total price of any whole number of each pack that reaches the credits. */
  function cheapest(need: number) {
    let best = Infinity;
    for (let a = 0; a <= 40; a++) for (let b = 0; b <= 8; b++) for (let c = 0; c <= 3; c++) if (a * 1000 + b * 5000 + c * 20000 >= need) best = Math.min(best, a * 10 + b * 45 + c * 160);
    return best;
  }

  it("starts on 60 minutes and reads the credits at the published per-minute rate", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    expect(slider.value).toBe("60");
    // 60 min x 25 = 1,500 credits: two Starters ($20) beat one Creator ($45).
    expect(container.querySelector("output")?.textContent).toContain("1,500");
    expect(container.querySelector(".nx-plan-name")?.textContent).toBe(`2 × ${dictionaries.en.credits.buy.pack.starter}`);
    expect(container.querySelector(".nx-plan-price")?.textContent).toBe("2 × $10");
  });

  it("shows the cheapest cover at every one of the 40 positions, as a mix when a mix is cheaper, written as its terms and never added up", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    const seen = new Set<string>();
    for (let m = 10; m <= 400; m += 10) {
      fireEvent.change(slider, { target: { value: String(m) } });
      const price = container.querySelector(".nx-plan-price")!.textContent!;
      seen.add(price);
      expect(dollars(price), `${m} min`).toBe(cheapest(m * 25));
      expect(price).not.toMatch(/=/);
    }
    // A mix of two different packs does occur (5,250 credits: $10 + $45), and so does one pack several times.
    expect(seen.has("$10 + $45")).toBe(true);
    expect([...seen].some((x) => /^\d+ × \$\d+$/.test(x))).toBe(true);
  });

  it("falls back to the smallest single pack that covers it when a listed pack has no plain dollar price (it cannot be compared)", () => {
    const { container } = planner(unpriced);
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "30" } });
    expect(container.querySelector(".nx-plan-name")?.textContent).toBe(dictionaries.en.credits.buy.pack.starter);
    fireEvent.change(slider, { target: { value: "400" } });
    expect(container.querySelector(".nx-plan-price")?.textContent).toBe(dictionaries.en.site.pricingTeaser.atCheckout);
  });

  it("is a labelled native range with a spoken value", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    expect(container.querySelector(`label[for="${slider.id}"]`)).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBeTruthy();
  });
});

describe("the sign-in and sign-up flow card", () => {
  it.each(LOCALES)("%s: brief, plan and approve, labelled an example, with nothing to press and the whole text in the server's HTML", (locale) => {
    const stage = publicDictionary(dictionaries[locale.code]).site.stage;
    const { container } = render(<FlowCard stage={stage} />);
    const fig = container.querySelector("figure.nx-fcard")!;
    expect(fig.getAttribute("aria-label")).toBe(stage.figure);
    expect(fig.querySelector(".nx-demo-tag")?.textContent).toBe(stage.tag);
    expect(fig.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
    expect(fig.querySelectorAll(":scope > ol > li")).toHaveLength(3);
    expect(fig.querySelector(".nx-chat-key")?.getAttribute("aria-hidden")).toBe("true");
    const brief = stage.steps.find((s) => s.id === "brief") as { field: string };
    expect(fig.querySelector(".sr-only")?.textContent).toBe(brief.field);
  });

  it("has a compact form for the phone", () => {
    const stage = publicDictionary(dictionaries.en).site.stage;
    const { container } = render(<FlowCard stage={stage} compact />);
    expect(container.querySelector("figure.nx-fcard")?.getAttribute("data-compact")).toBe("true");
  });
});

describe("drawn art", () => {
  it.each(["dawn", "rundown", "tools"] as const)("%s: decorative, from brand tokens only, no raster and no remote reference", (kind) => {
    const { container } = render(<BrandArt kind={kind} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("data-art")).toBe(kind);
    const html = svg.outerHTML;
    expect(html).not.toMatch(/<image|href="http|url\(http|#[0-9a-fA-F]{3,8}"/);
    expect(html).toContain("var(--nx-stage");
  });

  it("can be held still (the auth pages)", () => {
    const { container } = render(<BrandArt kind="dawn" still />);
    expect(container.querySelector("svg")?.getAttribute("data-static")).toBe("true");
  });

  it("sets up to three of the topic's words on the thumbnail, the same drawing for the same topic", () => {
    expect(thumbWords("Make a video about why the Silk Road ran through Samarkand")).toEqual(["Make", "video", "Silk"]);
    const a = render(<ThumbArt topic="Why the lighthouse still matters" />).container.innerHTML.replace(/id="[^"]*"|url\(#[^)]*\)/g, "");
    cleanup();
    const b = render(<ThumbArt topic="Why the lighthouse still matters" />).container.innerHTML.replace(/id="[^"]*"|url\(#[^)]*\)/g, "");
    expect(a).toBe(b);
    expect(a).not.toContain("<image");
  });
});

describe("the tool pill carousel", () => {
  it("lists exactly the nine capability names as swipeable, keyboard-reachable tabs", () => {
    const st = dictionaries.en.site.studio;
    const { container } = render(<ToolStrip title={dictionaries.en.site.toolStrip.title} tools={st.tools.map((x) => ({ id: x.id, title: x.title, body: x.body }))} priced={st.priced} free={st.free} />);
    const tabs = within(container.querySelector("[role=tablist]") as HTMLElement).getAllByRole("tab");
    expect(tabs).toHaveLength(9);
    expect(tabs.map((x) => x.textContent?.trim())).toEqual(st.tools.map((x) => x.title));
    expect(tabs.filter((x) => x.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(container.querySelectorAll(".nx-tools-list svg")).toHaveLength(9);
    // The row scrolls sideways and snaps, and its pills are at least 17px on a phone.
    expect(css).toMatch(/\.nx-tools-list\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/\.nx-tools-list\s*\{[^}]*scroll-snap-type:\s*x/);
    expect(css).toMatch(/\.nx-tool\s*\{[^}]*font-size:\s*(?:1[7-9]|2\d)px/);
  });
});

describe("motion stays optional and stays cheap", () => {
  it("every infinite or timed animation lives inside the no-preference block", () => {
    const outside = motionParts().outside;
    const bad = [...outside.matchAll(/(?:^|[;{\s])animation(?:-name)?:\s*(?!none)[^;}]+/g)].map((m) => m[0].trim());
    expect(bad).toEqual([]);
  });

  it("stops the procedural light, the drawn art and the flow with the page's pause switch", () => {
    for (const cls of ["nx-fx-mote", "nx-fx-streak", "nx-fx-shaft", "nx-fx-mist", "nx-fx-sun", "nx-fx-shimmer", "nx-fx-moonglow", "nx-fx-star", "nx-fx-lantern", "nx-art-glow", "nx-art-ring", "nx-art-star", "nx-art-playhead", "nx-art-pulse"]) {
      expect(css, cls).toMatch(new RegExp(`html\\[data-motion="paused"\\] \\.${cls}\\b`));
    }
    // The shorthand `animation` of the rules that start the loops resets play-state, and they come later in the file: the pause must be !important.
    expect(css).toMatch(/html\[data-motion="paused"\] \.nx-art-svg \*,[^{]*\{ animation-play-state: paused !important; \}/);
    const m = motionCss();
    expect(m).toMatch(/html\[data-motion="paused"\] \.nx-fcard \* \{ animation: none !important; \}/);
    expect(m).toMatch(/html\[data-motion="paused"\] \.nx-chat \.nx-ch[^{]*\{[^}]*animation: none !important/);
  });

  it("animates only transform and opacity on the layered stills (no layout work per frame)", () => {
    const m = motionCss();
    void m;
    for (const name of ["mote", "streak", "shaft", "mist", "glow", "shimmer", "twinkle", "flicker", "dash", "playhead", "pulse", "kb"]) {
      const body = css.match(new RegExp(`@keyframes nx-${name} \\{.*`))?.[0] ?? "";
      expect(body, name).not.toBe("");
      expect(body, name).not.toMatch(/\b(?:top|left|width|height|margin|padding|box-shadow|filter)\s*:/);
    }
  });
});

describe("the pictures and the data", () => {
  it("has a phone rendition for every clip, a fraction of the large one", () => {
    for (const [id, c] of Object.entries(CLIPS)) {
      const sm = statSync(join(ROOT, "components/site/clips", `${id}-sm.mp4`)).size;
      const big = statSync(join(ROOT, "components/site/clips", `${id}.mp4`)).size;
      expect(c.smMp4, id).toBeTruthy();
      expect(c.smWebm, id).toBeTruthy();
      expect(sm, id).toBeLessThan(big);
      expect(sm, id).toBeLessThan(160 * 1024);
    }
  });

  it("reads the clip files from one module that a Client Component imports, so the build writes them where the pages point (a file imported only on the server is never copied to /_next/static/media)", () => {
    const loop = readFileSync(join(ROOT, "components/site/LoopClip.tsx"), "utf8");
    expect(loop.startsWith('"use client";')).toBe(true);
    expect(loop).toContain('from "@/components/site/clip-assets"');
    const assets = readFileSync(join(ROOT, "components/site/clip-assets.ts"), "utf8");
    expect([...assets.matchAll(/site\/clips\/[\w-]+\.(?:mp4|webm)"/g)]).toHaveLength(12);
    for (const f of ["components/site/samples.tsx", "components/landing/HeroCard.tsx", "components/landing/Showcases.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/site\/clips\/[\w-]+\.(?:mp4|webm)"/);
    }
  });

  it("keeps only the six stills (no recoloured variants)", () => {
    const files = readdirSync(join(ROOT, "components/site/samples")).filter((f: string) => f.endsWith(".webp"));
    expect(files.sort()).toEqual(["lighthouse.webp", "library.webp", "moon.webp", "nightmarket.webp", "silkroad.webp", "valley.webp"].sort());
  });
});

describe("review fixes (PR #405)", () => {
  it("defines the stage colours on the drawn art itself, not only on `.nx`, so /mcp (a `.st` page) does not paint it black", () => {
    expect(css).toMatch(/\n\.nx, \.nx-art-svg \{\s*\n\s*--nx-stage: #100f0d;/);
    // Every var the art reads is in that rule.
    const art = readFileSync(join(ROOT, "components/site/BrandArt.tsx"), "utf8");
    const rule = css.match(/\n\.nx, \.nx-art-svg \{[^}]*\}/)![0];
    for (const v of new Set(art.match(/--nx-stage[\w-]*/g))) expect(rule, v).toContain(`${v}:`);
  });

  it("draws no still twice: the showcases and the hero card have no stacked foreground copy, and the light is the only motion on the moon", () => {
    for (const f of ["components/landing/Showcases.tsx", "components/landing/HeroCard.tsx", "components/pricing/PricingView.tsx"]) {
      expect(readFileSync(join(ROOT, f), "utf8"), f).not.toMatch(/nx-fx-fg|\bfg\b/);
    }
    expect(css).not.toContain("nx-fx-fg");
  });

  it("fits the Try thumbnail's words whatever the box (the drawing is scaled to fit, never sliced)", () => {
    const { container } = render(<ThumbArt topic="Why the lighthouse still matters" />);
    expect(container.querySelector("svg")?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  it("finishes every sign-in and landing card timeline within 5 s (WCAG 2.2.2) and keeps the status lamp finite there", () => {
    const m = motionCss();
    const ends = [...m.matchAll(/\.nx-(?:fcard|chat) [^{]*\{[^}]*animation: [\w-]+ ([\d.]+)s [^;]*?([\d.]+)s both/g)].map((x) => Number(x[1]) + Number(x[2]));
    expect(ends.length).toBeGreaterThan(4);
    for (const e of ends) expect(e).toBeLessThanOrEqual(5);
    // The calc()-delayed rows: the last character and the last plan line.
    expect(0.6 + 60 * 0.026).toBeLessThanOrEqual(5);
    expect(2 + 3 * 0.3 + 0.01).toBeLessThanOrEqual(5);
    expect(m).toMatch(/\.nx \.st-auth-aside \.ns-lamp\[data-live="true"\] \{ animation-iteration-count: 2 !important; \}/);
  });

  it("marks the rail's step with data-current (decoration), not aria-current, which would say a step the picture is no longer on", () => {
    const hero = readFileSync(join(ROOT, "components/landing/HeroCard.tsx"), "utf8");
    expect(hero).not.toContain("aria-current");
    expect(css).toContain('.nx-chat-rail li[data-current="true"]');
  });

  it("fades the pill row's edges and hints that it swipes, until it has been scrolled", () => {
    const strip = dictionaries.en.site.studio;
    const { container } = render(<ToolStrip title="t" tools={strip.tools.map((x) => ({ id: x.id, title: x.title, body: x.body }))} priced={strip.priced} free={strip.free} />);
    expect(container.querySelector(".nx-tools-rail")?.getAttribute("data-edge")).toMatch(/start|none/);
    expect(css).toMatch(/\.nx-tools-rail\[data-edge="start"\]::after/);
    expect(css).toMatch(/\.nx-tools-rail\[data-edge="mid"\] \.nx-tools-list \{ -webkit-mask-image/);
  });

  it("keeps the sign-up stage's tracks off the words: hairlines only on the desktop backdrop", () => {
    expect(css).toMatch(/\.nx-aside-bg\[data-art="rundown"\] g > rect:last-child \{ fill-opacity: 0; stroke-opacity: 0; \}/);
    expect(css).toMatch(/\.nx-aside-bg\[data-art="rundown"\] \.nx-art-playhead \{ display: none; \}/);
  });

  it("keeps the light cheap: no blur filter, no blend mode, on the layers that move", () => {
    const fx = css.split("\n").filter((l) => /^\.nx-fx-(?:mote|streak|shaft|mist|sun|shimmer|moonglow|star|lantern) /.test(l)).join("\n");
    expect(fx).not.toMatch(/filter:|mix-blend-mode/);
    expect(css).toMatch(/\.nx-fx \{[^}]*contain: layout paint style;/);
  });

  it("sets the phone footer in two columns at 14px or more", () => {
    const site = readFileSync(join(ROOT, "components/site/site.css"), "utf8");
    expect(site).not.toMatch(/\.st-footer-cols \{ grid-template-columns: repeat\(3/);
    expect(site).toMatch(/\.st-footer h2 \{[^}]*font-size: 14px/);
    expect(site).toMatch(/\.st-footer nav a \{[^}]*font-size: 15px/);
    // The legal group, with the longest names, takes the whole row on a phone.
    expect(site).toMatch(/max-width: 899px\) \{ \.st-footer-cols > :last-child \{ grid-column: 1 \/ -1; \}/);
  });
});
