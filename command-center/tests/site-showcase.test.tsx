// @vitest-environment jsdom
/**
 * The public site's model samples (lib/site/showcase.ts, components/site/ShowcaseGallery.tsx, lib/site/showcase-link.ts).
 *
 * What would break if these failed: a sample naming a model the registry does not have, or without the maker's required credit;
 * a cost of 0 standing in for "unknown"; a card pointing at files that are not in the repository; a model name leaking out of its
 * own card onto the rest of the site; a placeholder gallery with nothing real in it; a "Try it" that sends a visitor off-site,
 * spends anything, or loses the words on the way through sign-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, LOCALES } from "@/lib/i18n";
import raw from "@/lib/site/showcase.json";
import { SHOWCASE_ENTRIES, parseShowcase, parseShowcaseEntry, showcaseModels } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { ShowcaseGallery, showcaseItems } from "@/components/site/ShowcaseGallery";
import { cutWords, signupTryHref, studioTryHref, tryHref } from "@/lib/site/showcase-link";
import { DEFAULT_AFTER_AUTH, afterSignupPath, safeLoginReturn, safeNextPath, studioNext } from "@/lib/safe-redirect";
import { prefillFromImprove, IMPROVE_PROMPT_MAX } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { SLOTS } from "@/components/site/samples";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { FIXTURE_ENTRY, FIXTURE_FILES, FIXTURE_JOB } from "./fixtures/showcase-entry";

afterEach(cleanup);

const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8")) as {
  models: { id: string; display_name: string; provider: string; capabilities: string[]; attribution: { text: string; url: string } | null }[];
};
const MODELS = new Map(REGISTRY.models.map((m) => [m.id, m]));
const t = dictionaries.en;

describe("the data file", () => {
  it("ships empty: no sample exists until a real job is exported and merged", () => {
    expect((raw as { entries: unknown[] }).entries).toEqual([]);
    expect(SHOWCASE_ENTRIES).toEqual([]);
    expect(SHOWCASE_FILES).toEqual({});
  });

  it("drops no entry it holds: every entry parses (a malformed one would vanish from the site unseen)", () => {
    expect(SHOWCASE_ENTRIES.length).toBe((raw as { entries: unknown[] }).entries.length);
  });

  it("every entry is a registry model's generation, with the registry's name, maker and credit, a job id, a cost that is a number or unknown, and its files", () => {
    for (const e of [...SHOWCASE_ENTRIES, FIXTURE_ENTRY]) {
      const m = MODELS.get(e.modelId);
      expect(m, e.modelId).toBeTruthy();
      expect(e.modelName).toBe(m!.display_name);
      expect(e.provider).toBe(m!.provider);
      expect(m!.capabilities).toContain(e.capability);
      expect(e.attribution).toEqual(m!.attribution ?? null);
      expect(e.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(e.cost.usdEstimate === null || (typeof e.cost.usdEstimate === "number" && e.cost.usdEstimate >= 0)).toBe(true);
      if (e.cost.rows === 0) expect(e.cost.usdEstimate).toBeNull();
      if (e.slot !== null) expect(Object.keys(SLOTS)).toContain(e.slot);
      expect(e.input.kind).not.toBe("upload");
    }
    for (const e of SHOWCASE_ENTRIES) {
      expect(SHOWCASE_FILES[e.jobId], e.jobId).toBeTruthy();
      const dir = join(ROOT, "components/site/showcase", e.jobId);
      const names = e.kind === "video" ? ["clip.mp4", "clip.webm", "clip-sm.mp4", "clip-sm.webm", "poster.webp", "poster-sm.webp"] : ["poster.webp", "poster-sm.webp"];
      for (const n of names) expect(existsSync(join(dir, n)), `${e.jobId}/${n}`).toBe(true);
    }
    // And no files for an entry that is not there.
    expect(Object.keys(SHOWCASE_FILES).sort()).toEqual(SHOWCASE_ENTRIES.map((e) => e.jobId).sort());
  });

  it("the fixture is a well-formed entry, and the shapes that would lie are refused", () => {
    expect(parseShowcaseEntry(FIXTURE_ENTRY)).toEqual(FIXTURE_ENTRY);
    const bad: Record<string, unknown>[] = [
      { ...FIXTURE_ENTRY, jobId: "not-a-uuid" },
      { ...FIXTURE_ENTRY, modelId: "Runway Gen 4.5" },
      // "unknown" written as 0: no row recorded, yet a figure
      { ...FIXTURE_ENTRY, cost: { usdEstimate: 0, priceSource: "guess", rows: 0, vendor: [] } },
      // a figure without where its price came from
      { ...FIXTURE_ENTRY, cost: { usdEstimate: 0.5, priceSource: null, rows: 1, vendor: [] } },
      { ...FIXTURE_ENTRY, cost: { usdEstimate: -1, priceSource: "x", rows: 1, vendor: [] } },
      { ...FIXTURE_ENTRY, attribution: { text: "Powered by Runway", url: "http://runway.com" } },
      { ...FIXTURE_ENTRY, attribution: { text: "Powered by Runway", url: "javascript:alert(1)" } },
      { ...FIXTURE_ENTRY, input: { kind: "upload" } },
      { ...FIXTURE_ENTRY, kind: "audio" },
      { ...FIXTURE_ENTRY, createdAt: "yesterday" },
    ];
    for (const b of bad) expect(parseShowcaseEntry(b), JSON.stringify(b).slice(0, 120)).toBeNull();
    // A job is shown once, newest first.
    const older = { ...FIXTURE_ENTRY, jobId: "0a0a0a0a-1111-4222-8333-444455556666", createdAt: "2026-10-01T00:00:00Z" };
    expect(parseShowcase({ entries: [older, FIXTURE_ENTRY, FIXTURE_ENTRY] }).map((e) => e.jobId)).toEqual([FIXTURE_JOB, older.jobId]);
    expect(showcaseModels([FIXTURE_ENTRY, FIXTURE_ENTRY])).toHaveLength(1);
  });
});

describe("the gallery", () => {
  it("renders nothing with no entry, or with entries whose files are missing (never a placeholder)", () => {
    expect(render(<ShowcaseGallery t={t} locale="en" />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={{}} />).container.innerHTML).toBe("");
    expect(showcaseItems()).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: one entry shows the badge, the model and its credit link, the prompt, the date and Try it", (code) => {
    const d = dictionaries[code];
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector(".nx-result-badge")?.textContent).toBe(d.site.gallery.badge);
    expect(card.textContent).toContain("Runway Gen-4.5");
    const credit = within(card).getByRole("link", { name: "Powered by Runway" });
    expect(credit.getAttribute("href")).toBe("https://runway.com");
    expect(credit.getAttribute("target")).toBe("_blank");
    expect(credit.getAttribute("rel")).toBe("noopener noreferrer");
    expect(card.textContent).toContain(FIXTURE_ENTRY.prompt);
    expect(card.querySelector("time")?.getAttribute("dateTime")).toBe(FIXTURE_ENTRY.createdAt);
    expect(card.querySelector("img")?.getAttribute("alt")).toContain("Runway Gen-4.5");
    const tryIt = within(card).getByRole("link", { name: new RegExp(`^${d.site.gallery.try}`) });
    expect(tryIt.getAttribute("href")).toBe(signupTryHref(FIXTURE_ENTRY));
    expect(tryIt.textContent).toBe(d.site.gallery.try);
    // The heading and the note say what the section is, in this language.
    expect(container.querySelector("h2")?.textContent).toBe(d.site.gallery.title);
    expect(container.textContent).toContain(d.site.gallery.tryNoteSignedOut);
  });

  it("signed in, Try it is the Studio form itself", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const href = container.querySelector(".nx-gallery-try")?.getAttribute("href");
    expect(href).toBe(studioTryHref(FIXTURE_ENTRY));
    expect(container.textContent).toContain(t.site.gallery.tryNote);
  });

  it("a picture has no clip and no pause button; a sample without words says so instead of showing an empty quote", () => {
    const pic = { ...FIXTURE_ENTRY, kind: "image" as const, capability: "t2i", modelId: "flux-2-pro", modelName: "FLUX.2 Pro", provider: "bfl", attribution: null, prompt: "" };
    const files = { [FIXTURE_JOB]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[pic]} files={files} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".nx-clip-pause")).toBeNull();
    expect(container.querySelector(".nx-gallery-pic")?.hasAttribute("data-clip")).toBe(false);
    expect(container.querySelector(".nx-gallery-attr")).toBeNull();
    expect(container.querySelector(".nx-gallery-prompt")?.textContent).toBe(t.site.gallery.noPrompt);
  });

  it("is the only place a model is named: outside the entry cards the section names no provider, and each card's model is a registry model with a job id", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const cards = [...container.querySelectorAll<HTMLElement>("[data-showcase-entry]")];
    expect(cards).toHaveLength(1);
    for (const c of cards) {
      expect(c.dataset.showcaseEntry).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(MODELS.has(c.dataset.model ?? "")).toBe(true);
    }
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelectorAll("[data-showcase-entry]").forEach((n) => n.remove());
    expect(outside.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(outside.innerHTML).not.toMatch(PROVIDER_BRANDS);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the gallery's and the credits' own words name no model or maker, and say AI-generated", (code) => {
    const s = dictionaries[code].site;
    expect(JSON.stringify(s.gallery)).not.toMatch(PROVIDER_BRANDS);
    expect(s.credits.generated).not.toMatch(PROVIDER_BRANDS);
    const AI = /AI-generated|нейросет|sunʼiy intellekt/i;
    expect(s.gallery.badge).toMatch(AI);
    expect(s.credits.generated).toMatch(AI);
    expect(s.gallery.altClip).toContain("{model}");
    expect(s.gallery.tryAria.startsWith(s.gallery.try)).toBe(true);
  });

  it("the stylesheet lays the cards out in one column on a phone and gives the credit link a touch-sized target", () => {
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toMatch(/\.nx-gallery \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(min-width: 860px\) \{ \.nx-gallery \{ grid-template-columns: repeat\(2/);
    expect(css).toMatch(/\.nx-gallery-attr \{[^}]*min-height: 44px/);
  });
});

describe("Try it", () => {
  const sample = { capability: "i2v", modelId: "runway-gen4.5", prompt: "Paper lanterns drift up over a dark lake" };

  it("signed in: the Studio form under the all-channels workspace, with the tool, the model and the words", () => {
    const href = studioTryHref(sample)!;
    const u = new URL(href, "https://x.test");
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get("model")).toBe("runway-gen4.5");
    expect(u.searchParams.get("prompt")).toBe(sample.prompt);
    expect(tryHref(sample, true)).toBe(href);
  });

  it("signed out: sign-up, with the Studio form as a same-origin next that survives the callback and /welcome", () => {
    const href = signupTryHref(sample)!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    const next = new URL(href, "https://x.test").searchParams.get("next")!;
    expect(safeNextPath(next)).toBe(next);
    expect(studioNext(next)).toBe(next);
    const after = afterSignupPath(next);
    expect(after).not.toBe(DEFAULT_AFTER_AUTH);
    // The callback keeps it whole, and /welcome reads the Studio form back out of it.
    expect(safeLoginReturn(after, "/x")).toBe(after);
    expect(studioNext(new URL(after, "https://x.test").searchParams.get("next"))).toBe(next);
  });

  it("long words are cut on a word so the form still fits through sign-up, in any script; never half a character", () => {
    for (const words of ["lantern ".repeat(200), "фонарь над тёмным озером ".repeat(40), "chiroq qorongʻi koʻl ustida ".repeat(40), "🏮 ".repeat(300)]) {
      const href = signupTryHref({ ...sample, prompt: words })!;
      const next = new URL(href, "https://x.test").searchParams.get("next")!;
      expect(afterSignupPath(next)).not.toBe(DEFAULT_AFTER_AUTH);
      const kept = new URL(next, "https://x.test").searchParams.get("prompt") ?? "";
      expect(kept.length).toBeGreaterThan(0);
      expect(words.startsWith(kept)).toBe(true);
      expect(/[\uD800-\uDBFF]$/.test(kept)).toBe(false);
    }
    expect(cutWords("one two three", 9)).toBe("one two");
    expect(cutWords("onetwothree", 5)).toBe("onetw");
  });

  it("signed in, the words are bounded as the Studio box takes them from a link, with control and bidi characters out", () => {
    const u = new URL(studioTryHref({ ...sample, prompt: "z".repeat(5000) })!, "https://x.test");
    expect(u.searchParams.get("prompt")).toHaveLength(IMPROVE_PROMPT_MAX);
    const v = new URL(studioTryHref({ ...sample, prompt: "move‮ the\u0000 sky" })!, "https://x.test");
    expect(v.searchParams.get("prompt")).toBe("move the sky");
  });

  it("a tool the Studio has no form for, or a malformed model id, gets no button", () => {
    expect(tryHref({ ...sample, capability: "sfx" }, true)).toBeNull();
    expect(tryHref({ ...sample, capability: "video_character_swap" }, false)).toBeNull();
    expect(tryHref({ ...sample, modelId: "../../evil" }, true)).toBeNull();
  });

  it("a tool that takes no words carries none", () => {
    const u = new URL(studioTryHref({ capability: "remove_bg", modelId: "some-model", prompt: "ignored" })!, "https://x.test");
    expect(u.searchParams.has("prompt")).toBe(false);
  });
});

describe("sign-up carries only a Studio form", () => {
  it("anything else is plain /welcome", () => {
    for (const bad of [null, "", "//evil.example/create", "https://evil.example/all-channels/create", "/auth/callback", "/pricing", "/a/b/create", "/all-channels/createx", "/\\evil.com/create"]) {
      expect(afterSignupPath(bad), String(bad)).toBe(DEFAULT_AFTER_AUTH);
    }
    expect(afterSignupPath("/all-channels/create?tool=t2v")).toBe(`${DEFAULT_AFTER_AUTH}?next=${encodeURIComponent("/all-channels/create?tool=t2v")}`);
  });

  it("a form too long to fit through the callback is dropped, not cut", () => {
    expect(afterSignupPath(`/all-channels/create?prompt=${"a".repeat(480)}`)).toBe(DEFAULT_AFTER_AUTH);
  });

  it("the sign-up page and the Google button both send a new account through /welcome with the form", () => {
    const page = readFileSync(join(ROOT, "app/signup/page.tsx"), "utf8");
    expect(page).toContain("afterSignupPath(new URLSearchParams(window.location.search).get(\"next\"))");
    expect(page).toContain("encodeURIComponent(after)");
    expect(page).toContain("router.push(after)");
    const google = readFileSync(join(ROOT, "components/auth/GoogleButton.tsx"), "utf8");
    expect(google).toContain('mode === "signup" && studioNext(asked) ? afterSignupPath(asked) : asked');
  });
});

describe("the Studio reads the words back from a link", () => {
  it("for the text tools too (t2v, t2i), cleaned and bounded; it only fills the form", () => {
    expect(prefillFromImprove(prefillFromQuery("t2v", undefined), { prompt: " lanterns‮ rise " })!.prompt).toBe("lanterns rise");
    expect(prefillFromImprove(prefillFromQuery("t2i", undefined), { prompt: "z".repeat(9000) })!.prompt).toHaveLength(IMPROVE_PROMPT_MAX);
    expect(prefillFromImprove(prefillFromQuery("i2v", undefined), { prompt: "drift" })!.prompt).toBe("drift");
  });

  it("not for a tool the link was never meant to fill (speech keeps its own way in)", () => {
    expect(prefillFromImprove(prefillFromQuery("tts", undefined), { prompt: "say this" })!.prompt).toBe("");
  });
});
