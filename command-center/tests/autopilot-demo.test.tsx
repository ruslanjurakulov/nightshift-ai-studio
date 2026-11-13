// @vitest-environment jsdom
/**
 * The landing's autopilot walk-through (components/site/AutopilotDemo.tsx) and the phone's Shorts feed
 * (components/site/ShortsFeed.tsx). What would break:
 * - an "artifact" on the walk-through that is not in the repository's files (an invented example passed off as output);
 * - the upload or approval drawing shown without saying it is a drawing;
 * - the publish step promising more than CLAUDE.md rules 2 and 3 allow;
 * - a maker's "Powered by" credit, a visible pause key or a provider name on either (owner's rules, 2026-11-13);
 * - the feed autoplaying where it may not, offering an "unmute" for a clip with no sound, or letting focus out.
 */
import { readFileSync } from "node:fs";
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

import { dictionaries, LOCALES } from "@/lib/i18n";
import { siteAutopilotEn } from "@/lib/i18n/site-autopilot/en";
import { siteAutopilotRu } from "@/lib/i18n/site-autopilot/ru";
import { siteAutopilotUz } from "@/lib/i18n/site-autopilot/uz";
import { AUTOPILOT_STAGES, CLAIMS, DEMO_SCRIPT, SCENES, STAGE_EVIDENCE, TIMED_WORDS } from "@/lib/site/autopilot-artifacts";
import { AutopilotDemo } from "@/components/site/AutopilotDemo";
import { ShortsFeed } from "@/components/site/ShortsFeed";
import { SITE_CLIPS_HAVE_SOUND, shortsItems } from "@/components/site/shorts";
import type { ShowcaseEntry, ShowcaseFiles } from "@/lib/site/showcase";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { FIXTURE_ENTRY, FIXTURE_FILES, FIXTURE_JOB } from "./fixtures/showcase-entry";

afterEach(cleanup);
// jsdom has no media playback; the feed only needs play() and pause() to exist.
vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

const REPO = join(__dirname, "..", "..");
const json = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

describe("the walk-through shows only what the repository's files hold", () => {
  const script = json("samples/demo_script.json");

  it("copies samples/demo_script.json word for word", () => {
    expect(DEMO_SCRIPT.topic).toBe(script.topic);
    expect(DEMO_SCRIPT.title).toBe(script.title);
    expect(DEMO_SCRIPT.titleAb).toBe(script.title_ab);
    expect(DEMO_SCRIPT.hookSentence).toBe(script.hook_sentence);
    expect([...DEMO_SCRIPT.tags]).toEqual(script.tags);
    expect(DEMO_SCRIPT.thumbnailPromptA).toBe(script.thumbnail_prompt_a);
    expect(DEMO_SCRIPT.thumbnailPromptB).toBe(script.thumbnail_prompt_b);
    expect(DEMO_SCRIPT.thumbnailOverlayText).toBe(script.thumbnail_overlay_text);
    expect(DEMO_SCRIPT.sections.map((s) => [s.name, s.durationHint])).toEqual(script.sections.map((s: { name: string; duration_hint: number }) => [s.name, s.duration_hint]));
    expect(DEMO_SCRIPT.hookNarration).toBe(script.sections[0].narration);
    for (const k of DEMO_SCRIPT.keywords) {
      expect([...k.words]).toEqual(script.sections.find((s: { name: string }) => s.name === k.section).keywords);
    }
  });

  it("copies the video engine's fixtures word for word", () => {
    const evidence = json("video-engine/fixtures/evidence-card.json");
    expect(CLAIMS.map((c) => ({ id: c.id, text: c.text, status: c.status, requires_human_review: c.requiresHumanReview }))).toEqual(evidence.claims);
    const title = json("video-engine/fixtures/title-card.json");
    expect(TIMED_WORDS.map((w) => ({ text: w.text, start_s: w.start, end_s: w.end }))).toEqual(title.words);
    for (const s of SCENES) {
      const f = json(`video-engine/fixtures/${s.file}`);
      expect({ id: s.id, recipe: s.recipe, transition: s.transition, narration: s.narration }).toEqual({
        id: f.scene.id,
        recipe: f.scene.shot.recipe,
        transition: f.transition,
        narration: f.scene.narration,
      });
    }
  });

  it("has a file for every stage it calls a file, and calls upload and approval mocks", () => {
    expect(AUTOPILOT_STAGES).toEqual(["topic", "research", "script", "voice", "visuals", "render", "upload", "approve", "publish"]);
    expect(STAGE_EVIDENCE.upload).toBe("mock");
    expect(STAGE_EVIDENCE.approve).toBe("mock");
    expect(STAGE_EVIDENCE.publish).toBe("rules");
  });
});

describe("the walk-through on the page", () => {
  it.each(LOCALES.map((l) => l.code))("%s: nine stages, one panel live at a time, the drawings tagged as drawings", (code) => {
    const copy = dictionaries[code].site.autopilot.demo;
    const { container } = render(<AutopilotDemo copy={copy} />);
    const rail = screen.getByRole("list", { name: copy.rail });
    const steps = within(rail).getAllByRole("button");
    expect(steps).toHaveLength(9);
    expect(steps[0].getAttribute("aria-current")).toBe("step");
    const live = () => [...container.querySelectorAll<HTMLElement>(".nx-ap-panel")].filter((p) => !p.hasAttribute("inert"));
    expect(live().map((p) => p.dataset.stage)).toEqual(["topic"]);
    fireEvent.click(steps[6]);
    expect(live().map((p) => p.dataset.stage)).toEqual(["upload"]);
    expect(steps[6].getAttribute("aria-current")).toBe("step");
    fireEvent.click(screen.getByRole("button", { name: copy.next }));
    expect(live().map((p) => p.dataset.stage)).toEqual(["approve"]);
    for (const id of ["upload", "approve"]) {
      const panel = container.querySelector(`[data-stage="${id}"]`)!;
      expect(panel.querySelector(".nx-ap-tag")?.textContent).toBe(copy.mockTag);
      expect(panel.textContent).toContain(copy.mockNote);
    }
    for (const id of ["topic", "research", "script", "voice", "visuals", "render"]) {
      expect(container.querySelector(`[data-stage="${id}"] .nx-ap-tag`)?.textContent).toBe(copy.fileTag);
    }
    // Every panel is in the page from the start (one grid cell), so moving between stages shifts nothing.
    expect(container.querySelectorAll(".nx-ap-panel")).toHaveLength(9);
  });

  it.each(LOCALES.map((l) => l.code))("%s: no maker, no provider, no pause key, nothing that approves or publishes", (code) => {
    const copy = dictionaries[code].site.autopilot.demo;
    const { container } = render(<AutopilotDemo copy={copy} />);
    expect(container.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(container.textContent).not.toMatch(/powered by/i);
    expect(container.querySelector('a[href*="runway.com"], a[href*="ideogram.ai"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /pause|пауза|pauza/i })).toBeNull();
    // The drawn "Approve" is text, not a key: the only buttons are the stages and previous/next.
    expect(container.querySelectorAll("button")).toHaveLength(11);
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/signup", "/studio#publish"]);
  });

  it("says what docs/APPROVE_PUBLISH_1B.md says: off by default, an administrator, one request, a re-check, the read-back, private on failure", () => {
    const p = siteAutopilotEn.demo.publish;
    const all = [p.defaultBody, p.autoBody, ...p.approvedSteps].join(" ");
    expect(all).toMatch(/off by default/i);
    expect(all).toMatch(/only someone who manages the workspace can switch it on/i);
    expect(all).toMatch(/never the bot/);
    expect(all).toMatch(/queues one request/);
    expect(all).toMatch(/asks the database again/);
    expect(all).toMatch(/reads the video back/);
    expect(all).toMatch(/only when YouTube’s answer says public/);
    expect(all).toMatch(/Any failure leaves the video private/);
    expect(siteAutopilotEn.demo.stages.find((s) => s.id === "approve")!.body).toMatch(/does not by itself change the video’s privacy/);
  });

  it("has the same shape in Russian and Uzbek", () => {
    const shape = (o: unknown): unknown => (Array.isArray(o) ? o.map(shape) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : typeof o);
    expect(shape(siteAutopilotRu)).toEqual(shape(siteAutopilotEn));
    expect(shape(siteAutopilotUz)).toEqual(shape(siteAutopilotEn));
    const ids = (d: typeof siteAutopilotEn) => d.demo.stages.map((s) => s.id);
    expect(ids(siteAutopilotRu)).toEqual(AUTOPILOT_STAGES);
    expect(ids(siteAutopilotUz)).toEqual(AUTOPILOT_STAGES);
  });
});

const TALL = "0b0b0b0b-1111-4222-8333-777788889999";
const SQUARE = "0b0b0b0b-1111-4222-8333-aaaabbbbcccc";
const entries: ShowcaseEntry[] = [
  FIXTURE_ENTRY,
  { ...FIXTURE_ENTRY, jobId: TALL, capability: "t2v", input: { kind: "none" }, width: 1280, height: 2240 },
  { ...FIXTURE_ENTRY, jobId: SQUARE, capability: "t2v", input: { kind: "none" }, width: 1280, height: 1600 },
];
const files: Record<string, ShowcaseFiles> = { ...FIXTURE_FILES, [TALL]: FIXTURE_FILES[FIXTURE_JOB], [SQUARE]: FIXTURE_FILES[FIXTURE_JOB] };
const items = entries.map((e) => ({ e, f: files[e.jobId] }));
const NOW = new Date("2026-11-13T12:00:00Z");

function renderFeed(code: "en" | "ru" | "uz" = "en") {
  const t = dictionaries[code];
  const g = t.site.gallery;
  return render(
    <ShortsFeed items={shortsItems(items, false, NOW)} copy={t.site.autopilot.shorts} g={{ badge: g.badge, try: g.try, tryAria: g.tryAria, use: g.use, useNote: g.useNote, noPrompt: g.noPrompt }} />,
  );
}

describe("the Shorts feed", () => {
  it("takes the 9:16 clips only, and knows the site's clips are silent", () => {
    expect(shortsItems(items, false, NOW).map((i) => i.jobId)).toEqual([TALL]);
    // tools/export_showcase.py encodes every rendition with -an: the sound key must not promise sound.
    const exporter = readFileSync(join(REPO, "tools/export_showcase.py"), "utf8");
    expect(exporter).toMatch(/"-an"/);
    expect(SITE_CLIPS_HAVE_SOUND).toBe(false);
  });

  it("renders nothing without a vertical clip", () => {
    const t = dictionaries.en;
    const { container } = render(<ShortsFeed items={[]} copy={t.site.autopilot.shorts} g={t.site.gallery} />);
    expect(container.innerHTML).toBe("");
  });

  it.each(LOCALES.map((l) => l.code))("%s: opens as a modal, names the model only in the clip's own box, and closes back to its key", (code) => {
    const s = dictionaries[code].site.autopilot.shorts;
    const back = vi.spyOn(window.history, "back").mockImplementation(() => window.dispatchEvent(new PopStateEvent("popstate")));
    renderFeed(code);
    const key = screen.getByRole("button", { name: s.open });
    fireEvent.click(key);
    const dialog = screen.getByRole("dialog", { name: s.dialog });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: s.close }));
    const slide = dialog.querySelector(`[data-showcase-entry="${TALL}"]`) as HTMLElement;
    expect(slide.textContent).toContain(FIXTURE_ENTRY.modelName);
    expect(slide.textContent).toContain(FIXTURE_ENTRY.prompt);
    // The model is named inside its own box only, and no maker credit at all.
    const rest = dialog.cloneNode(true) as HTMLElement;
    rest.querySelectorAll("[data-showcase-entry]").forEach((n) => n.remove());
    expect(rest.textContent).not.toMatch(PROVIDER_BRANDS);
    expect(dialog.textContent).not.toMatch(/powered by/i);
    expect(dialog.querySelector('a[href*="runway.com"]')).toBeNull();
    // An operator preview: "Use this prompt", as on the gallery card.
    expect(within(slide).getByRole("link").textContent).toContain(dictionaries[code].site.gallery.use);
    // The sound key does not offer to unmute a clip with no sound.
    const sound = screen.getByRole("button", { name: s.noSound }) as HTMLButtonElement;
    expect(sound.disabled).toBe(true);
    // No pause key on screen: the keyboard one is hidden until focused (.nx-shorts-kbd), and nothing autoplays here (no matchMedia).
    const kbd = dialog.querySelector(".nx-shorts-kbd") as HTMLButtonElement;
    expect(kbd.getAttribute("aria-label")).toBe(s.play);
    expect(dialog.querySelector("video")).toBeNull();
    fireEvent.click(kbd);
    expect(dialog.querySelector("video")).not.toBeNull();
    expect(kbd.getAttribute("aria-label")).toBe(s.pause);
    // Escape goes back in history (the back button closes it the same way) and focus returns to the key.
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(key);
    back.mockRestore();
  });

  it("keeps Tab inside the feed", () => {
    const s = dictionaries.en.site.autopilot.shorts;
    renderFeed();
    fireEvent.click(screen.getByRole("button", { name: s.open }));
    const dialog = screen.getByRole("dialog");
    const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => !el.closest("[inert]"));
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("autopilot-demo.css", () => {
  const css = readFileSync(join(__dirname, "..", "components/site/autopilot-demo.css"), "utf8");
  it("moves nothing unless motion is allowed", () => {
    const open = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, "");
    expect(open).toBeGreaterThan(0);
    expect(outside).not.toMatch(/\btransition\s*:|\banimation\s*:|scroll-behavior:\s*smooth/);
  });
  it("styles only .nx-* classes", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...stripped.matchAll(/(?:^|[{}])\s*([^{}@][^{}]*)\{/g)].map((m) => m[1].trim()).filter((x) => x && !x.startsWith("@"));
    expect(selectors.length).toBeGreaterThan(30);
    for (const group of selectors) for (const sel of group.split(",").map((x) => x.trim())) expect(sel, sel).toMatch(/\.nx-/);
  });
});
