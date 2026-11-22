// @vitest-environment jsdom
/**
 * A public animation sample's "Try this prompt" (lib/site/showcase-link.ts -> lib/site/sample-source.ts -> GenerateSection). What
 * would break without these: an i2v sample opening the Studio with no picture and no words (the owner's "a click opens the Studio
 * with its prompt and the model selected" false for six samples); `sample=` turning into an open loader that fetches whatever the
 * address names; a refused or failed picture leaving a form that looks as if it had one (CLAUDE.md #5); the link quoting, holding or
 * creating a job without a press (CLAUDE.md #3); a reload or React's second effect run putting the same picture in the library twice.
 */
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const panel = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/components/studio/GeneratePanel", () => ({
  GeneratePanel: (p: Record<string, unknown>) => {
    panel.props.push(p);
    return <div data-testid="panel" />;
  },
}));
vi.mock("@/components/studio/JobFeed", () => ({ JobFeed: () => <div data-testid="feed" /> }));
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
import { SHOWCASE_ENTRIES, modelLeftOut } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { signupTryHref, studioTryHref } from "@/lib/site/showcase-link";
import { SAMPLE_PARAM, isShippedPicture, resolveSampleSource, sampleSourcePicture, type SampleSource } from "@/lib/site/sample-source";
import { SAMPLE_ASSET_KEY } from "@/lib/creative/sample-preload";
import { cleanLinkPrompt, prefillFromImprove } from "@/lib/creative/improve";
import { prefillFromQuery } from "@/lib/creative/studio";
import { prefillModel } from "@/lib/models-discovery";
import { DEFAULT_AFTER_AUTH, afterSignupPath, safeLoginReturn, studioNext } from "@/lib/safe-redirect";
import type { StudioModel } from "@/lib/creative/studio";

const ORIGIN = "https://app.example";
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
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
    const u = new URL(studioTryHref(e)!, ORIGIN);
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(e.jobId);
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
    const href = signupTryHref(e)!;
    expect(href.startsWith("/signup?next=")).toBe(true);
    const u = followSignup(href);
    expect(u.pathname).toBe("/all-channels/create");
    expect(u.searchParams.get("tool")).toBe("i2v");
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(e.jobId);
    const kept = u.searchParams.get("prompt") ?? "";
    expect(kept.length).toBeGreaterThan(0);
    expect(cleanLinkPrompt("i2v", e.prompt).startsWith(kept)).toBe(true);
    expect(pageReads(u).form?.prompt).toBe(kept);
  });

  it("long words are still cut to fit sign-up with the sample in the link", () => {
    const e = { ...I2V[0], prompt: "фонарь над тёмным озером ".repeat(60) };
    const u = followSignup(signupTryHref(e)!);
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(e.jobId);
    expect((u.searchParams.get("prompt") ?? "").length).toBeGreaterThan(0);
  });

  it("an operator preview still leaves the model out, and keeps the sample and the words", () => {
    const u = new URL(studioTryHref({ ...I2V[0], operatorPreview: true })!, ORIGIN);
    expect(u.searchParams.has("model")).toBe(false);
    expect(u.searchParams.get(SAMPLE_PARAM)).toBe(I2V[0].jobId);
  });

  it("a text sample carries no sample reference", () => {
    expect(new URL(studioTryHref(T2V)!, ORIGIN).searchParams.has(SAMPLE_PARAM)).toBe(false);
    expect(new URL(studioTryHref(T2I)!, ORIGIN).searchParams.has(SAMPLE_PARAM)).toBe(false);
  });
});

describe("the Studio resolves `sample=` against the shipped data only", () => {
  it("a sample whose starting picture is a shipped sample picture resolves to that picture's own poster", () => {
    expect(RESOLVABLE.length).toBeGreaterThan(0);
    for (const e of RESOLVABLE) {
      const sourceJob = (e.input as { jobId: string }).jobId;
      const r = resolveSampleSource(e.jobId, { capability: "i2v", sourceId: null }, SHOWCASE_ENTRIES, FILES);
      expect(r, e.jobId).toEqual({ state: "ready", sampleId: e.jobId, src: FILES[sourceJob].poster, name: `sample-${sourceJob.slice(0, 8)}.webp` });
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
const READY: SampleSource = { state: "ready", sampleId: RESOLVABLE[0]?.jobId ?? "", src: "/_next/static/media/poster.abc.webp", name: "sample-abc.webp" };

let fetchMock: ReturnType<typeof vi.fn>;
let quota = false;
const writes = () =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET").map(([url, init]) => `${(init as RequestInit).method} ${url}`);
const gets = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET").map(([url]) => String(url));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  panel.props = [];
  quota = false;
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", `/all-channels/create?tool=i2v&model=m&${SAMPLE_PARAM}=${READY.state === "ready" ? READY.sampleId : ""}&prompt=drift`);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === (READY as { src: string }).src) return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" }) };
    if (url === "/api/media/uploads" && method === "POST")
      return quota ? json({ error: "quota_exceeded" }, 409) : json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "sample-abc.webp" });
    if (url === `/api/media/uploads/${TICKET}` && method === "PUT") return json({ ok: true });
    if (url === `/api/media/uploads/${TICKET}`) return json({ status: "ingested", asset_id: ASSET });
    if (url === `/api/media/${ASSET}`) return json({ asset: { id: ASSET, kind: "image" } });
    return json({ jobs: [], templates: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sourceAsked = () => (last()?.sourceRequest as { id: string } | null | undefined)?.id ?? null;

describe("GenerateSection with a sample's picture", () => {
  it("refused: no picture is loaded, the form has no source, the note says so, and nothing is fetched for it", async () => {
    render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={{ state: "refused" }} />));
    expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.refused);
    await new Promise((r) => setTimeout(r, 50));
    expect(sourceAsked()).toBeNull();
    expect((last().initial as { sourceId: string | null }).sourceId).toBeNull();
    expect(writes()).toEqual([]);
    expect(gets().filter((u) => u.includes("/media"))).toEqual([]);
  });

  it(
    "ready: the picture goes into the library by the ordinary upload, becomes the source, and that upload is the only write",
    async () => {
      render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={READY} />));
      expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.loading);
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.ready);
      // The words and the tool stay as the link set them.
      expect((last().initial as { prompt: string; capability: string }).prompt).toBe("drift");
      expect((last().initial as { capability: string }).capability).toBe("i2v");
      expect(writes()).toEqual(["POST /api/media/uploads", `PUT /api/media/uploads/${TICKET}`]);
      expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/creative"))).toBe(false);
      // The address names the library file now, not the sample.
      expect(new URL(window.location.href).searchParams.get("source")).toBe(ASSET);
      expect(new URL(window.location.href).searchParams.has(SAMPLE_PARAM)).toBe(false);
      expect(sessionStorage.getItem(`${SAMPLE_ASSET_KEY}:${ORG}:${(READY as { sampleId: string }).sampleId}`)).toBe(ASSET);
    },
    8000,
  );

  it(
    "a reload of the same link (or React's second effect run) never uploads the picture twice",
    async () => {
      const { unmount } = render(
        wrap(
          <StrictMode>
            <GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={READY} />
          </StrictMode>,
        ),
      );
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(writes().filter((w) => w.startsWith("POST"))).toHaveLength(1);
      unmount();
      panel.props = [];
      // The old address again (a stale tab, Back): the tab remembers the file; it is only read, not sent again.
      render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={READY} />));
      await waitFor(() => expect(sourceAsked()).toBe(ASSET), { timeout: 4000 });
      expect(writes().filter((w) => w.startsWith("POST"))).toHaveLength(1);
      expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.ready);
    },
    10000,
  );

  it("the site's copy not coming back is said, with no source and no upload", async () => {
    const missing: SampleSource = { ...(READY as Extract<SampleSource, { state: "ready" }>), src: "/_next/static/media/gone.webp" };
    render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={missing} />));
    // The default answer for an unknown path is a JSON body, not a picture: refused as a picture.
    await waitFor(() => expect(screen.getByTestId("sample-source").textContent).toBe(en.gen.sampleSource.refused));
    expect(sourceAsked()).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("a refused upload names its reason and leaves no source", async () => {
    quota = true;
    render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={READY} />));
    await waitFor(() =>
      expect(screen.getByTestId("sample-source").textContent).toBe(fmt(en.gen.sampleSource.failedWhy, { reason: en.media.errors.quota_exceeded })),
    );
    expect(sourceAsked()).toBeNull();
    expect(writes()).toEqual(["POST /api/media/uploads"]);
  });

  it("the note is in uz and ru too", () => {
    render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={{ state: "refused" }} />, "uz"));
    expect(screen.getByTestId("sample-source").textContent).toBe(dictionaries.uz.gen.sampleSource.refused);
    cleanup();
    render(wrap(<GenerateSection orgId={ORG} models={[]} desk="video" initial={I2V_FORM} sample={{ state: "refused" }} />, "ru"));
    expect(screen.getByTestId("sample-source").textContent).toBe(dictionaries.ru.gen.sampleSource.refused);
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
