// @vitest-environment jsdom
/**
 * The Studio home's explore grid (components/studio/StudioExplore.tsx, lib/creative/explore.ts). What would break without these:
 * a card that names its model (in its words, its alt, its aria or a data attribute) although the owner wants the model known only
 * in the Studio; a card for a model this workspace cannot buy (an operator preview, a locked model, one not on sale for that tool,
 * a template whose availability is "unknown"), shown as if it were; an animation's starting frame shown as its own sample; an i2v
 * sample that opens the Studio without its picture; a card that leaves this channel or this origin, or carries a hostile prompt
 * into the form uncleaned; a templates read that fails, or finds nothing, and draws nothing at all; a dictionary missing a key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pulled out so they never reach the <a>
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children?: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { StudioExplore } from "@/components/studio/StudioExplore";
import { EXPLORE_SAMPLE_LIMIT, exploreSamples, exploreTemplates, onSaleCatalog, templateRow, type OnSale } from "@/lib/creative/explore";
import { SHOWCASE_ENTRIES, sourceOnlyJobs, type ShowcaseEntry } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { linksSample } from "@/lib/site/showcase-link";
import { cleanLinkPrompt } from "@/lib/creative/improve";
import { SAMPLE_PARAM } from "@/lib/site/sample-source";
import type { StudioModel } from "@/lib/creative/studio";
import type { TemplateDto } from "@/lib/templates/trends";

const ROOT = join(__dirname, "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, "..", "schemas", "model_registry.json"), "utf8")) as {
  models: { id: string; display_name: string; provider: string }[];
};
const NOW = new Date("2026-11-27T00:00:00Z");

/** The shipped samples as they will read once their models go on sale (today every one is an operator preview). */
const ON_SALE_ENTRIES: ShowcaseEntry[] = SHOWCASE_ENTRIES.map((e) => ({ ...e, operatorPreview: false, shutdownOn: null }));
/** Every shipped sample's model, on sale for every tool its samples use. */
const ALL_ON_SALE: OnSale = (() => {
  const out: Record<string, string[]> = {};
  for (const e of SHOWCASE_ENTRIES) (out[e.capability] ??= []).includes(e.modelId) || out[e.capability].push(e.modelId);
  for (const id of ["minimax-h3", "minimax-h3-max", "minimax-h3-lite", "minimax-h3-highspeed"]) (out.t2v ??= []).includes(id) || out.t2v.push(id);
  for (const id of ["ideogram-4", "ideogram-4.5"]) (out.t2i ??= []).includes(id) || out.t2i.push(id);
  return out;
})();

// Next hands the generated map hashed `/_next/static/media/…` paths; the test runner's bundler does not, so the same keys get the
// shape a build gives them (as tests/studio-sample-source.test.tsx does), or no starting picture would resolve here.
const BUILT_FILES = Object.fromEntries(
  Object.entries(SHOWCASE_FILES).map(([k, f]) => [k, { ...f, poster: `/_next/static/media/poster.${k.slice(0, 8)}.webp` }]),
);

const model = (id: string, capabilities: string[], extra: Partial<StudioModel> = {}): StudioModel => ({ id, displayName: id, capabilities, beta: false, ...extra });

const tpl = (slug: string, over: Partial<TemplateDto> = {}): TemplateDto => ({
  slug,
  kind: "video",
  title: `Title of ${slug}`,
  description: `Line of ${slug}`,
  category: "viral",
  prompt: "A {subject} on a stage",
  placeholders: ["subject"],
  model_id: "minimax-h3",
  model_available: true,
  model_status: "available",
  aspect: "9:16",
  duration_s: 5,
  quality: null,
  preview_url: `/templates/${slug}/preview.mp4`,
  poster_url: `/templates/${slug}/poster.webp`,
  ...over,
});

const TEMPLATES: TemplateDto[] = [
  tpl("treasure-strike"),
  tpl("faceless-story", { category: "story", model_id: "minimax-h3-lite" }),
  tpl("promo-poster-square", { category: "business", kind: "image", model_id: "ideogram-4.5", aspect: "1:1", duration_s: null, preview_url: undefined }),
  tpl("quote-poster", { category: "text", kind: "image", model_id: "ideogram-4.5", duration_s: null, preview_url: undefined }),
];

let templatesResponse: () => Promise<Response>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  void init;
  const url = String(input);
  if (url.startsWith("/api/templates")) return templatesResponse();
  throw new Error(`unexpected request ${url}`);
});

beforeEach(() => {
  templatesResponse = async () => new Response(JSON.stringify({ status: "ok", templates: TEMPLATES }), { status: 200 });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function draw(samples = exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, ALL_ON_SALE, "en", NOW), onSale: OnSale = ALL_ON_SALE, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <StudioExplore samples={samples} onSale={onSale} />
    </I18nProvider>,
  );
}

const cards = (root: ParentNode = document) => Array.from(root.querySelectorAll<HTMLElement>("[data-mf-card]"));
const linkOf = (card: Element) => card.querySelector<HTMLAnchorElement>("a.mf-card-link")!;

describe("no model name on a card", () => {
  it("no card's text, alt, aria or data attribute names a model, its id or its maker; only the link's model= carries it", async () => {
    draw();
    await waitFor(() => expect(document.querySelector('[data-explore="template"]')).not.toBeNull());
    const list = cards();
    expect(list.some((c) => c.dataset.explore === "sample")).toBe(true);
    // Names and makers as they are written, and ids: a 3-letter id fragment would match ordinary words, so ids are matched whole.
    const names = REGISTRY.models.flatMap((m) => [m.display_name, m.provider]).filter((n) => n.length > 3);
    const ids = REGISTRY.models.map((m) => m.id);
    for (const card of list) {
      const said: string[] = [card.textContent ?? ""];
      for (const el of [card, ...Array.from(card.querySelectorAll("*"))]) {
        for (const a of Array.from(el.attributes)) if (a.name !== "href" && a.name !== "src" && a.name !== "srcset") said.push(a.value);
      }
      const all = said.join(" \n ");
      for (const n of names) expect(all.toLowerCase(), n).not.toContain(n.toLowerCase());
      for (const id of ids) expect(all.split(/[\s"']+/), id).not.toContain(id);
    }
  });

  it("the sample a browser receives holds no model id, model name or maker at all (the page's payload carries every prop)", () => {
    const samples = exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, ALL_ON_SALE, "en", NOW);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(Object.keys(s).sort()).toEqual(["clip", "height", "href", "id", "kind", "line", "poster", "srcSet", "title", "width"]);
      const e = ON_SALE_ENTRIES.find((x) => x.jobId === s.id)!;
      const { href, ...drawn } = s;
      expect(JSON.stringify(drawn)).not.toContain(e.modelName);
      expect(JSON.stringify(drawn)).not.toContain(e.modelId);
      // The link is where the model goes, so the Studio can preselect it.
      expect(new URL(href, "https://x.test").searchParams.get("model")).toBe(e.modelId);
    }
  });
});

describe("only what is on sale to this workspace gets a card", () => {
  it("a sample whose model is not on sale here for its tool gets no card; one that is, does", () => {
    const one = ON_SALE_ENTRIES.find((e) => e.capability === "t2v")!;
    const onSale: OnSale = { t2v: [one.modelId] };
    const shown = exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, onSale, "en", NOW, Infinity);
    expect(shown.length).toBeGreaterThan(0);
    for (const s of shown) {
      const e = ON_SALE_ENTRIES.find((x) => x.jobId === s.id)!;
      expect(e.capability).toBe("t2v");
      expect(e.modelId).toBe(one.modelId);
    }
    // The same model on sale for pictures only is not on sale for a clip.
    expect(exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, { t2i: [one.modelId] }, "en", NOW).some((s) => s.id === one.jobId)).toBe(false);
    expect(exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, {}, "en", NOW)).toEqual([]);
  });

  it("an operator preview, a locked model, and a model of another tool are not on sale (the catalogue the page builds)", () => {
    const onSale = onSaleCatalog(
      [
        model("sold", ["t2v", "i2v"]),
        model("preview", ["t2v"], { preview: true }),
        model("locked", ["t2v"], { lock: "first_purchase" as StudioModel["lock"] }),
        model("pictures", ["t2i"]),
      ],
      ["t2v", "t2i", "i2v"],
    );
    expect(onSale).toEqual({ t2v: ["sold"], t2i: ["pictures"], i2v: ["sold"] });
  });

  it("a sample the shipped data marks as a preview gets no card even if a stale catalogue lists its model (its link would not name it)", () => {
    const e = { ...ON_SALE_ENTRIES.find((x) => x.capability === "t2v")!, operatorPreview: true };
    expect(exploreSamples([e], SHOWCASE_FILES, { t2v: [e.modelId] }, "en", NOW)).toEqual([]);
    const gone = { ...e, operatorPreview: false, shutdownOn: "2026-11-01" };
    expect(exploreSamples([gone], SHOWCASE_FILES, { t2v: [e.modelId] }, "en", NOW)).toEqual([]);
  });

  it("the shipped data as it is: no entry marked as an operator preview is ever drawn, whatever the catalogue says", () => {
    // Every shipped entry is an operator preview in the registry snapshot today, so this is empty now; it lights up per model.
    for (const s of exploreSamples(SHOWCASE_ENTRIES, SHOWCASE_FILES, ALL_ON_SALE, "en", NOW, Infinity)) {
      expect(SHOWCASE_ENTRIES.find((e) => e.jobId === s.id)!.operatorPreview).toBe(false);
    }
  });

  it("a template needs both the route's 'available' and this page's catalogue; unknown is not available; no poster, no card", () => {
    const rows = exploreTemplates(
      [
        tpl("ok-one"),
        tpl("route-says-no", { model_status: "unavailable", model_available: false }),
        tpl("route-unknown", { model_status: "unknown", model_available: false }),
        tpl("catalogue-says-no", { model_id: "not-sold-here" }),
        tpl("no-poster", { poster_url: undefined }),
      ],
      ALL_ON_SALE,
    );
    expect(rows.trending.map((t) => t.slug)).toEqual(["ok-one"]);
  });

  it("a template model not on sale draws no card in the browser either", async () => {
    draw([], { t2v: [], t2i: ["ideogram-4.5"] });
    await waitFor(() => expect(document.querySelector('[data-explore="template"]')).not.toBeNull());
    const hrefs = cards().map((c) => linkOf(c).getAttribute("href"));
    expect(hrefs).toEqual(["/my-channel/create?template=promo-poster-square"]);
  });

  it("the rows: viral is trending, other videos are by topic, business pictures are the brand-style row, text pictures have none", () => {
    expect(templateRow({ category: "viral", kind: "image" })).toBe("trending");
    expect(templateRow({ category: "story", kind: "video" })).toBe("topics");
    expect(templateRow({ category: "business", kind: "video" })).toBe("topics");
    expect(templateRow({ category: "business", kind: "image" })).toBe("brand");
    expect(templateRow({ category: "text", kind: "image" })).toBeNull();
  });
});

describe("what a sample card is", () => {
  it("an animation's starting frame is never its own card", () => {
    const frames = sourceOnlyJobs(ON_SALE_ENTRIES);
    expect(frames.size).toBeGreaterThan(0);
    const shown = exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, ALL_ON_SALE, "en", NOW, Infinity).map((s) => s.id);
    for (const f of frames) expect(shown).not.toContain(f);
    expect(shown.length).toBe(ON_SALE_ENTRIES.filter((e) => !frames.has(e.jobId)).length);
  });

  it("at most EXPLORE_SAMPLE_LIMIT samples, newest first", () => {
    const shown = exploreSamples(ON_SALE_ENTRIES, SHOWCASE_FILES, ALL_ON_SALE, "en", NOW);
    expect(shown.length).toBeLessThanOrEqual(EXPLORE_SAMPLE_LIMIT);
    const order = ON_SALE_ENTRIES.map((e) => e.jobId);
    const idx = shown.map((s) => order.indexOf(s.id));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("an i2v sample's link carries sample=<its job>, so the Studio proposes its own starting picture", () => {
    const i2v = ON_SALE_ENTRIES.filter((e) => e.capability === "i2v" && linksSample(e, { entries: ON_SALE_ENTRIES, files: BUILT_FILES }));
    expect(i2v.length).toBeGreaterThan(0);
    const shown = exploreSamples(ON_SALE_ENTRIES, BUILT_FILES, ALL_ON_SALE, "en", NOW, Infinity);
    for (const e of i2v) {
      const s = shown.find((x) => x.id === e.jobId)!;
      expect(s, e.jobId).toBeTruthy();
      const q = new URL(s.href, "https://x.test").searchParams;
      expect(q.get(SAMPLE_PARAM)).toBe(e.jobId);
      expect(q.get("tool")).toBe("i2v");
    }
    // A clip from words alone names no sample.
    for (const s of shown.filter((x) => ON_SALE_ENTRIES.find((e) => e.jobId === x.id)!.capability === "t2v")) {
      expect(new URL(s.href, "https://x.test").searchParams.has(SAMPLE_PARAM)).toBe(false);
    }
  });

  it("every card stays on this channel's Studio, on this origin; a hostile prompt reaches the form only through cleanLinkPrompt", async () => {
    const base = ON_SALE_ENTRIES.find((e) => e.capability === "t2v" && !sourceOnlyJobs(ON_SALE_ENTRIES).has(e.jobId))!;
    const hostile = "Lighthouse at dusk‮\u0000 //evil.test/x javascript:alert(1) ​<img src=x onerror=alert(1)>";
    const entry = { ...base, prompt: hostile, cardLine: null };
    const samples = exploreSamples([entry], SHOWCASE_FILES, ALL_ON_SALE, "en", NOW);
    expect(samples).toHaveLength(1);
    draw(samples);
    await waitFor(() => expect(document.querySelector('[data-explore="template"]')).not.toBeNull());
    for (const card of cards()) {
      const href = linkOf(card).getAttribute("href")!;
      expect(href.startsWith("/my-channel/create?"), href).toBe(true);
      expect(new URL(href, "https://studio.test").origin).toBe("https://studio.test");
    }
    const href = linkOf(cards().find((c) => c.dataset.explore === "sample")!).getAttribute("href")!;
    const words = new URL(href, "https://x.test").searchParams.get("prompt")!;
    expect(words).toBe(cleanLinkPrompt("t2v", hostile));
    expect(words).not.toMatch(/[\u0000-\u001f‪-‮​]/);
    // The caption shows words as text, never as markup.
    expect(document.querySelector("[data-explore] img[src='x']")).toBeNull();
  });

  it("a card's caption is hidden from a screen reader (the link says it once), and the AI mark describes the link", async () => {
    draw();
    await waitFor(() => expect(document.querySelector('[data-explore="template"]')).not.toBeNull());
    for (const card of cards()) {
      expect(card.querySelector(".mf-cap")!.getAttribute("aria-hidden")).toBe("true");
      const link = linkOf(card);
      const [ai, note] = link.getAttribute("aria-describedby")!.split(" ");
      expect(document.getElementById(ai)!.textContent).toContain(dictionaries.en.site.gallery.badgeName);
      expect(document.getElementById(note)!.textContent).toBe(dictionaries.en.studioHome.explore.note);
    }
  });
});

describe("the templates read", () => {
  const x = dictionaries.en.studioHome.explore;

  it("loading, then an error with a retry that only reads again, then the rows", async () => {
    let fail = true;
    templatesResponse = async () => (fail ? new Response("{}", { status: 502 }) : new Response(JSON.stringify({ status: "ok", templates: TEMPLATES }), { status: 200 }));
    draw([]);
    const loading = screen.getByTestId("explore-loading");
    expect(within(loading).getByRole("status").textContent).toBe(x.loading);
    const error = await screen.findByTestId("explore-error");
    expect(within(error).getByRole("alert").textContent).toContain(x.error);
    fail = false;
    fireEvent.click(within(error).getByTestId("explore-retry"));
    await screen.findByRole("heading", { name: x.trending });
    expect(screen.getByRole("heading", { name: x.topics })).toBeTruthy();
    expect(screen.getByRole("heading", { name: x.brand })).toBeTruthy();
    // Every request was a read of the templates, nothing else (no write on load, no write on retry).
    expect(fetchMock.mock.calls.length).toBe(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url).startsWith("/api/templates?")).toBe(true);
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("nothing on sale here (no sample, no format): one honest line that examples come as models go live, and the way to the box above", async () => {
    // Today's case: every shipped sample and every template is an operator preview's, and the strict rule counts none of them.
    const samples = exploreSamples(SHOWCASE_ENTRIES.map((e) => ({ ...e, operatorPreview: true })), SHOWCASE_FILES, ALL_ON_SALE, "en", NOW);
    expect(samples).toEqual([]);
    draw(samples, { t2v: [], t2i: [] });
    const empty = await screen.findByTestId("explore-empty");
    expect(within(empty).getByRole("heading", { name: x.soonTitle })).toBeTruthy();
    expect(empty.textContent).toContain(x.soon);
    // A way on, not a dead end: the composer at the top of the page (id="prompt" on both screens).
    expect(within(empty).getByRole("link", { name: x.soonAction }).getAttribute("href")).toBe("#prompt");
    // No placeholder card, no skeleton left behind, and no "nothing starts until Create" note under no cards.
    expect(cards()).toHaveLength(0);
    expect(document.querySelector(".sx-skel")).toBeNull();
    expect(screen.queryByText(x.note)).toBeNull();
    expect(screen.getAllByTestId("explore-empty")).toHaveLength(1);
  });

  it("an empty template list and no samples is the same one line", async () => {
    templatesResponse = async () => new Response(JSON.stringify({ status: "ok", templates: [] }), { status: 200 });
    draw([]);
    expect((await screen.findByTestId("explore-empty")).textContent).toContain(x.soon);
  });

  it("samples on sale but no format: the samples show and no format row or empty line is drawn", async () => {
    draw(undefined, { t2v: [], t2i: [] });
    await waitFor(() => expect(screen.queryByTestId("explore-loading")).toBeNull());
    expect(screen.getByRole("heading", { name: x.samples })).toBeTruthy();
    expect(screen.queryByTestId("explore-empty")).toBeNull();
    expect(screen.queryByRole("heading", { name: x.trending })).toBeNull();
    expect(cards().every((c) => c.dataset.explore === "sample")).toBe(true);
  });

  it("not switched on, and a session that ended, each say so with a way on", async () => {
    templatesResponse = async () => new Response(JSON.stringify({ error: "not_enabled" }), { status: 503 });
    draw([]);
    expect((await screen.findByTestId("explore-not_enabled")).textContent).toContain(x.notEnabled);
    cleanup();
    templatesResponse = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    draw([]);
    const out = await screen.findByTestId("explore-signed_out");
    expect(out.textContent).toContain(x.signedOut);
    expect(within(out).getByRole("link", { name: x.signIn })).toBeTruthy();
  });

  it("a row with nothing to show is not drawn (the text pictures have no row; no heading over nothing)", async () => {
    templatesResponse = async () => new Response(JSON.stringify({ status: "ok", templates: [TEMPLATES[0], TEMPLATES[3]] }), { status: 200 });
    draw([]);
    await screen.findByRole("heading", { name: x.trending });
    expect(screen.queryByRole("heading", { name: x.topics })).toBeNull();
    expect(screen.queryByRole("heading", { name: x.brand })).toBeNull();
    expect(cards()).toHaveLength(1);
  });
});

describe("the dictionaries", () => {
  it("every explore key exists, non-empty, in en, ru and uz, and none names a model", () => {
    const keys = (o: Record<string, unknown>, at = ""): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v as Record<string, unknown>, `${at}${k}.`) : [`${at}${k}`]));
    const en = dictionaries.en.studioHome.explore;
    const want = keys(en).sort();
    expect(want.length).toBeGreaterThan(10);
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc].studioHome.explore as Record<string, string>;
      expect(keys(d).sort(), loc).toEqual(want);
      for (const k of want) {
        expect(typeof d[k], `${loc}.${k}`).toBe("string");
        expect(d[k].trim().length, `${loc}.${k}`).toBeGreaterThan(0);
        for (const m of REGISTRY.models) expect(d[k].toLowerCase()).not.toContain(m.display_name.toLowerCase());
      }
    }
  });

  it("the grid draws in Russian and Uzbek with their own headings", async () => {
    for (const loc of ["ru", "uz"] as const) {
      draw(undefined, ALL_ON_SALE, loc);
      await screen.findByRole("heading", { name: dictionaries[loc].studioHome.explore.trending });
      cleanup();
    }
  });
});
