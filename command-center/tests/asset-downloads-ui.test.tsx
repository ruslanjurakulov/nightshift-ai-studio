// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/library",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import { AssetDownloads } from "@/components/media/AssetDownloads";

const ID = "aaaaaaaa-1111-4222-8333-444444444444";
const td = en.assetDownload;
const fetchMock = vi.fn();
let clicked: string[] = [];

beforeEach(() => {
  clicked = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute("href") ?? "");
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mount = (props: Partial<Parameters<typeof AssetDownloads>[0]> = {}, locale: "en" | "ru" | "uz" = "en") =>
  render(
    <I18nProvider locale={locale}>
      <AssetDownloads assetId={ID} preview="ready" width={1080} height={1920} {...props} />
    </I18nProvider>,
  );

describe("download buttons", () => {
  it("original and preview are two different addresses; the preview opens in a new tab", () => {
    mount();
    const preview = screen.getByRole("link", { name: new RegExp(td.preview) });
    expect(preview.getAttribute("href")).toBe(`/api/library/${ID}/download?variant=preview`);
    expect(preview.getAttribute("target")).toBe("_blank");
    expect(screen.getByRole("button", { name: /Download original · 1080×1920/ })).toBeTruthy();
  });

  it("the original is checked with one ranged byte, then saved from its own address", async () => {
    fetchMock.mockResolvedValue(new Response("x", { status: 206 }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Download original/ }));
    await waitFor(() => expect(clicked).toEqual([`/api/library/${ID}/download?variant=original`]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/library/${ID}/download?variant=original`);
    expect((init as RequestInit).headers).toEqual({ Range: "bytes=0-0" });
    expect(((init as RequestInit).method ?? "GET")).toBe("GET");
  });

  it("a refusal is a sentence, not a saved error file; only a transient failure offers Try again", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "gone" }), { status: 410 }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Download original/ }));
    expect(await screen.findByText(td.errors.gone)).toBeTruthy();
    expect(clicked).toEqual([]);
    expect(screen.queryByRole("button", { name: td.retry })).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: /Download original/ }));
    expect(await screen.findByText(td.errors.failed)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 206 }));
    fireEvent.click(screen.getByRole("button", { name: td.retry }));
    await waitFor(() => expect(clicked).toHaveLength(1));
  });

  it("signed out offers a way to sign in; a server error offers Try again and keeps the keyboard on the key", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    mount();
    const key = screen.getByRole("button", { name: /Download original/ });
    fireEvent.click(key);
    expect(await screen.findByText(td.errors.unauthorized)).toBeTruthy();
    expect(screen.getByRole("link", { name: td.signIn }).getAttribute("href")).toBe("/login?next=%2Fx%2Flibrary");
    expect(document.activeElement).toBe(key);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "read_failed" }), { status: 502 }));
    fireEvent.click(key);
    expect(await screen.findByText(td.errors.server)).toBeTruthy();
    expect(screen.getByRole("button", { name: td.retry })).toBeTruthy();
  });

  it("a double press starts one check, not two", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r)));
    mount();
    const b = screen.getByRole("button", { name: /Download original/ });
    fireEvent.click(b);
    fireEvent.click(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(new Response("x", { status: 206 }));
    await waitFor(() => expect(clicked).toHaveLength(1));
  });

  it("a missing preview is a disabled button that says why; no preview link at all for 'none'", () => {
    mount({ preview: "missing" });
    expect(screen.queryByRole("link", { name: new RegExp(td.preview) })).toBeNull();
    // aria-disabled, not disabled: a disabled key would drop the keyboard out of the Library's dialog.
    expect(screen.getByRole("button", { name: td.preview }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(td.errors.no_preview)).toBeTruthy();
    cleanup();
    mount({ preview: "none" });
    expect(screen.queryByText(td.preview)).toBeNull();
  });

  it("SRT only when asked for, and it says when the export had none", async () => {
    mount();
    expect(screen.queryByRole("button", { name: td.captions })).toBeNull();
    cleanup();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "no_captions" }), { status: 404 }));
    mount({ captions: true });
    fireEvent.click(screen.getByRole("button", { name: td.captions }));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/library/${ID}/download?variant=captions`);
    expect(await screen.findByText(td.errors.no_captions)).toBeTruthy();
  });

  it("speaks Russian and Uzbek", () => {
    mount({}, "ru");
    expect(screen.getByText(ru.assetDownload.preview)).toBeTruthy();
    cleanup();
    mount({}, "uz");
    expect(screen.getByText(uz.assetDownload.preview)).toBeTruthy();
  });
});
