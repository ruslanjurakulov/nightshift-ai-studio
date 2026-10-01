// @vitest-environment jsdom
/**
 * A finished edit, upscale or background removal is shown against its source
 * picture with a before/after handle; the library is read only when the feed
 * has such a job, and a picture the library no longer holds shows no slider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { JobFeed } from "@/components/studio/JobFeed";
import { compareSources } from "@/lib/creative/studio";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";
const OUT = "33333333-3333-4333-8333-333333333333";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1",
  capability: "upscale",
  status: "completed",
  requested_model: "pic-tools",
  params: { source_asset_id: SRC, factor: 2 },
  quoted_credits: 6,
  charged_credits: 6,
  error_code: null,
  result: null,
  result_asset_ids: [OUT],
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

const picture = (id: string) => ({
  id,
  kind: "image",
  mime: "image/png",
  bytes: 1,
  width: 10,
  height: 10,
  durationS: null,
  source: "upload",
  name: `${id}.png`,
  variants: ["thumb"],
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  thumbUrl: `/thumb/${id}`,
  viewUrl: `/view/${id}`,
});

let fetchMock: ReturnType<typeof vi.fn>;
let libraryAssets: unknown[];
let feedJobs: unknown[];
beforeEach(() => {
  libraryAssets = [picture(SRC), picture(OUT)];
  feedJobs = [job()];
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: feedJobs });
    if (url.startsWith("/api/media")) return json({ available: true, assets: libraryAssets, uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mediaCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/media")).length;

describe("compareSources", () => {
  it("pairs a finished picture job's source with its first result", () => {
    expect(compareSources(job())).toEqual({ before: SRC, after: OUT });
    expect(compareSources(job({ capability: "edit" }))).toEqual({ before: SRC, after: OUT });
    expect(compareSources(job({ capability: "remove_bg" }))).toEqual({ before: SRC, after: OUT });
  });

  it("is null for anything else", () => {
    expect(compareSources(job({ status: "failed" }))).toBeNull();
    expect(compareSources(job({ status: "running" }))).toBeNull();
    expect(compareSources(job({ capability: "i2v" }))).toBeNull();
    expect(compareSources(job({ capability: "t2i", params: { prompt: "x" } }))).toBeNull();
    expect(compareSources(job({ result_asset_ids: [] }))).toBeNull();
    expect(compareSources(job({ params: { source_asset_id: "nope" } }))).toBeNull();
  });
});

describe("JobFeed before / after", () => {
  it("shows the source and the result split by a handle", async () => {
    const { container } = render(withI18n(<JobFeed orgId={ORG} />));
    const slider = await screen.findByRole("slider", { name: t.gen.compareLabel });
    expect((slider as HTMLInputElement).value).toBe("50");
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(expect.arrayContaining([`/view/${SRC}`, `/view/${OUT}`]));

    fireEvent.change(slider, { target: { value: "80" } });
    expect((slider as HTMLInputElement).value).toBe("80");
    expect(slider.getAttribute("aria-valuetext")).toBe("80%");
  });

  it("does not read the library when no job has a result to draw", async () => {
    feedJobs = [
      job({ capability: "t2i", params: { prompt: "a lighthouse" }, result_asset_ids: [] }),
      job({ id: "f", status: "failed", capability: "t2i", params: { prompt: "a cliff" }, result_asset_ids: [] }),
    ];
    render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByText("a lighthouse");
    expect(mediaCalls()).toBe(0);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("draws a finished image's own thumbnail from the library, with no slider", async () => {
    feedJobs = [job({ capability: "t2i", params: { prompt: "a lighthouse" }, result_asset_ids: [OUT] })];
    const { container } = render(withI18n(<JobFeed orgId={ORG} />));
    await screen.findByText("a lighthouse");
    await vi.waitFor(() => expect(container.querySelector(`img[src="/thumb/${OUT}"]`)).not.toBeNull());
    expect(mediaCalls()).toBe(1);
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("keeps the plain link when the library no longer holds the result", async () => {
    libraryAssets = [picture(SRC)];
    render(withI18n(<JobFeed orgId={ORG} />));
    expect(await screen.findByRole("link", { name: t.gen.openLibrary })).toBeTruthy();
    await vi.waitFor(() => expect(mediaCalls()).toBe(1));
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
