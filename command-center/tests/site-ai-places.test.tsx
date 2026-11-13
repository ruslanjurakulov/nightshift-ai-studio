// @vitest-environment jsdom
/**
 * Our samples in the places outside the landing: the sign-in and sign-up stages (a Client Component), /solutions (its banners and
 * the publish desk's frame), /mcp's header panel (HeroBleed) and /mcp's example cards (SCENE_SAMPLE). The slot and scene lines
 * here point at two fixture samples (a clip and a picture), as they will once the owner sets their `ai` ids.
 *
 * What would break if these failed: a place showing a sample under a stock label or a Pexels credit, or a stock picture inside a
 * sample's box; a place whose sample replaced its stock picture still crediting that picture in the footer, or a stock picture
 * still shown without its credit there; a pause button on a still; the sign-in stage reading the clock in the browser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

const ids = vi.hoisted(() => ({ clip: "0b0b0b0b-1111-4222-8333-444455556666", still: "0e0e0e0e-1111-4222-8333-444455556666" }));

vi.mock("@/lib/site/showcase.json", async () => {
  const { FIXTURE_ENTRY } = await import("./fixtures/showcase-entry");
  return {
    default: {
      entries: [
        FIXTURE_ENTRY,
        { ...FIXTURE_ENTRY, jobId: ids.still, kind: "image", capability: "t2i", modelId: "flux-2-pro", modelName: "FLUX.2 Pro", provider: "bfl", attribution: null, operatorPreview: false, prompt: "Golden dunes at dawn", width: 1280, height: 853 },
      ],
    },
  };
});
vi.mock("@/components/site/showcase-assets", async () => {
  const { FIXTURE_FILES, FIXTURE_JOB } = await import("./fixtures/showcase-entry");
  return { SHOWCASE_FILES: { ...FIXTURE_FILES, [ids.still]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } } };
});
// The slots and scenes as they will be once their `ai` lines are set: the module's own objects, so slotMedia and sceneMedia read them.
vi.mock("@/components/site/slots", async (orig) => {
  const m = await orig<typeof import("@/components/site/slots")>();
  const S = m.SLOTS as unknown as Record<string, { ai: string | null }>;
  for (const k of ["auth.signup", "solutions.youtube-channels", "solutions.creative-studio", "mcp.hero"]) S[k] = { ...S[k], ai: ids.clip };
  for (const k of ["auth.login", "solutions.developers"]) S[k] = { ...S[k], ai: ids.still };
  return m;
});
vi.mock("@/components/docs/SampleFrame", async (orig) => {
  const m = await orig<typeof import("@/components/docs/SampleFrame")>();
  const S = m.SCENE_SAMPLE as unknown as Record<string, { ai: string | null }>;
  S.hills = { ...S.hills, ai: ids.still };
  return m;
});
vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries } = await import("../lib/i18n");
  const { publicDictionary } = await import("../lib/i18n/public");
  const { fmt } = await import("../lib/i18n/core");
  return { usePublicI18n: () => ({ t: publicDictionary(dictionaries.en), locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("../lib/i18n");
  return { getDictionary: async () => ({ t: dictionaries.en, locale: "en" }) };
});
vi.mock("@/components/legal/PublicShell", () => ({ PublicShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/signup",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries } from "@/lib/i18n";
import { devDictionaries } from "@/lib/i18n/dev";
import { AuthShell } from "@/components/auth/AuthShell";
import { HeroBleed } from "@/components/landing/HeroBleed";
import { McpLanding } from "@/components/docs/McpLanding";
import { PublicFooter } from "@/components/legal/PublicFooter";
import SolutionsPage from "@/app/solutions/page";
import { slotMedia } from "@/components/site/samples";
import { sceneMedia } from "@/components/docs/SampleFrame";
import { stockInUse } from "@/components/site/stock-in-use";
import { creditLine } from "@/lib/site/media";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { SAMPLE_CARD, placeLabelProblems, without } from "./helpers/showcase-scope";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
// The theme key and the clips ask the browser about the screen; here: a phone-sized screen with motion allowed.
function screenStub() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} });
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()) as never;
  HTMLMediaElement.prototype.pause = vi.fn() as never;
}
const t = dictionaries.en;

/** Every stock picture a rendered page shows is one the footer credits, and nothing in a sample's box is stock. */
function stockIsCredited(container: Element) {
  const used = stockInUse() as string[];
  for (const img of container.querySelectorAll("[data-sample]")) {
    expect(used, img.getAttribute("data-sample")!).toContain(img.getAttribute("data-sample"));
    expect(img.closest(SAMPLE_CARD)).toBeNull();
  }
  expect(without(container, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
}

describe("the sign-in and sign-up stages", () => {
  beforeEach(screenStub);
  it("sign-up plays the sample behind the stage, credits its model under it, and keeps its pause button; no stock word or Pexels credit", () => {
    const { container } = render(
      <AuthShell title="Create your account" mode="signup">
        <form />
      </AuthShell>,
    );
    const aside = container.querySelector("aside.st-auth-aside") as HTMLElement;
    expect(aside.dataset.showcaseEntry).toBe(ids.clip);
    expect(aside.dataset.clip).toBe("sample");
    expect(aside.querySelector(".nx-aside-note")?.textContent).toContain("Runway Gen-4.5");
    expect(aside.querySelector(".nx-ai-attr")?.getAttribute("href")).toBe("https://runway.com");
    // No "Try" on the stage (the visitor is signing up already), so the stage reads no clock in the browser.
    expect(aside.querySelector(".nx-ai-try")).toBeNull();
    expect(aside.querySelector(".nx-clip-pause")).not.toBeNull();
    const band = container.querySelector(".nx-auth-band") as HTMLElement;
    expect(band.dataset.showcaseEntry).toBe(ids.clip);
    expect(band.textContent).toContain(t.site.gallery.badge);
    expect(container.innerHTML).not.toMatch(/pexels/i);
    for (const w of [t.site.samples.tag, t.site.samples.frameTag, t.site.samples.clipTag]) expect(container.textContent).not.toContain(w);
    stockIsCredited(container);
  });

  it("sign-in shows a still sample: labelled, credited, and no pause button", () => {
    const { container } = render(
      <AuthShell title="Sign in">
        <form />
      </AuthShell>,
    );
    const aside = container.querySelector("aside.st-auth-aside") as HTMLElement;
    expect(aside.dataset.showcaseEntry).toBe(ids.still);
    expect(aside.hasAttribute("data-clip")).toBe(false);
    expect(container.querySelector(".nx-clip-pause")).toBeNull();
    expect(aside.querySelector(".nx-aside-note")?.textContent).toContain("FLUX.2 Pro");
    expect(container.innerHTML).not.toMatch(/pexels/i);
    stockIsCredited(container);
  });

  it("the stage's credit takes no `now` default into a Client Component's link (AiCredit reads the clock only for a link)", () => {
    const src = readFileSync(join(__dirname, "..", "components/site/PlaceFill.tsx"), "utf8");
    expect(src).toContain("const leftOut = href ? modelLeftOut(entry, now) : null;");
    const shell = readFileSync(join(__dirname, "..", "components/auth/AuthShell.tsx"), "utf8");
    expect(shell).not.toMatch(/href=\{|placeTry|tryHref/);
  });
});

describe("/solutions", () => {
  it("labels each audience's picture and the publish desk's frame as our sample, and credits it where its link can be pressed", async () => {
    const { container } = render(await SolutionsPage());
    const photos = [...container.querySelectorAll<HTMLElement>("figure.nx-aud-photo")];
    expect(photos.length).toBe(2);
    for (const [fig, slot] of [[photos[0], "solutions.creative-studio"], [photos[1], "solutions.developers"]] as const) {
      expect(placeLabelProblems(fig, slotMedia(slot), t.site), slot).toEqual([]);
    }
    const frame = container.querySelector(".st-signoff-frame") as HTMLElement;
    expect(frame.dataset.showcaseEntry).toBe(ids.clip);
    expect(frame.querySelector(".nx-result-badge[data-kind='ai']")?.textContent).toBe(t.site.gallery.badge);
    expect(container.querySelector(".st-signoff-caption")).toBeNull();
    // All three pictures are ours here, so the note under them is the samples' sentence and not the stock one.
    expect([...container.querySelectorAll(".nx-sol-ways > .nx-show-note")].map((n) => n.textContent)).toEqual([t.site.gallery.slotNote]);
    // The desk is a role="img" figure, which hides links: the sample's credit and its button sit under it.
    const credit = container.querySelector(".nx-place-credit") as HTMLElement;
    expect(credit.closest("figure")).toBeNull();
    expect(placeLabelProblems(credit, slotMedia("solutions.youtube-channels"), t.site)).toEqual([]);
    expect(credit.querySelector(".nx-ai-try")?.textContent).toContain(t.site.gallery.use);
    expect(container.innerHTML).not.toMatch(/pexels/i);
    stockIsCredited(container);
  });
});

describe("/mcp", () => {
  it("the header panel plays the sample with its labels and pause button (HeroBleed)", () => {
    const { container } = render(<HeroBleed t={t} slot="mcp.hero" className="nx-mcp-bleed" />);
    const panel = container.querySelector(".nx-mcp-bleed") as HTMLElement;
    expect(placeLabelProblems(panel, slotMedia("mcp.hero"), t.site)).toEqual([]);
    expect(panel.querySelector("img")?.getAttribute("data-sample-job")).toBe(ids.clip);
    expect(panel.querySelector(".nx-clip-pause")).not.toBeNull();
    stockIsCredited(container);
  });

  it("an example card whose scene has a sample says AI-generated and names its model; the others keep their stock label and credit", () => {
    const { container } = render(<McpLanding dev={devDictionaries.en} site={t.site} oauthLive={false} />);
    // The section's lead covers both kinds of picture once one card is ours (the stock-only lead would be false).
    expect(container.querySelector(".ml-examples-lead")?.textContent).toBe(devDictionaries.en.mcp.land.examples.leadSamples);
    const hills = container.querySelector("[data-scene='hills']") as HTMLElement;
    expect(sceneMedia("hills").kind).toBe("ai");
    expect(hills.dataset.showcaseEntry).toBe(ids.still);
    expect(hills.querySelector(".ml-ex-badge[data-kind='ai']")?.textContent).toBe(t.site.gallery.badge);
    expect(hills.textContent).toContain("FLUX.2 Pro");
    expect(hills.innerHTML).not.toMatch(/pexels/i);
    const waves = container.querySelector("[data-scene='waves']") as HTMLElement;
    const m = sceneMedia("waves");
    expect(m.kind).toBe("stock");
    if (m.kind === "stock") expect(waves.querySelector(".ml-ex-credit")?.textContent).toBe(creditLine(m.id, devDictionaries.en.mcp.land.examples.credit));
    expect(waves.closest(SAMPLE_CARD)).toBeNull();
    stockIsCredited(container);
  });
});

describe("the footer's credits follow the places", () => {
  it("drop each stock picture every place of which now shows a sample, and keep the ones still shown", () => {
    const used = stockInUse();
    // desert (sign-in), loom (creative studio), citynight (developers), valley (/mcp hills): replaced everywhere they were used.
    for (const gone of ["desert", "loom", "citynight", "valley"] as const) expect(used).not.toContain(gone);
    // floating is still the /pricing card's; caravan still /mcp's sixth card; cloud still the landing's first screen.
    for (const kept of ["floating", "caravan", "cloud"] as const) expect(used).toContain(kept);
    const { container } = render(<PublicFooter t={t} />);
    const links = [...container.querySelectorAll(".st-credits li a")].map((a) => a.textContent);
    expect(links).toEqual(used.map((id) => creditLine(id, t.site.samples.credit)));
    // With samples on the site and stock still shown, the exception says an AI-generated label anywhere means one of ours.
    expect(container.querySelector(".st-credits")?.textContent).toContain(t.site.credits.generated);
  });
});
