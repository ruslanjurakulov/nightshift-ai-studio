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
  const packs: PricingPack[] = [
    { id: "starter", credits: 1000, displayPrice: "$10", priceId: null },
    { id: "creator", credits: 5000, displayPrice: "$40", priceId: null },
    { id: "studio", credits: 20000, displayPrice: null, priceId: null },
  ];
  const rates = { perMinute: 25, minimum: 10, centsPerCredit: null, pack: null } as never;

  function planner(over: PricingPack[] = packs, r: never = rates) {
    const t = dictionaries.en;
    return render(<PackPlanner t={t} locale="en" rates={r} packs={over} />);
  }

  it("starts on 60 minutes, reads credits at the published per-minute rate and names the smallest pack that covers them", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    expect(slider.value).toBe("60");
    // 60 min x 25 = 1,500 credits: starter (1,000) does not cover it, creator (5,000) does.
    expect(container.querySelector("output")?.textContent).toContain("1,500");
    expect(container.querySelector(".nx-plan-name")?.textContent).toBe(dictionaries.en.credits.buy.pack.creator);
    expect(container.querySelector(".nx-plan-price")?.textContent).toBe("$40");
    fireEvent.change(slider, { target: { value: "30" } });
    // 750 credits: the starter pack and its own price.
    expect(container.querySelector(".nx-plan-name")?.textContent).toBe(dictionaries.en.credits.buy.pack.starter);
    expect(container.querySelector(".nx-plan-price")?.textContent).toBe("$10");
  });

  it("writes several packs as 'N × price' and never adds a total the pricing source did not publish", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    // 400 min x 25 = 10,000 credits: one studio pack (20,000) covers it, and the source lists no price for it.
    fireEvent.change(slider, { target: { value: "400" } });
    expect(container.querySelector(".nx-plan-price")?.textContent).toBe(dictionaries.en.site.pricingTeaser.atCheckout);
    // With only small packs on sale, the largest is taken several times.
    cleanup();
    const small = planner([packs[0], packs[1]]).container;
    fireEvent.change(small.querySelector("input[type=range]") as HTMLInputElement, { target: { value: "400" } });
    expect(small.querySelector(".nx-plan-price")?.textContent).toBe("2 × $40");
    expect(small.textContent).not.toMatch(/\$80/);
  });

  it("is a labelled native range with a spoken value, and every price it can show is one the packs list", () => {
    const { container } = planner();
    const slider = container.querySelector("input[type=range]") as HTMLInputElement;
    expect(slider.id).toBeTruthy();
    expect(container.querySelector(`label[for="${slider.id}"]`)).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBeTruthy();
    const seen = new Set<string>();
    for (let m = 10; m <= 400; m += 10) {
      fireEvent.change(slider, { target: { value: String(m) } });
      const price = container.querySelector(".nx-plan-price")?.textContent;
      if (price) seen.add(price.replace(/^\d+ × /, ""));
    }
    for (const p of seen) expect(["$10", "$40", dictionaries.en.site.pricingTeaser.atCheckout]).toContain(p);
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
    for (const cls of ["nx-fx-mote", "nx-fx-streak", "nx-fx-shaft", "nx-fx-mist", "nx-fx-sun", "nx-fx-shimmer", "nx-fx-moonglow", "nx-fx-star", "nx-fx-lantern", "nx-fx-fg", "nx-art-glow", "nx-art-ring", "nx-art-star", "nx-art-playhead", "nx-art-pulse"]) {
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
    for (const name of ["mote", "streak", "shaft", "mist", "glow", "shimmer", "twinkle", "flicker", "par", "dash", "playhead", "pulse", "kb"]) {
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
