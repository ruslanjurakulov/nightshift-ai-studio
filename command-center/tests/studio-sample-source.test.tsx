// @vitest-environment jsdom
/**
 * A public animation sample's "Try this prompt" (lib/site/showcase-link.ts -> lib/site/sample-source.ts -> GenerateSection). What
 * would break without these: an i2v sample opening the Studio with no picture and no words; `sample=` turning into an open loader
 * that fetches whatever the address names; a link that names a sample the Studio would refuse; anything written for a visitor who
 * never presses "Use this picture" (Atlas decision 22 Nov: a copy per visitor fills the media volume and every quota); a refused or
 * failed copy leaving a form that looks as if it had a picture (CLAUDE.md #5); the press quoting, holding or creating a job
 * (CLAUDE.md #3); a second press, a reload or a second tab making a second copy; a starting frame shown as a sample of its own.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    return <div data-testid="panel" />;
  },
}));
const feed = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/studio/JobFeed", () => ({
  JobFeed: (p: Record<string, unknown>) => {
    feed.props = p;
    return <div data-testid="feed" />;
  },
}));
vi.mock("@/components/studio/TemplateGallery", () => ({ TemplateGallery: () => null }));
vi.mock("@/components/studio/Availability", () => ({ DeskAvailabilityNote: () => null, NothingOnSaleNote: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { fmt } from "@/lib/i18n/core";
import { GenerateSection } from "@/components/studio/GenerateSection";
import { SHOWCASE_ENTRIES, modelLeftOut, sourceOnlyJobs } from "@/lib/site/showcase";
import { showcaseItems, showcaseItemsWithSources } from "@/components/site/ShowcaseGallery";
import { landingExcludedJobs, slotMedia } from "@/components/site/slots";
import { landingGalleryJobs } from "@/components/site/landing-samples";
import { beforeAfterPairs } from "@/lib/site/carousel";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { linksSample, signupTryHref, studioTryHref, tryHref } from "@/lib/site/showcase-link";
import { SAMPLE_PARAM, isShippedPicture, resolveSampleSource, sampleSourcePicture, type SampleSource } from "@/lib/site/sample-source";
import { SAMPLE_ASSET_KEY, SAMPLE_TICKET_KEY, copySample, copySampleOnce, type SamplePicture } from "@/lib/creative/sample-preload";
import { cleanLinkPrompt, prefillFromImprove } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { prefillModel } from "@/lib/models-discovery";
import { DEFAULT_AFTER_AUTH, afterSignupPath, safeLoginReturn, studioNext } from "@/lib/safe-redirect";
import type { StudioModel } from "@/lib/creative/studio";

const ORIGIN = "https://app.example";
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TICKET = "33333333-3333-4333-8333-333333333333";

const I2V = SHOWCASE_ENTRIES.filter((e) => e.capability === "i2v");
const T2V = SHOWCASE_ENTRIES.find((e) => e.capability === "t2v")!;
const T2I = SHOWCASE_ENTRIES.find((e) => e.capability === "t2i")!;
// Next hands the generated map hashed `/_next/static/media/…` paths; the test runner's bundler hands over none, so the same keys
// are given the shape a build gives them.
const FILES = Object.fromEntries(Object.keys(SHOWCASE_FILES).map((k) => [k, { poster: `/_next/static/media/poster.${k.slice(0, 8)}.webp` }]));
const shipsSource = (e: (typeof I2V)[number]) =>
  e.input.kind === "operator_job" && SHOWCASE_ENTRIES.some((s) => s.jobId === (e.input as { jobId: string }).jobId && s.kind === "image");
const RESOLVABLE = I2V.filter(shipsSource);
/** The data the link builder resolves against, as a build gives it (see FILES). */
const DATA = { entries: SHOWCASE_ENTRIES, files: FILES };
const NOW = new Date();

/** Sign-up -> the e-mailed callback -> /welcome -> its last button, as each step reads `next` (tests/security-studio-link-handoff). */
function followSignup(href: string): URL {
  const rawNext = new URL(href, ORIGIN).searchParams.get("next");
  const after = afterSignupPath(rawNext);
  expect(after).not.toBe(DEFAULT_AFTER_AUTH);
  const cb = safeLoginReturn(new URL(`${ORIGIN}/auth/callback?next=${encodeURIComponent(after)}`).searchParams.get("next"), DEFAULT_AFTER_AUTH);
  return new URL(studioNext(new URL(cb, ORIGIN).searchParams.get("next")) ?? "/all-channels", ORIGIN);
}

/** The create page's own reading of the address (app/(app)/[channel]/create/page.tsx), for the parts this link uses. */
function pageReads(u: URL, models: StudioModel[] = []) {
  const q = Object.fromEntries(u.searchParams.entries());
  const form = prefillFromImprove(prefillModel(prefillFromQuery(q.tool, q.source), q.model), q);
  return { form, sample: resolveSampleSource(q[SAMPLE_PARAM], form, SHOWCASE_ENTRIES, FILES), models };
}

describe("an i2v sample's link carries its words, its sample and its model", () => {
  it("the shipped data has the six animations this is for", () => {
    expect(I2V.length).toBe(6);
  });

  it.each(I2V.map((e) => [e.jobId, e]))("signed in (%s): tool, model, sample and the words round-trip to the form", (_id, e) => {
    const u = new URL(studioTryHref(e, NOW, DATA)!, ORIGIN);
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(shipsSource(e) ? e.jobId : null);
    expect(u.searchParams.get("model")).toBe(modelLeftOut(e) ? null : e.modelId);
    const words = cleanLinkPrompt("i2v", e.prompt);
    expect(words.length).toBeGreaterThan(0);
    expect(u.searchParams.get("prompt")).toBe(words);
    const { form } = pageReads(u);
    expect(form?.capability).toBe("i2v");
    expect(form?.prompt).toBe(words);
    expect(form?.sourceId ?? null).toBeNull();
  });

  it.each(I2V.map((e) => [e.jobId, e]))("signed out (%s): through /signup?next=, the callback and /welcome, sample and words intact", (_id, e) => {
    const href = signupTryHref(e, NOW, DATA)!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    const u = followSignup(href);
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(shipsSource(e) ? e.jobId : null);
    const kept = u.searchParams.get("prompt") ?? "";
    expect(kept.length).toBeGreaterThan(0);
    expect(cleanLinkPrompt("i2v", e.prompt).startsWith(kept)).toBe(true);
    expect(pageReads(u).form?.prompt).toBe(kept);
  });

  it("long words are still cut to fit sign-up with the sample in the link", () => {
    const e = { ...RESOLVABLE[0], prompt: "фонарь над тёмным озером ".repeat(60) };
    const u = followSignup(signupTryHref(e, NOW, DATA)!);
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(e.jobId);
    expect((u.searchParams.get("prompt") ?? "").length).toBeGreaterThan(0);
  });

  it("an operator preview still leaves the model out, and keeps the sample and the words", () => {
    const u = new URL(studioTryHref({ ...RESOLVABLE[0], operatorPreview: true }, NOW, DATA)!, ORIGIN);
    expect(u.searchParams.has("model")).toBe(false);
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(RESOLVABLE[0].jobId);
  });

  // Data-driven, so an export that ships a missing starting frame (#942, #943) flips its animation without editing this test: an
  // animation carries `sample=` exactly when its starting picture ships. The four that shipped first must keep theirs.
  it("an animation whose starting picture does not ship gets no reference; one whose picture ships gets its own", () => {
    for (const id of ["e35f41fb", "fc1fad12", "ab7cc0e2", "dcb96246"]) expect(RESOLVABLE.some((e) => e.jobId.startsWith(id)), id).toBe(true);
    expect(RESOLVABLE.length + I2V.filter((e) => !shipsSource(e)).length).toBe(I2V.length);
    for (const e of RESOLVABLE) {
      for (const href of [tryHref(e, true, NOW, DATA)!, tryHref(e, false, NOW, DATA)!]) {
        const u = href.startsWith("/signup") ? followSignup(href) : new URL(href, ORIGIN);
        expect(u.searchParams.get(SAMPLE_PARAM), e.jobId).toBe(e.jobId);
      }
    }
    const unshipped = I2V.filter((e) => !shipsSource(e)).map((e) => e.jobId).sort();
    for (const id of unshipped) {
      const e = I2V.find((x) => x.jobId === id)!;
      for (const href of [tryHref(e, true, NOW, DATA)!, tryHref(e, false, NOW, DATA)!]) {
        const u = href.startsWith("/signup") ? followSignup(href) : new URL(href, ORIGIN);
        expect(u.searchParams.has(SAMPLE_PARAM), id).toBe(false);
        // The words and the tool still go: the i2v form asks for a picture itself.
        expect(u.searchParams.get("tool")).toBe("i2v");
        expect((u.searchParams.get("prompt") ?? "").length).toBeGreaterThan(0);
        // ...and the Studio, reading that link, says nothing about a sample.
        expect(pageReads(u).sample).toBeNull();
      }
    }
  });

  it("the builder and the Studio's resolver agree for every entry, signed in and out", () => {
    for (const e of SHOWCASE_ENTRIES) {
      for (const signedIn of [true, false]) {
        const href = tryHref(e, signedIn, NOW, DATA);
        if (!href) continue;
        const u = signedIn ? new URL(href, ORIGIN) : followSignup(href);
        const named = u.searchParams.get(SAMPLE_PARAM);
        const read = pageReads(u).sample;
        expect(named !== null, e.jobId).toBe(linksSample(e, DATA));
        // A link that names a sample is always resolved to a picture; one that names none is never refused.
        expect(read?.state ?? null, e.jobId).toBe(named === null ? null : "ready");
      }
    }
  });

  it("without the files a build gives, no link claims a picture (the builder never names a sample the Studio would refuse)", () => {
    for (const e of I2V) expect(new URL(studioTryHref(e, NOW, { entries: SHOWCASE_ENTRIES, files: {} })!, ORIGIN).searchParams.has(SAMPLE_PARAM)).toBe(false);
  });

  it("a text sample carries no sample reference", () => {
    expect(new URL(studioTryHref(T2V, NOW, DATA)!, ORIGIN).searchParams.has(SAMPLE_PARAM)).toBe(false);
    expect(new URL(studioTryHref(T2I, NOW, DATA)!, ORIGIN).searchParams.has(SAMPLE_PARAM)).toBe(false);
  });
});

describe("the Studio resolves `sample=` against the shipped data only", () => {
  it("a sample whose starting picture is a shipped sample picture resolves to that picture's own poster", () => {
    expect(RESOLVABLE.length).toBeGreaterThan(0);
    for (const e of RESOLVABLE) {
      const sourceJob = (e.input as { jobId: string }).jobId;
      const r = resolveSampleSource(e.jobId, { capability: "i2v", sourceId: null }, SHOWCASE_ENTRIES, FILES);
      const pic = SHOWCASE_ENTRIES.find((x) => x.jobId === sourceJob)!;
      expect(r, e.jobId).toEqual({
        state: "ready", sampleId: e.jobId, src: FILES[sourceJob].poster, name: `sample-${sourceJob.slice(0, 8)}.webp`,
        sourceJobId: sourceJob, width: pic.width, height: pic.height,
      });
      // Its own source, never the animation's poster.
      expect((r as { src: string }).src).not.toBe(FILES[e.jobId].poster);
    }
  });

  it("an animation whose starting picture does not ship is refused, not pointed at another picture", () => {
    for (const e of I2V.filter((x) => !shipsSource(x)))
      expect(resolveSampleSource(e.jobId, { capability: "i2v" }, SHOWCASE_ENTRIES, FILES), e.jobId).toEqual({ state: "refused" });
  });

  it.each([
    ["unknown id", "99999999-9999-4999-8999-999999999999"],
    ["malformed", "abc"],
    ["empty", ""],
    ["upper-case id", RESOLVABLE[0].jobId.toUpperCase()],
    ["path traversal", "../../etc/passwd"],
    ["traversal after an id", `${RESOLVABLE[0].jobId}/../x`],
    ["a URL", "https://evil.example/x.webp"],
    ["protocol-relative", "//evil.example/x.webp"],
    ["javascript:", "javascript:alert(1)"],
    ["a t2v sample", T2V.jobId],
    ["a picture sample", T2I.jobId],
    ["an array", [RESOLVABLE[0].jobId, RESOLVABLE[0].jobId]],
    ["an inherited name", "__proto__"],
    ["a number", 42],
  ])("refused: %s", (_label, raw) => {
    expect(resolveSampleSource(raw, { capability: "i2v", sourceId: null }, SHOWCASE_ENTRIES, FILES)).toEqual({ state: "refused" });
  });

  it("nothing to do without `sample`, on another tool, or when the person's link already chose a source", () => {
    const id = RESOLVABLE[0].jobId;
    expect(resolveSampleSource(undefined, { capability: "i2v" }, SHOWCASE_ENTRIES, FILES)).toBeNull();
    expect(resolveSampleSource(id, { capability: "t2v" }, SHOWCASE_ENTRIES, FILES)).toBeNull();
    expect(resolveSampleSource(id, null, SHOWCASE_ENTRIES, FILES)).toBeNull();
    expect(resolveSampleSource(id, { capability: "i2v", sourceId: ASSET }, SHOWCASE_ENTRIES, FILES)).toBeNull();
  });

  it("a generated files map that names anything but a same-origin WebP path is refused too", () => {
    const e = RESOLVABLE[0];
    const sourceJob = (e.input as { jobId: string }).jobId;
    for (const poster of ["//evil.example/x.webp", "/\\evil.example/x.webp", "https://evil.example/x.webp", "/a/../b.webp", "/x.png", "javascript:x.webp", undefined, 3])
      expect(sampleSourcePicture(e.jobId, SHOWCASE_ENTRIES, { ...FILES, [sourceJob]: { poster } }), String(poster)).toBeNull();
    expect(isShippedPicture("/_next/static/media/poster.0a1b2c3d.webp")).toBe(true);
  });
});

// ── the browser's half ──────────────────────────────────────────────────────

const en = dictionaries.en;
const wrap = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const last = () => panel.props[panel.props.length - 1];
const I2V_FORM = { capability: "i2v" as const, model: "", prompt: "drift", aspect: "16:9", duration: 5, sourceId: null };
const SOURCE_JOB = "e3da9148-f2f8-443e-95b1-8ed36ef3dea4";
const READY: Extract<SampleSource, { state: "ready" }> = {
  state: "ready",
  sampleId: "fc1fad12-16de-4cd5-9cd9-e77ed245f469",
  src: "/_next/static/media/poster.abc.webp",
  name: "sample-e3da9148.webp",
  sourceJobId: SOURCE_JOB,
  width: 1280,
  height: 720,
};

let fetchMock: ReturnType<typeof vi.fn>;
let quota = false;
/** The ticket's answer: the worker has it, it is still checking, or the library will not show it to this account. */
let ticketAnswer: "ingested" | "pending" | "forbidden" = "ingested";
/** The workspace's library as the name search answers it: what an earlier copy (another tab, another day) left there. */
let library: Array<Record<string, unknown>> = [];
/** Uploads of this person still being sent or checked, as `?mine=1` answers them. */
let pendingUploads: Array<Record<string, unknown>> = [];
const THUMB = `/api/media/file/${ASSET}/thumb?t=image%2Fwebp&exp=9&sig=abc_-1`;
const writes = () =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET").map(([url, init]) => `${(init as RequestInit).method} ${url}`);
const gets = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET").map(([url]) => String(url));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  panel.props = [];
  quota = false;
  ticketAnswer = "ingested";
  feed.props = null;
  library = [];
  pendingUploads = [];
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", `/all-channels/create?tool=i2v&model=m&${SAMPLE_PARAM}=${READY.sampleId}&prompt=drift`);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === READY.src) return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" }) };
    if (url.startsWith("/api/media?") && method === "GET") return json({ assets: library, uploads: pendingUploads });
    if (url === "/api/media/uploads" && method === "POST")
      return quota ? json({ error: "quota_exceeded" }, 409) : json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: READY.name });
    if (url === `/api/media/uploads/${TICKET}` && method === "PUT") {
      // What the worker registers: the copy, by its name and the size it measured.
      library = [{ id: ASSET, kind: "image", name: READY.name, width: READY.width, height: READY.height, createdBy: ME }];
      return json({ ok: true });
    }
    if (url === `/api/media/uploads/${TICKET}`) {
      if (ticketAnswer === "forbidden") return json({ error: "forbidden" }, 403);
      if (ticketAnswer === "pending") return json({ status: "ingesting" });
      return json({ status: "ingested", asset_id: ASSET });
    }
    if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: "image" }, urls: { thumb: THUMB } });
    return json({ jobs: [], templates: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sourceAsked = () => (last()?.sourceRequest as { id: string } | null | undefined)?.id ?? null;
const section = (sample: SampleSource | null, locale: "en" | "ru" | "uz" = "en") =>
  wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={sample} userId={ME} />, locale);
const posts = () => writes().filter((w) => w.startsWith("POST"));

describe("GenerateSection with a sample's picture", () => {
  it("refused: no picture is shown or loaded, the form has no source, the note says so, and nothing is fetched for it", async () => {
    render(section({ state: "refused" }));
    expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.refused);
    expect(screen.queryByTestId("sample-proposed")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(sourceAsked()).toBeNull();
    expect((last().initial as { sourceId: string | null }).sourceId).toBeNull();
    expect(writes()).toEqual([]);
    expect(gets().filter((u) => u.includes("/media"))).toEqual([]);
  });

  it("on load: the shipped poster is shown as a labelled, proposed source, and nothing is written or even read for it", async () => {
    render(section(READY));
    const card = screen.getByTestId("sample-proposed");
    expect(card.textContent).toContain(en.gen.sampleSource.label);
    expect(card.textContent).toContain(en.gen.sampleSource.useNote);
    expect(card.querySelector("img")?.getAttribute("src")).toBe(READY.src);
    expect(screen.getByTestId("sample-use").textContent).toBe(en.gen.sampleSource.use);
    await new Promise((r) => setTimeout(r, 300));
    expect(writes()).toEqual([]);
    expect(gets().filter((u) => u.includes("/media") || u === READY.src)).toEqual([]);
    expect(sourceAsked()).toBeNull();
    // The address still names the sample: nothing has happened yet.
    expect(new URL(window.location.href).searchParams.get(SAMPLE_PARAM)).toBe(READY.sampleId);
  });

  it(
    "the press copies it once through the ordinary upload, makes it the source and swaps the address; no creative call",
    async () => {
      render(section(READY));
      fireEvent.click(screen.getByTestId("sample-use"));
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.readyCopied);
      expect(screen.queryByTestId("sample-proposed")).toBeNull();
      // The ADOPTED file's own thumbnail from the library, not the site's poster.
      expect(screen.getByTestId("sample-used-thumb").getAttribute("src")).toBe(THUMB);
      expect((last().initial as { prompt: string; capability: string }).prompt).toBe("drift");
      expect((last().initial as { capability: string }).capability).toBe("i2v");
      expect(writes()).toEqual(["POST /api/media/uploads", `PUT /api/media/uploads/${TICKET}`]);
      // It looked for an earlier copy first, by name, in this workspace.
      expect(gets()).toContain(`/api/media?org=${ORG}&q=${encodeURIComponent(READY.name)}&mine=1`);
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/creative"))).toBe(false);
      expect(new URL(window.location.href).searchParams.get("source")).toBe(ASSET);
      expect(new URL(window.location.href).searchParams.has(SAMPLE_PARAM)).toBe(false);
      expect(sessionStorage.getItem(`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`)).toBe(ASSET);
    },
    8000,
  );

  it(
    "a double press makes one copy; a later visit in this tab, or another tab (found by name), makes none",
    async () => {
      const { unmount } = render(section(READY));
      const key = screen.getByTestId("sample-use");
      fireEvent.click(key);
      fireEvent.click(key);
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(posts()).toHaveLength(1);
      unmount();

      // The same tab, the old address again (Back): the tab remembers the copy and only reads it.
      panel.props = [];
      const again = render(section(READY));
      fireEvent.click(screen.getByTestId("sample-use"));
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(posts()).toHaveLength(1);
      again.unmount();

      // Another tab (no memory of it): the library's name search finds the copy, so nothing is sent again.
      sessionStorage.clear();
      panel.props = [];
      render(section(READY));
      fireEvent.click(screen.getByTestId("sample-use"));
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(posts()).toHaveLength(1);
    },
    12000,
  );

  it("a file of the same name but another size is not taken for the copy", async () => {
    library = [{ id: "44444444-4444-4444-8444-444444444444", kind: "image", name: READY.name, width: 640, height: 360 }];
    render(section(READY));
    fireEvent.click(screen.getByTestId("sample-use"));
    await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
    expect(posts()).toHaveLength(1);
  }, 8000);

  it("over quota: the library's own words with the remedy, no source, nothing half-uploaded used, and the key stays", async () => {
    quota = true;
    render(section(READY));
    fireEvent.click(screen.getByTestId("sample-use"));
    await waitFor(() =>
      expect(screen.getByTestId("sample-source").textContent).toBe(fmt(en.gen.sampleSource.failedWhy, { reason: en.media.errors.quota_exceeded })),
    );
    expect(sourceAsked()).toBeNull();
    expect(writes()).toEqual(["POST /api/media/uploads"]);
    expect(sessionStorage.length).toBe(0);
    expect(new URL(window.location.href).searchParams.has("source")).toBe(false);
    const key = screen.getByTestId("sample-use") as HTMLButtonElement;
    expect(key.disabled).toBe(false);
    // Space freed: the same key works.
    quota = false;
    fireEvent.click(key);
    await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
  }, 8000);

  it("the site's copy not coming back is said, with no source and no upload", async () => {
    render(section({ ...READY, src: "/_next/static/media/gone.webp" }));
    fireEvent.click(screen.getByTestId("sample-use"));
    // The default answer for an unknown path is a JSON body, not a picture: refused as a picture.
    await waitFor(() => expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.unavailable));
    expect(sourceAsked()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("the key and its note are in uz and ru too", () => {
    for (const loc of ["uz", "ru"] as const) {
      render(section(READY, loc));
      expect(screen.getByTestId("sample-use").textContent).toBe(dictionaries[loc].gen.sampleSource.use);
      expect(screen.getByTestId("sample-proposed").textContent).toContain(dictionaries[loc].gen.sampleSource.useNote);
      cleanup();
      render(section({ state: "refused" }, loc));
      expect(screen.getByTestId("sample-source").textContent).toBe(dictionaries[loc].gen.sampleSource.refused);
      cleanup();
    }
  });
});

describe("the sample picture's words, in en, ru and uz", () => {
  const KEYS = Object.keys(en.gen.sampleSource) as (keyof typeof en.gen.sampleSource)[];
  it("every line exists, is its own language, and keeps its placeholders", () => {
    for (const loc of ["ru", "uz"] as const) {
      const d = dictionaries[loc].gen.sampleSource;
      for (const k of KEYS) {
        expect(d[k], `${loc}.${k}`).toBeTruthy();
        expect(d[k], `${loc}.${k}`).not.toBe(en.gen.sampleSource[k]);
        expect(d[k].match(/\{\w+\}/g) ?? [], `${loc}.${k}`).toEqual(en.gen.sampleSource[k].match(/\{\w+\}/g) ?? []);
      }
    }
  });

  it("Uzbek writes oʻ and gʻ with U+02BB, never an ASCII or curly quote", () => {
    for (const k of KEYS) {
      const s = dictionaries.uz.gen.sampleSource[k];
      expect(s, k).not.toMatch(/[oOgG]['‘’`]/);
    }
    expect(Object.values(dictionaries.uz.gen.sampleSource).join(" ")).toContain("ʻ");
  });
});

describe("a starting frame is not its own sample (Atlas/owner decision 22 Nov)", () => {
  // The frames that shipped with #941, plus any starting frame exported since (#942, #943): every picture entry an i2v entry
  // was animated from. Derived here independently of sourceOnlyJobs, so an export never has to edit this list.
  const FIRST_FRAMES = ["e3da9148-f2f8-443e-95b1-8ed36ef3dea4", "f17146fd-054c-4970-9dac-f7a0dc929bd6", "1504b313-3a3c-4e78-bfda-5bca3ef7f3da"];
  const FRAMES = SHOWCASE_ENTRIES.filter(
    (p) => p.kind === "image" && SHOWCASE_ENTRIES.some((c) => c.capability === "i2v" && c.input.kind === "operator_job" && c.input.jobId === p.jobId),
  ).map((p) => p.jobId);

  it("derived from the data: every picture an i2v sample was animated from, and nothing else", () => {
    for (const j of FIRST_FRAMES) expect(FRAMES, j).toContain(j);
    expect([...sourceOnlyJobs(SHOWCASE_ENTRIES)].sort()).toEqual([...FRAMES].sort());
    // A future export's source is hidden without anyone listing it.
    const pic = { ...T2I, jobId: "77777777-7777-4777-8777-777777777777" };
    const clip = { ...I2V[0], jobId: "88888888-8888-4888-8888-888888888888", input: { kind: "operator_job" as const, jobId: pic.jobId, assetId: pic.assetId } };
    expect(sourceOnlyJobs([...SHOWCASE_ENTRIES, pic, clip]).has(pic.jobId)).toBe(true);
    // A text clip's (none) input or a picture nobody animated stays a sample.
    expect(sourceOnlyJobs(SHOWCASE_ENTRIES).has(T2I.jobId)).toBe(FRAMES.includes(T2I.jobId));
  });

  it("absent from every grid, still found for its clip, still in its slot, still beside its clip in picture → video", () => {
    const grid = showcaseItems().map(({ e }) => e.jobId);
    for (const j of FRAMES) expect(grid, j).not.toContain(j);
    expect(landingGalleryJobs(landingExcludedJobs()).some((j) => FRAMES.includes(j))).toBe(false);
    const all = showcaseItemsWithSources().map(({ e }) => e.jobId);
    for (const j of FRAMES) expect(all, j).toContain(j);
    const slot = slotMedia("solutions.developers");
    expect(slot.kind === "ai" ? slot.entry.jobId : null).toBe("1504b313-3a3c-4e78-bfda-5bca3ef7f3da");
    const pairs = beforeAfterPairs(showcaseItemsWithSources()).map((p) => p.picture.e.jobId);
    expect(pairs).toContain("e3da9148-f2f8-443e-95b1-8ed36ef3dea4");
  });
});

describe("Lens and Breach on the press (S8 review)", () => {
  const PIC: SamplePicture = { sampleId: READY.sampleId, src: READY.src, name: READY.name, sourceJobId: SOURCE_JOB, width: READY.width, height: READY.height };
  const memStore = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };
  const fast = { sleep: async () => {} };

  it("two presses at once (two sections, a double tap) make one copy and get the same file", async () => {
    const store = memStore();
    const [a, b] = await Promise.all([
      copySampleOnce({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...fast }),
      copySampleOnce({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...fast }),
    ]);
    expect(a).toEqual(b);
    expect(posts()).toHaveLength(1);
  });

  it("a remembered file that is gone (404) is not used: a fresh copy is made", async () => {
    const GONE = "55555555-5555-4555-8555-555555555555";
    const store = memStore({ [`${SAMPLE_ASSET_KEY}:${ORG}:${SOURCE_JOB}`]: GONE });
    const r = await copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...fast });
    expect(r).toMatchObject({ ok: true, assetId: ASSET, reused: false });
    expect(gets()).toContain(`/api/media/${GONE}`);
    expect(posts()).toHaveLength(1);
  });

  it("still being checked, then pressed again: the same upload is asked about, exactly one POST, and it lands", async () => {
    ticketAnswer = "pending";
    let t = 0;
    const clock = { now: () => t, sleep: async (ms: number) => void (t += ms) };
    const store = memStore();
    const first = await copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...clock });
    expect(first).toMatchObject({ ok: false, error: "still_checking" });
    expect(store.m.get(`${SAMPLE_TICKET_KEY}:${ORG}:${SOURCE_JOB}`)).toBe(TICKET);
    ticketAnswer = "ingested";
    t = 0;
    const second = await copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...clock });
    expect(second).toMatchObject({ ok: true, assetId: ASSET });
    expect(posts()).toHaveLength(1);
    expect(store.m.has(`${SAMPLE_TICKET_KEY}:${ORG}:${SOURCE_JOB}`)).toBe(false);
  });

  it("a reload mid-copy (the first page gone while the worker checks) sends nothing again", async () => {
    ticketAnswer = "pending";
    const store = memStore();
    // The first page: sent, then left while it waits (its wait never returns).
    void copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, sleep: () => new Promise(() => {}) });
    await waitFor(() => expect(store.m.get(`${SAMPLE_TICKET_KEY}:${ORG}:${SOURCE_JOB}`)).toBe(TICKET));
    // The reloaded page, same tab: it asks about that upload.
    ticketAnswer = "ingested";
    const r = await copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: store, ...fast });
    expect(r).toMatchObject({ ok: true, assetId: ASSET });
    expect(posts()).toHaveLength(1);
  });

  it("another tab mid-copy: an upload of this person's of that name still being checked is followed, not sent again", async () => {
    pendingUploads = [{ id: TICKET, name: READY.name, status: "ingesting" }];
    const r = await copySample({ orgId: ORG, userId: ME, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: memStore(), ...fast });
    expect(r).toMatchObject({ ok: true, assetId: ASSET });
    expect(posts()).toHaveLength(0);
  });

  it("without knowing who is signed in, no file is anyone's copy: one is made", async () => {
    library = [{ id: ASSET, kind: "image", name: READY.name, width: READY.width, height: READY.height, createdBy: ME }];
    const r = await copySample({ orgId: ORG, sample: PIC, fetchImpl: fetchMock as unknown as typeof fetch, storage: memStore(), ...fast });
    expect(r).toMatchObject({ ok: true, reused: false });
    expect(posts()).toHaveLength(1);
  });

  it("an earlier copy of yours is said to be reused, with its own thumbnail", async () => {
    library = [{ id: ASSET, kind: "image", name: READY.name, width: READY.width, height: READY.height, createdBy: ME }];
    render(section(READY));
    fireEvent.click(screen.getByTestId("sample-use"));
    await waitFor(() => expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.readyReused));
    expect(screen.getByTestId("sample-used-thumb").getAttribute("src")).toBe(THUMB);
    expect(posts()).toHaveLength(0);
  });

  it("a refusal names its remedy: the library will not show the upload to this account -> sign in again; no source", async () => {
    ticketAnswer = "forbidden";
    render(section(READY));
    fireEvent.click(screen.getByTestId("sample-use"));
    await waitFor(() => expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.signIn), { timeout: 4000 });
    expect(sourceAsked()).toBeNull();
    expect((screen.getByTestId("sample-use") as HTMLButtonElement).disabled).toBe(false);
  }, 8000);

  it(
    "a copy that lands after the person put another form in (Try again) does not take it over or change the address",
    async () => {
      render(section(READY));
      fireEvent.click(screen.getByTestId("sample-use"));
      // The upload waits for the worker (the first poll is 1.5 s away): meanwhile the person picks another form.
      await waitFor(() => expect(writes()).toContain(`PUT /api/media/uploads/${TICKET}`));
      act(() => (feed.props!.onRetry as (v: unknown) => void)({ capability: "t2v", model: "", prompt: "a whale", aspect: "16:9", duration: 5 }));
      expect(screen.queryByTestId("sample-proposed")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.inLibrary), { timeout: 4000 });
      expect(sourceAsked()).toBeNull();
      expect((last().initial as { capability: string }).capability).toBe("t2v");
      expect(new URL(window.location.href).searchParams.has("source")).toBe(false);
    },
    8000,
  );

  it("the proposed card goes once the person chose another source for the form", () => {
    render(section(READY));
    expect(screen.getByTestId("sample-proposed")).toBeTruthy();
    act(() => (feed.props!.onUseAsSource as (id: string) => void)("99999999-9999-4999-8999-999999999999"));
    expect(screen.queryByTestId("sample-proposed")).toBeNull();
    expect(writes()).toEqual([]);
  });
});
