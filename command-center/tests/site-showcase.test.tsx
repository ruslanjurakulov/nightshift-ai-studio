// @vitest-environment jsdom
/**
 * The public site's model samples (lib/site/showcase.ts, components/site/ShowcaseGallery.tsx, lib/site/showcase-link.ts).
 *
 * What would break if these failed: a sample naming a model the registry does not have, or a public card that links a model's
 * maker or says "Powered by" (the owner decided the public site shows the AI-generated label and the model name only, 2026-11-13;
 * the maker's required credit is shown in the Studio, where the models are used, tests/model-attribution.test.tsx);
 * a cost of 0 standing in for "unknown"; a card pointing at files that are not in the repository; a model name leaking out of its
 * own card onto the rest of the site; a placeholder gallery with nothing real in it; a "Try it" that sends a visitor off-site,
 * spends anything, or loses the words on the way through sign-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, fmt, LOCALES } from "@/lib/i18n";
import raw from "@/lib/site/showcase.json";
import { SHOWCASE_ENTRIES, modelLeftOut, parseShowcase, parseShowcaseEntry, showcaseModels, sourceOnlyJobs } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { GRID_GUTTER_ROWS, ShowcaseGallery, gridSpan, showcaseItems, showcaseItemsWithSources } from "@/components/site/ShowcaseGallery";
import { level, levelOrder } from "@/lib/site/gallery-plan";
import { cutWords, signupTryHref, studioTryHref, tryHref } from "@/lib/site/showcase-link";
import { DEFAULT_AFTER_AUTH, STUDIO_NEXT_PREFIX, afterSignupPath, safeLoginReturn, safeNextPath, studioNext } from "@/lib/safe-redirect";
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { prefillFromImprove, IMPROVE_PROMPT_MAX } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { SLOTS } from "@/components/site/samples";
import { useClipsHeld } from "@/lib/site/clip-hold";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { GALLERY, SAMPLE_CARD, makerCreditProblems, without } from "./helpers/showcase-scope";
import { FIXTURE_ENTRY, FIXTURE_FILES, FIXTURE_JOB } from "./fixtures/showcase-entry";
import { aiMarkOf } from "./helpers/ai-mark";

afterEach(cleanup);

const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8")) as {
  models: { id: string; display_name: string; provider: string; capabilities: string[]; attribution: { text: string; url: string } | null; operator_preview?: boolean; terms_gate?: string | null; shutdown?: { on: string } }[];
};
const MODELS = new Map(REGISTRY.models.map((m) => [m.id, m]));
const t = dictionaries.en;

describe("the data file", () => {
  // It shipped empty, and the first export (#720) made a test that said so fail: what holds for any number of entries is that
  // the page shows every one of them, each as what it is.
  it("shows every shipped entry, and a video's plays its own clip while a picture's has none, never from off-site", () => {
    // Every shipped entry except the starting frames (Atlas/owner decision 22 Nov: a starting frame is not its own sample); those
    // are still found with their files, for the clip that credits them and for a slot that names one.
    const frames = sourceOnlyJobs(SHOWCASE_ENTRIES);
    expect(frames.size).toBeGreaterThan(0);
    expect(showcaseItems().map(({ e }) => e.jobId)).toEqual(SHOWCASE_ENTRIES.filter((e) => !frames.has(e.jobId)).map((e) => e.jobId));
    expect(showcaseItemsWithSources().map(({ e }) => e.jobId)).toEqual(SHOWCASE_ENTRIES.map((e) => e.jobId));
    for (const e of SHOWCASE_ENTRIES) {
      const clip = SHOWCASE_FILES[e.jobId].clip;
      expect(clip === null, e.jobId).toBe(e.kind === "image");
      for (const src of Object.values(clip ?? {})) expect(src, e.jobId).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i);
    }
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
      // Stale when the registry flips: a model that goes on sale must get its link back (and one taken off sale lose it).
      expect(e.operatorPreview, e.modelId).toBe(m!.operator_preview === true);
      // The export refuses a model whose vendor terms are not cleared for public display.
      expect(m!.terms_gate ?? null, e.modelId).toBeNull();
      // The shutdown date is the registry's, and no sample on the site is of a model already shut down: retire the sample, or the
      // card would advertise a model nobody can use (it already stops naming it in its link from that day).
      expect(e.shutdownOn, e.modelId).toBe(m!.shutdown?.on ?? null);
      if (e !== FIXTURE_ENTRY && e.shutdownOn) expect(e.shutdownOn > new Date().toISOString().slice(0, 10), `${e.modelId} is past its shutdown`).toBe(true);
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
      { ...FIXTURE_ENTRY, operatorPreview: undefined },
      { ...FIXTURE_ENTRY, shutdownOn: undefined },
      { ...FIXTURE_ENTRY, shutdownOn: "soon" },
      // Over the limit as the page counts it (UTF-16 units): 2001 emoji are 4002 units.
      { ...FIXTURE_ENTRY, prompt: "🏮".repeat(2001) },
    ];
    for (const b of bad) expect(parseShowcaseEntry(b), JSON.stringify(b).slice(0, 120)).toBeNull();
    // A job is shown once, newest first.
    const older = { ...FIXTURE_ENTRY, jobId: "0a0a0a0a-1111-4222-8333-444455556666", createdAt: "2026-10-01T00:00:00Z" };
    expect(parseShowcase({ entries: [older, FIXTURE_ENTRY, FIXTURE_ENTRY] }).map((e) => e.jobId)).toEqual([FIXTURE_JOB, older.jobId]);
    expect(showcaseModels([FIXTURE_ENTRY, FIXTURE_ENTRY])).toHaveLength(1);
  });
});

/**
 * Opens a card's sample (components/site/SampleDetail.tsx) and returns its dialog. The dialog is drawn on <body>, outside the
 * rendered container, so it is looked up in the document. history.back is mocked to do what a browser does (pop the dialog's
 * entry), so closing it closes it; `restore` puts history.back back.
 */
function openSample(card: Element): { dialog: HTMLElement; opener: HTMLButtonElement; restore: () => void } {
  const back = vi.spyOn(window.history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
  const opener = card.querySelector<HTMLButtonElement>("button.nx-gallery-open")!;
  expect(opener, "the card has no button that opens it").toBeTruthy();
  act(() => {
    fireEvent.click(opener);
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog, "pressing the card opened no dialog").toBeTruthy();
  return { dialog, opener, restore: () => back.mockRestore() };
}

function closeSample(dialog: HTMLElement, restore: () => void) {
  act(() => {
    fireEvent.keyDown(dialog, { key: "Escape" });
  });
  restore();
}

describe("the gallery", () => {
  it("renders nothing with no entry, or with entries whose files are missing (never a placeholder)", () => {
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[]} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={{}} />).container.innerHTML).toBe("");
    expect(showcaseItems([], SHOWCASE_FILES)).toEqual([]);
    expect(showcaseItems(SHOWCASE_ENTRIES, {})).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: a card at rest is its picture and the AI-generated badge; no model, date, note or text block under it", (code) => {
    const d = dictionaries[code];
    const g = d.site.gallery;
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    // The badge is on the picture, always (it is required, and nothing may hide it).
    expect(aiMarkOf(card.querySelector(".nx-gallery-pic > .nx-result-badge"))).toEqual({ seen: g.badge, said: g.badgeName });
    // The model is named in the dialog only (the owner has not decided on the cards, 2026-11-14): not in the card's words, not in
    // its picture's description, not in its link's name.
    expect(card.textContent).not.toContain(FIXTURE_ENTRY.modelName);
    expect(card.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(g.bgClip);
    expect(card.querySelector(".nx-gallery-model, time, .nx-gallery-unavailable, .nx-gallery-use, .nx-gallery-source, .nx-gallery-body")).toBeNull();
    for (const w of [g.notInStudio, g.gone, g.useNote, g.model, g.source]) expect(card.textContent).not.toContain(w);
    // The card's direct children: the picture, the button that opens it, and the hover/focus layer. Nothing else under the picture.
    expect([...card.children].map((c) => c.className)).toEqual(["nx-gallery-pic", "nx-gallery-open", "nx-gallery-over"]);
    // The button is the whole card, named in this language and described by the sample's words.
    const open = card.querySelector("button.nx-gallery-open") as HTMLButtonElement;
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(open.getAttribute("aria-label")).toBe(g.open);
    expect(document.getElementById(open.getAttribute("aria-describedby")!)?.textContent).toBe(FIXTURE_ENTRY.prompt);
    // The layer over the picture: the words (two lines by CSS) and "Use this prompt", never "try" a model the card does not name.
    const over = card.querySelector(".nx-gallery-over") as HTMLElement;
    expect(over.querySelector(".nx-gallery-prompt")?.textContent).toBe(FIXTURE_ENTRY.prompt);
    const use = within(over).getByRole("link", { name: g.use });
    expect(use.getAttribute("href")).toBe(signupTryHref(FIXTURE_ENTRY));
    expect(use.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById(use.getAttribute("aria-describedby")!)?.textContent).toBe(FIXTURE_ENTRY.prompt);
    // The note on what the links do is said once, under the grid, not under each card.
    expect(container.textContent).toContain(g.tryNoteSignedOut);
    expect(container.textContent!.split(g.tryNoteSignedOut)).toHaveLength(2);
    expect(container.textContent).not.toContain(g.useNote);
    expect(container.querySelector("h2")?.textContent).toBe(g.title);
    expect(makerCreditProblems(container)).toEqual([]);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the dialog shows the badge, the model, the whole prompt, the date and Use this prompt with its note, and no maker's credit", (code) => {
    const d = dictionaries[code];
    const g = d.site.gallery;
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const { dialog, restore } = openSample(container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`)!);
    // The dialog is the sample's own box: the only kind of element that may name a model.
    expect(dialog.dataset.showcaseEntry).toBe(FIXTURE_JOB);
    expect(aiMarkOf(dialog.querySelector(".nx-result-badge"))).toEqual({ seen: g.badge, said: g.badgeName });
    expect(dialog.querySelector(".nx-gallery-model strong")?.textContent).toBe("Runway Gen-4.5");
    expect(dialog.querySelector(".nx-gallery-model")?.textContent).toContain(g.model);
    expect(dialog.querySelector(".nx-sd-prompt")?.textContent).toBe(FIXTURE_ENTRY.prompt);
    expect(dialog.querySelector("time")?.getAttribute("dateTime")).toBe(FIXTURE_ENTRY.createdAt);
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(fmt(g.altClip, { model: "Runway Gen-4.5" }));
    // The entry carries Runway's credit as data (the registry's attribution); the dialog does not render it.
    expect(FIXTURE_ENTRY.attribution).not.toBeNull();
    expect(makerCreditProblems(dialog)).toEqual([]);
    expect(within(dialog).queryByRole("link", { name: /powered by/i })).toBeNull();
    // An operator preview: the dialog says, as a fact, that the model is not in the Studio, and the button neither names it in its
    // link nor in its accessible name. It says "Use this prompt" (never "try" a model its link will not open), and a visible note,
    // which also describes the button with the sample's prompt, says the words run on a model the Studio offers.
    const tryIt = within(dialog).getByRole("link", { name: g.use });
    expect(within(dialog).queryByRole("link", { name: g.try })).toBeNull();
    expect(tryIt.getAttribute("href")).toBe(signupTryHref(FIXTURE_ENTRY));
    expect(tryIt.textContent).toBe(g.use);
    expect(tryIt.hasAttribute("aria-label")).toBe(false);
    const [promptId, noteId] = tryIt.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(promptId)?.textContent).toBe(FIXTURE_ENTRY.prompt);
    expect(document.getElementById(noteId)?.textContent).toBe(g.useNote);
    expect(dialog.querySelector(".nx-gallery-use")?.textContent).toBe(g.useNote);
    expect(dialog.querySelector(".nx-gallery-unavailable")?.textContent).toBe(g.notInStudio);
    expect(tryIt.getAttribute("href")).not.toContain("model");
    // Nothing in the dialog outside the sample's own box names a model: the box is the dialog itself.
    expect(dialog.closest("[data-showcase-entry]")).toBe(dialog);
    closeSample(dialog, restore);
  });

  it.each(LOCALES.map((l) => l.code))("%s: the dialog is an accessible modal: named, focus in and trapped, page inert and still, Escape and Back close it, focus returns to the card", (code) => {
    const g = dictionaries[code].site.gallery;
    function Held() {
      return <p data-testid="held">{useClipsHeld() ? "held" : "free"}</p>;
    }
    render(<Held />);
    const { container } = render(<ShowcaseGallery t={dictionaries[code]} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    window.history.replaceState(null, "");
    const depth = window.history.length;
    const card = container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`)!;
    const { dialog, opener, restore } = openSample(card);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: g.detail })).toBe(dialog);
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(FIXTURE_ENTRY.prompt);
    // Focus moves to Close; the page under it is inert, does not scroll, and its clips hold; one history entry for the phone's Back.
    const close = within(dialog).getByRole("button", { name: g.close });
    expect(document.activeElement).toBe(close);
    expect((container as HTMLElement).inert).toBe(true);
    expect(dialog.closest("[inert]")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(screen.getByTestId("held").textContent).toBe("held");
    expect(window.history.length).toBe(depth + 1);
    // Tab wraps inside it, both ways.
    const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    // Escape from <body> (after a tap on the clip, focus is there) closes it; the page comes back and focus returns to the card.
    (document.activeElement as HTMLElement).blur();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement.style.overflow).toBe("");
    expect(screen.getByTestId("held").textContent).toBe("free");
    restore();
    // The phone's Back closes it the same way (a popstate), and Close does too.
    window.history.replaceState(null, "");
    const again = openSample(card);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    again.restore();
    window.history.replaceState(null, "");
    const third = openSample(card);
    act(() => {
      fireEvent.click(within(third.dialog).getByRole("button", { name: g.close }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    third.restore();
  });

  it("signed in, both links are the Studio form itself", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    expect(container.querySelector(".nx-gallery-try")?.getAttribute("href")).toBe(studioTryHref(FIXTURE_ENTRY));
    expect(container.textContent).toContain(t.site.gallery.tryNote);
    const { dialog, restore } = openSample(container.querySelector(SAMPLE_CARD)!);
    expect(dialog.querySelector(".nx-sd-try")?.getAttribute("href")).toBe(studioTryHref(FIXTURE_ENTRY));
    closeSample(dialog, restore);
  });

  it("a model customers can use: no not-available line, and the dialog's button names the model in its link and its accessible name; the card's never does", () => {
    const onSale = { ...FIXTURE_ENTRY, modelId: "minimax-hailuo-2.3", modelName: "MiniMax Hailuo 2.3", provider: "minimax", operatorPreview: false, attribution: null };
    const { container } = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[onSale]} files={FIXTURE_FILES} />);
    const card = container.querySelector(SAMPLE_CARD)!;
    expect(card.querySelector(".nx-gallery-try")?.textContent).toBe(t.site.gallery.use);
    expect(card.querySelector(".nx-gallery-try")?.hasAttribute("aria-label")).toBe(false);
    const { dialog, restore } = openSample(card);
    expect(dialog.querySelector(".nx-gallery-unavailable")).toBeNull();
    expect(dialog.querySelector(".nx-gallery-use")).toBeNull();
    const btn = dialog.querySelector(".nx-sd-try")!;
    expect(btn.textContent).toBe(t.site.gallery.try);
    expect(new URL(btn.getAttribute("href")!, "https://x.test").searchParams.get("model")).toBe("minimax-hailuo-2.3");
    expect(btn.getAttribute("aria-label")).toBe("Try this prompt: MiniMax Hailuo 2.3");
    closeSample(dialog, restore);
  });

  it("from the vendor's announced shutdown day, the dialog says the model is no longer in the Studio and stops naming it", () => {
    const ending = { ...FIXTURE_ENTRY, modelId: "openai-gpt-image-2", modelName: "OpenAI GPT Image 2", provider: "openai", operatorPreview: false, attribution: null, capability: "t2i", shutdownOn: "2027-02-10" };
    const before = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[ending]} files={FIXTURE_FILES} now={new Date("2027-02-09T23:59:00Z")} />).container;
    const b = openSample(before.querySelector(SAMPLE_CARD)!);
    expect(b.dialog.querySelector(".nx-gallery-unavailable")).toBeNull();
    expect(new URL(b.dialog.querySelector(".nx-sd-try")!.getAttribute("href")!, "https://x.test").searchParams.get("model")).toBe("openai-gpt-image-2");
    closeSample(b.dialog, b.restore);
    cleanup();
    const after = render(<ShowcaseGallery t={t} locale="en" signedIn entries={[ending]} files={FIXTURE_FILES} now={new Date("2027-02-10T00:00:00Z")} />).container;
    const a = openSample(after.querySelector(SAMPLE_CARD)!);
    expect(a.dialog.querySelector(".nx-gallery-unavailable")?.textContent).toBe(t.site.gallery.gone);
    const btn = a.dialog.querySelector(".nx-sd-try")!;
    expect(new URL(btn.getAttribute("href")!, "https://x.test").searchParams.has("model")).toBe(false);
    expect(btn.hasAttribute("aria-label")).toBe(false);
    expect(new URL(after.querySelector(".nx-gallery-try")!.getAttribute("href")!, "https://x.test").searchParams.has("model")).toBe(false);
    closeSample(a.dialog, a.restore);
    expect(modelLeftOut(ending, new Date("2027-02-10T00:00:00Z"))).toBe("shut_down");
    expect(modelLeftOut({ operatorPreview: true, shutdownOn: null })).toBe("preview");
    expect(modelLeftOut({ operatorPreview: false, shutdownOn: null })).toBeNull();
  });

  it("a picture has no clip and no pause button, on the card or in its dialog; a sample without words says so instead of showing an empty quote", () => {
    const pic = { ...FIXTURE_ENTRY, kind: "image" as const, capability: "t2i", modelId: "flux-2-pro", modelName: "FLUX.2 Pro", provider: "bfl", attribution: null, prompt: "" };
    const files = { [FIXTURE_JOB]: { ...FIXTURE_FILES[FIXTURE_JOB], clip: null } };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[pic]} files={files} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector(".nx-clip-pause")).toBeNull();
    expect(container.querySelector(".nx-gallery-pic")?.hasAttribute("data-clip")).toBe(false);
    expect(container.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(t.site.gallery.bgImage);
    expect(container.querySelector(".nx-gallery-prompt")?.textContent).toBe(t.site.gallery.noPrompt);
    const { dialog, restore } = openSample(container.querySelector(SAMPLE_CARD)!);
    expect(dialog.querySelector("video")).toBeNull();
    expect(dialog.querySelector(".nx-clip-pause")).toBeNull();
    expect(dialog.querySelector(".nx-sd-media")?.hasAttribute("data-clip")).toBe(false);
    expect(dialog.querySelector(".nx-sd-prompt")?.textContent).toBe(t.site.gallery.noPrompt);
    expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(fmt(t.site.gallery.altImage, { model: "FLUX.2 Pro" }));
    closeSample(dialog, restore);
  });

  it("a clip's dialog: the box is a tap area for the page's pause switch, a keyboard has the hidden pause key, and nothing is fetched where clips are not allowed", () => {
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />);
    const { dialog, restore } = openSample(container.querySelector(SAMPLE_CARD)!);
    const media = dialog.querySelector(".nx-sd-media") as HTMLElement;
    expect(media.dataset.clip).toBe("sample");
    const pause = media.querySelector("button.nx-clip-pause") as HTMLButtonElement;
    expect(pause.textContent).toBe(t.site.fx.pause);
    expect(pause.getAttribute("aria-pressed")).toBe("false");
    // jsdom has no matchMedia, which clipsAllowed reads as "not allowed" (as reduced motion or Save-Data would be): the still only.
    expect(dialog.querySelector("video")).toBeNull();
    // The box keeps the file's shape and offers it to the stylesheet as a ratio, so it is never taller than the screen.
    expect(media.style.aspectRatio).toBe(`${FIXTURE_ENTRY.width} / ${FIXTURE_ENTRY.height}`);
    closeSample(dialog, restore);
    const src = readFileSync(join(ROOT, "components/site/SampleDetail.tsx"), "utf8");
    expect(src).toContain("d.clip !== null && clipsAllowed()");
    expect(src).toMatch(/if \(!paused && document\.visibilityState === "visible"\)/);
    expect(src).toContain("useMotionTap()");
    expect(src).toContain("holdClips()");
  });

  it.each(LOCALES.map((l) => l.code))("%s: a clip animated from another sample's picture shows that picture and its model in the dialog, no maker's credit; any other input shows none", (code) => {
    const d = dictionaries[code];
    const stillJob = "0d0d0d0d-1111-4222-8333-444455556666";
    const still = { ...FIXTURE_ENTRY, jobId: stillJob, kind: "image" as const, capability: "t2i", modelId: "ideogram-3", modelName: "Ideogram 3", provider: "ideogram", attribution: { text: "Powered by Ideogram", url: "https://ideogram.ai" }, input: { kind: "none" as const }, width: 1280, height: 718 };
    const alive = { ...FIXTURE_ENTRY, input: { kind: "operator_job" as const, jobId: stillJob, assetId: "0e0e0e0e-1111-4222-8333-444455556666" } };
    const files = { ...FIXTURE_FILES, [stillJob]: { poster: "/still.webp", posterSm: "/still-sm.webp", clip: null } };
    const { container } = render(<ShowcaseGallery t={d} locale={code} entries={[alive, still]} files={files} />);
    // Not on the card: the card is its own picture alone.
    expect(container.querySelector(".nx-gallery-source")).toBeNull();
    const opened = openSample(container.querySelector(`[data-showcase-entry="${FIXTURE_JOB}"]`)!);
    const fig = opened.dialog.querySelector(".nx-gallery-source") as HTMLElement;
    expect(fig.dataset.sourceEntry).toBe(stillJob);
    const img = fig.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/still-sm.webp");
    expect(img.getAttribute("alt")).toBe(fmt(d.site.gallery.altSource, { model: "Ideogram 3" }));
    expect(fig.textContent).toContain(d.site.gallery.source);
    expect(fig.querySelector("strong")?.textContent).toBe("Ideogram 3");
    // Neither the picture's maker nor the clip's is linked or credited.
    expect(makerCreditProblems(opened.dialog)).toEqual([]);
    closeSample(opened.dialog, opened.restore);
    // The picture is the clip's starting frame only, so it is no card of its own (Atlas/owner decision 22 Nov: a starting frame is
    // not its own sample); it is seen in the clip's dialog above. An animation of site art or of a job that is not a sample here
    // shows no source.
    expect(container.querySelector(`[data-showcase-entry="${stillJob}"]`)).toBeNull();
    cleanup();
    const plain = openSample(render(<ShowcaseGallery t={d} locale={code} entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />).container.querySelector(SAMPLE_CARD)!);
    expect(plain.dialog.querySelector(".nx-gallery-source")).toBeNull();
    closeSample(plain.dialog, plain.restore);
    cleanup();
    const stray = openSample(render(<ShowcaseGallery t={d} locale={code} entries={[alive]} files={FIXTURE_FILES} />).container.querySelector(SAMPLE_CARD)!);
    expect(stray.dialog.querySelector(".nx-gallery-source")).toBeNull();
    closeSample(stray.dialog, stray.restore);
  });

  it("a format's sample names the format over its picture on hover and in full in its dialog, never as a block under the card", () => {
    const fmtCard = { id: "fruit", job: FIXTURE_JOB, title: "Fruit drama", body: "Talking food in a soap-opera scene.", entry: FIXTURE_ENTRY };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} formats={[fmtCard]} />);
    const card = container.querySelector(SAMPLE_CARD)!;
    expect(card.querySelector(".nx-gallery-over .nx-gallery-over-format")?.textContent).toBe("Fruit drama");
    expect(card.textContent).not.toContain(fmtCard.body);
    const { dialog, restore } = openSample(card);
    const box = dialog.querySelector(".nx-gallery-format") as HTMLElement;
    expect(box.dataset.format).toBe("fruit");
    expect(box.querySelector("h3")?.textContent).toBe("Fruit drama");
    expect(box.textContent).toContain(fmtCard.body);
    closeSample(dialog, restore);
  });

  it("is the only place a model is named: outside the entry boxes the section names no provider, and each card's model is a registry model with a job id", () => {
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
    // The mark reads just "AI" (owner, 2026-11-22); what a screen reader hears for it still says AI-generated.
    expect(s.gallery.badge).toBe("AI");
    expect(s.gallery.badgeName).toMatch(AI);
    expect(s.credits.generated).toMatch(AI);
    expect(s.gallery.altClip).toContain("{model}");
    expect(s.gallery.bgClip).toMatch(AI);
    expect(s.gallery.bgImage).toMatch(AI);
    expect(s.gallery.tryAria.startsWith(s.gallery.try)).toBe(true);
    expect(s.gallery.notInStudio + s.gallery.gone).not.toMatch(PROVIDER_BRANDS);
    // Statements of fact, not promises (CLAUDE.md #5): nothing about when or whether it will come.
    expect(s.gallery.notInStudio + s.gallery.gone + s.gallery.useNote).not.toMatch(/coming|soon|скоро|появится|tez orada|paydo/i);
    // A button that does not open the sample's model says "use" the words, not "try" them; it is another word from "try".
    expect(s.gallery.use).not.toBe(s.gallery.try);
    expect(s.gallery.useNote).not.toMatch(PROVIDER_BRANDS);
    // The heading claims nothing about which models are on sale.
    expect(s.gallery.title).toContain("Nightshift");
    // The dialog's own words exist in every language and differ from each other.
    for (const w of [s.gallery.open, s.gallery.detail, s.gallery.close]) expect(w.trim().length).toBeGreaterThan(2);
    expect(new Set([s.gallery.open, s.gallery.detail, s.gallery.close]).size).toBe(3);
  });

  it("the stylesheet lays the cards out media first: a two-column masonry on a phone (nothing scrolls sideways), three and four above it, row by row, tight gutters, no maker's credit link", () => {
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toMatch(/\.nx-gallery \{ --cols: 2; display: block; columns: var\(--cols\);/);
    expect(css).not.toMatch(/\.nx-gallery \{[^}]*overflow-x/);
    expect(css).toMatch(/\.nx-gallery-card \{ position: relative; break-inside: avoid; margin: 0 0 8px;/);
    expect(css).toMatch(/@media \(min-width: 760px\) \{\n  \.nx-gallery \{ --cols: 3; \}/);
    expect(css).toMatch(/@media \(min-width: 1240px\) \{ \.nx-gallery \{ --cols: 4; \} \}/);
    // Where container units work (every current browser), a grid laid out row by row, so reading and Tab order go across the rows
    // and the columns end as evenly as the cards allow: a row is a hundredth of a column, a card spans its file's height in rows (gridSpan).
    expect(css).toMatch(/\.nx-gallery-box \{[^}]*container-type: inline-size;/);
    const grid = css.slice(css.indexOf("@supports (width: 1cqw) {"), css.indexOf("}\n}", css.indexOf("@supports (width: 1cqw) {")));
    expect(grid).toMatch(/\.nx-gallery \{ --cw: calc\(100cqw \/ \(var\(--cols\) \+ 0\.04 \* \(var\(--cols\) - 1\)\)\); display: grid; grid-template-columns: repeat\(var\(--cols\), minmax\(0, 1fr\)\); grid-auto-rows: calc\(var\(--cw\) \/ 100\);/);
    expect(grid).toContain(".nx-gallery-card { grid-row-end: span var(--span, 60); margin: 0 0 calc(var(--cw) * 0.04); }");
    expect(grid).not.toMatch(/(?<![-\w])columns:|grid-auto-flow: column/);
    // The badge sits top right (a camera's timestamp burned into a picture sits top left), on an edged dark chip.
    expect(css).toMatch(/\.nx-gallery-pic \.nx-result-badge \{[^}]*left: auto; right: 8px;[^}]*border: 1px solid/);
    // The box takes the clip's own shape from the element; the stylesheet forces none.
    expect(css).not.toMatch(/\.nx-gallery-pic \{[^}]*aspect-ratio/);
    expect(css).not.toMatch(/\.nx-gallery-attr|\.nx-ai-attr/);
    // No text block under a card: the words are a layer over the picture, hidden at rest and taking no tap there, shown only under
    // a fine pointer's hover or keyboard focus.
    expect(css).not.toMatch(/\.nx-gallery-body/);
    expect(css).toMatch(/\.nx-gallery-over \{ position: absolute;[^}]*opacity: 0; pointer-events: none; \}/);
    expect(css).toContain(".nx-gallery-card:has(:focus-visible) .nx-gallery-over { opacity: 1; }");
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\n  \.nx-gallery-card:hover \.nx-gallery-over \{ opacity: 1; \}/);
    expect(css).toMatch(/\.nx-gallery-prompt \{[^}]*-webkit-line-clamp: 2; line-clamp: 2;/);
    // The badge is never hidden or cut: no display, visibility or opacity rule on it, and it wraps on a narrow card.
    const badge = [...css.matchAll(/([^{}]*\.nx-gallery[^{}]*\.nx-result-badge[^{}]*)\{([^}]*)\}/g)];
    expect(badge.length).toBeGreaterThan(0);
    for (const [, , body] of badge) {
      expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0|text-overflow/);
    }
    // The dialog's sheet: dark in both themes, above the page, the picture never taller than the screen.
    const sd = readFileSync(join(ROOT, "components/site/sample-detail.css"), "utf8");
    expect(sd).toMatch(/\.nx-sd \{[^}]*position: fixed;[^}]*inset: 0;/);
    expect(sd).toMatch(/width: min\(100%, calc\(var\(--sd-mh\) \* var\(--sd-r, 1\)\)\)/);
    // Motion only where it is allowed.
    const outsideNoPref = sd.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, "").replace(/@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    expect(outsideNoPref).not.toMatch(/\btransition\s*:|\banimation\s*:/);
  });

  it("each card spans its file's height in grid rows, so two files a few pixels apart line up, and the grid has one pause key, not one per card", () => {
    expect(gridSpan(1280, 720)).toBe(56 + GRID_GUTTER_ROWS);
    // The live page's first row was off by 4 px: a 1280 x 718 picture beside 1280 x 720 clips. Same rows now.
    expect(gridSpan(1280, 718)).toBe(gridSpan(1280, 720));
    expect(gridSpan(1280, 2240)).toBe(175 + GRID_GUTTER_ROWS);
    const tallJob = "0f0f0f0f-1111-4222-8333-444455556666";
    const tall = { ...FIXTURE_ENTRY, jobId: tallJob, width: 1280, height: 2240 };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY, tall]} files={{ ...FIXTURE_FILES, [tallJob]: FIXTURE_FILES[FIXTURE_JOB] }} />);
    const cards = [...container.querySelectorAll<HTMLElement>(SAMPLE_CARD)];
    expect(cards.map((c) => c.style.getPropertyValue("--span"))).toEqual([String(gridSpan(FIXTURE_ENTRY.width, FIXTURE_ENTRY.height)), String(gridSpan(1280, 2240))]);
    // Two clips, one keyboard pause key for the grid, outside the cards (each card is the button that opens its sample).
    const pauses = [...container.querySelectorAll(".nx-clip-pause")];
    expect(pauses).toHaveLength(1);
    expect(pauses[0].closest(SAMPLE_CARD)).toBeNull();
    expect(pauses[0].parentElement?.className).toBe("nx-gallery-box");
    expect(pauses[0].textContent).toBe(t.site.fx.pause);
    // The DOM order is the cards' order (the grid places them row by row in that order): Tab follows it.
    expect(cards.map((c) => c.dataset.showcaseEntry)).toEqual([FIXTURE_JOB, tallJob]);
    // At three and four columns each card carries its planned place (lib/site/gallery-plan.ts level), and the stylesheet uses it.
    const spans = cards.map((c) => Number(c.style.getPropertyValue("--span")));
    for (const cols of [3, 4]) {
      const cells = level(spans, cols).cells;
      cards.forEach((c, i) => {
        expect(c.style.getPropertyValue(`--c${cols}`)).toBe(String(cells[i].col));
        expect(c.style.getPropertyValue(`--r${cols}`)).toBe(String(cells[i].row));
        expect(c.style.getPropertyValue(`--s${cols}`)).toBe(String(cells[i].span));
      });
    }
    const css = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(css).toContain("@media (min-width: 760px) { .nx-gallery-card { grid-column: var(--c3, auto); grid-row: var(--r3, auto) / span var(--s3, var(--span, 60)); } }");
    expect(css).toContain("@media (min-width: 1240px) { .nx-gallery-card { grid-column: var(--c4, auto); grid-row: var(--r4, auto) / span var(--s4, var(--span, 60)); } }");
    expect(css).toMatch(/\.nx-gallery-pic \.nx-art \{[^}]*object-fit: cover; object-position: center;/);
  });

  it("each card keeps its clip's own shape: a 9:16 sample stands tall, a 16:9 one lies wide, its box sized from the file before it loads", () => {
    const tall = { ...FIXTURE_ENTRY, width: 1280, height: 2276 };
    const { container } = render(<ShowcaseGallery t={t} locale="en" entries={[tall]} files={FIXTURE_FILES} />);
    const card = container.querySelector(`#sample-${FIXTURE_JOB}`) as HTMLElement;
    expect(card.dataset.shape).toBe("tall");
    expect((card.querySelector(".nx-gallery-pic") as HTMLElement).style.aspectRatio).toBe("1280 / 2276");
    cleanup();
    const wide = render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} />).container;
    expect((wide.querySelector(`#sample-${FIXTURE_JOB}`) as HTMLElement).dataset.shape).toBe("wide");
    // A page that shows the sample in a slot leaves it out of its gallery (no clip twice on a page).
    cleanup();
    expect(render(<ShowcaseGallery t={t} locale="en" entries={[FIXTURE_ENTRY]} files={FIXTURE_FILES} exclude={[FIXTURE_JOB]} />).container.innerHTML).toBe("");
  });
});

/**
 * The gallery over the real data file, not the fixture: the page-wide tests (public-pages, site-engage, site-engage-5) read the
 * page with the gallery or its cards taken out, so this is where what the cards themselves say is held, for whatever the owner
 * has merged. With nothing merged it renders nothing.
 */
describe("the shipped samples", () => {
  it.each(LOCALES.map((l) => l.code))("%s: a card names no model and is labelled AI-generated; its dialog names it only as its registry name, picture description and button; neither credits a maker or claims stock", (code) => {
    const d = dictionaries[code];
    const g = d.site.gallery;
    const { container } = render(<ShowcaseGallery t={d} locale={code} />);
    const items = showcaseItems();
    if (items.length === 0) {
      expect(container.innerHTML).toBe("");
      return;
    }
    const section = container.querySelector(GALLERY) as HTMLElement;
    expect(section).toBeTruthy();
    // The section's own words (heading, lead, notes) name no model; only the sample boxes do.
    expect(without(section, SAMPLE_CARD).innerHTML).not.toMatch(PROVIDER_BRANDS);
    const cards = [...section.querySelectorAll<HTMLElement>(SAMPLE_CARD)];
    // Every sample once, in the order the level plan lays them out (lib/site/gallery-plan.ts levelOrder over the data file's order).
    const planned = levelOrder(items.map(({ e }) => gridSpan(e.width, e.height))).map((i) => items[i].e.jobId);
    expect(cards.map((c) => c.dataset.showcaseEntry)).toEqual(planned);
    const s = d.site.samples;
    const noStock = (el: HTMLElement) => {
      expect(el.querySelector("[data-sample], [data-art-id], [data-kind], .nx-result-credit, .nx-show-note")).toBeNull();
      for (const stock of [s.tag, s.frameTag, s.clipTag, s.note]) expect(el.textContent).not.toContain(stock);
      expect(el.innerHTML).not.toMatch(/pexels/i);
    };
    for (const card of cards) {
      const { e, f } = items.find(({ e }) => e.jobId === card.dataset.showcaseEntry)!;
      const m = MODELS.get(e.modelId);
      if (!m) throw new Error(`${e.jobId}: ${e.modelId} is not in schemas/model_registry.json`);
      expect(card.dataset.model).toBe(m.id);
      const clip = e.kind === "video" && f.clip !== null;

      // The card: labelled as an AI generation, on the picture, clip or not; nothing on it says stock or names a photographer, and
      // nothing on it names a model (its link carries the model id for the Studio form only, and says "Use this prompt").
      expect(aiMarkOf(card.querySelector(".nx-gallery-pic > .nx-result-badge")), e.jobId).toEqual({ seen: g.badge, said: g.badgeName });
      expect(card.querySelector(".nx-gallery-pic")?.getAttribute("data-clip") ?? null).toBe(clip ? "sample" : null);
      noStock(card);
      expect(card.querySelector(".nx-gallery-pic > img")?.getAttribute("alt")).toBe(clip ? g.bgClip : g.bgImage);
      const rest = card.cloneNode(true) as HTMLElement;
      rest.removeAttribute("data-model");
      const link = rest.querySelector(".nx-gallery-try");
      expect(link?.getAttribute("href") ?? null).toBe(tryHref(e, false));
      if (link) {
        expect(link.textContent).toBe(g.use);
        expect(link.hasAttribute("aria-label")).toBe(false);
        link.removeAttribute("href");
      }
      expect(rest.textContent, e.jobId).not.toContain(m.display_name);
      expect(rest.textContent, e.jobId).not.toMatch(PROVIDER_BRANDS);
      expect(rest.innerHTML, e.jobId).not.toMatch(PROVIDER_BRANDS);
      expect(makerCreditProblems(card), e.jobId).toEqual([]);

      // The dialog: every place it may name its model, each exactly as the registry has it; with those taken out, nothing names one
      // (the prompt included: the words a job was given are shown, and they must not name a model or maker either).
      const { dialog, restore } = openSample(card);
      expect(dialog.dataset.showcaseEntry).toBe(e.jobId);
      expect(aiMarkOf(dialog.querySelector(".nx-result-badge")), e.jobId).toEqual({ seen: g.badge, said: g.badgeName });
      noStock(dialog);
      const box = dialog.cloneNode(true) as HTMLElement;
      // A clip animated from another sample's picture shows that picture: named, credited and described exactly as that picture's
      // own dialog does, and only when the input really is that sample's job.
      const fig = box.querySelector<HTMLElement>(".nx-gallery-source");
      // Looked up among every entry: a starting frame has no card of its own (Atlas/owner decision 22 Nov) but is still credited here.
      const src = e.kind === "video" && e.input.kind === "operator_job" ? showcaseItemsWithSources().find((it) => it.e.jobId === (e.input as { jobId: string }).jobId) : undefined;
      expect(fig?.dataset.sourceEntry ?? null, e.jobId).toBe(src?.e.jobId ?? null);
      if (fig && src) {
        const sm = MODELS.get(src.e.modelId)!;
        expect(fig.querySelector("strong")?.textContent).toBe(sm.display_name);
        // (Under vitest an imported file has no .src, so both sides are empty there; next build fills them.)
        expect(fig.querySelector("img")?.getAttribute("src") ?? null).toBe(src.f.posterSm ?? null);
        expect(fig.querySelector("img")?.getAttribute("alt")).toBe(fmt(g.altSource, { model: sm.display_name }));
        fig.remove();
      }
      const name = box.querySelector(".nx-gallery-model strong")!;
      expect(name.textContent).toBe(m.display_name);
      name.remove();
      // The maker's credit (Runway's and Ideogram's included) is data only: no link to a maker, no "Powered by".
      expect(makerCreditProblems(dialog), e.jobId).toEqual([]);
      const img = box.querySelector("img")!;
      expect(img.getAttribute("alt")).toBe(fmt(clip ? g.altClip : g.altImage, { model: m.display_name }));
      img.removeAttribute("alt");
      const tryIt = box.querySelector(".nx-sd-try");
      expect(tryIt?.getAttribute("href") ?? null).toBe(tryHref(e, false));
      if (tryIt) {
        const label = tryIt.getAttribute("aria-label");
        expect(label).toBe(modelLeftOut(e) ? null : fmt(g.tryAria, { model: m.display_name }));
        tryIt.removeAttribute("aria-label");
        tryIt.removeAttribute("href");
      }
      expect(box.textContent, e.jobId).not.toMatch(PROVIDER_BRANDS);
      expect(box.innerHTML, e.jobId).not.toMatch(PROVIDER_BRANDS);
      closeSample(dialog, restore);
    }
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
    const v = new URL(studioTryHref({ ...sample, prompt: `move${String.fromCodePoint(0x202e)} the${String.fromCodePoint(0)} sky` })!, "https://x.test");
    expect(v.searchParams.get("prompt")).toBe("move the sky");
  });

  it("an operator-preview model is left out of the link, in and out of sign-up; the tool and the words stay", () => {
    const preview = { ...sample, operatorPreview: true };
    const u = new URL(studioTryHref(preview)!, "https://x.test");
    expect(u.searchParams.has("model")).toBe(false);
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get("prompt")).toBe(sample.prompt);
    const next = new URL(signupTryHref(preview)!, "https://x.test").searchParams.get("next")!;
    expect(new URL(next, "https://x.test").searchParams.has("model")).toBe(false);
    // ...and a model customers can use is named.
    expect(new URL(studioTryHref({ ...sample, operatorPreview: false })!, "https://x.test").searchParams.get("model")).toBe(sample.modelId);
  });

  it("invisible characters never travel in the words: zero-width, tags, soft hyphen, letter marks, variation-selector runs", () => {
    const c = (...cps: number[]) => String.fromCodePoint(...cps);
    const hidden =
      `lan${c(0x200b)}te${c(0xad)}rns${c(0xfeff)}${c(0x61c)}${c(0x180e)} ${c(0x2063)}ri${c(0xe0100)}se` +
      `${c(0xe0041, 0xe0042)}${c(0xfe00, 0xfe01, 0xfe0f)}`;
    expect(new URL(studioTryHref({ ...sample, prompt: hidden })!, "https://x.test").searchParams.get("prompt")).toBe("lanterns rise");
    expect(prefillFromImprove(prefillFromQuery("t2v", undefined), { prompt: hidden })!.prompt).toBe("lanterns rise");
    // One variation selector after a symbol is how an emoji is written, and it stays.
    const heart = `love ${c(0x2764, 0xfe0f)}`;
    expect(new URL(studioTryHref({ ...sample, prompt: heart })!, "https://x.test").searchParams.get("prompt")).toBe(heart);
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
    for (const bad of [null, "", "//evil.example/create", "https://evil.example/all-channels/create", "/auth/callback", "/pricing", "/a/b/create", "/all-channels/createx", "/\\evil.com/create", "/api/create", "/oauth/create", "/auth/create", "/admin/create", "/login/create", "/signup/create", "/welcome/create", "/chronos/create"]) {
      expect(afterSignupPath(bad), String(bad)).toBe(DEFAULT_AFTER_AUTH);
    }
    expect(afterSignupPath("/all-channels/create?tool=t2v")).toBe(`${DEFAULT_AFTER_AUTH}?next=${encodeURIComponent("/all-channels/create?tool=t2v")}`);
  });

  it("is pinned to the all-channels workspace, the only one the link builder emits", () => {
    expect(STUDIO_NEXT_PREFIX).toBe(`/${ALL_CHANNELS_SLUG}/create`);
    expect(studioTryHref({ capability: "t2v", modelId: "some-model", prompt: "x" })!.startsWith(`${STUDIO_NEXT_PREFIX}?`)).toBe(true);
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
    expect(prefillFromImprove(prefillFromQuery("t2v", undefined), { prompt: ` lanterns${String.fromCodePoint(0x202e)} rise ` })!.prompt).toBe("lanterns rise");
    expect(prefillFromImprove(prefillFromQuery("t2i", undefined), { prompt: "z".repeat(9000) })!.prompt).toHaveLength(IMPROVE_PROMPT_MAX);
    expect(prefillFromImprove(prefillFromQuery("i2v", undefined), { prompt: "drift" })!.prompt).toBe("drift");
  });

  it("not for a tool the link was never meant to fill (speech keeps its own way in)", () => {
    expect(prefillFromImprove(prefillFromQuery("tts", undefined), { prompt: "say this" })!.prompt).toBe("");
  });
});
