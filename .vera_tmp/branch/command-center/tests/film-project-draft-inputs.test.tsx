// @vitest-environment jsdom
// Normal form-only regression: no database, user, navigation or generation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { filmStudioEn as t } from "../lib/i18n/film-studio/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: () => {} }), usePathname: () => "/alpha/create/projects" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/alpha${s}` }));
const { FilmList } = await import("../components/films/FilmList");
const offlineFetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => { throw new TypeError("synthetic offline fixture"); });

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("ns.studio.projects.view.v1", "open");
  push.mockReset();
  offlineFetch.mockClear();
  vi.stubGlobal("fetch", offlineFetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openForm() {
  render(<FilmList initial={{ state: "ok", films: [] }} canEdit channel={null} studioName="Synthetic Studio" />);
  fireEvent.click(screen.getByTestId("fs-new"));
}
function expectDraft(title: string, format: string) {
  expect((screen.getByLabelText(t.create.titleLabel) as HTMLInputElement).value).toBe(title);
  expect((screen.getByLabelText(t.create.formatLabel) as HTMLSelectElement).value).toBe(format);
  expect(screen.getByTestId("fs-composer")).toBeTruthy();
  expect(push).not.toHaveBeenCalled();
}

describe("project creation preserves draft inputs", () => {
  it("keeps title and selected format when source validation fails without a request", () => {
    openForm();
    fireEvent.change(screen.getByLabelText(t.create.titleLabel), { target: { value: "Synthetic retained title" } });
    fireEvent.change(screen.getByLabelText(t.create.formatLabel), { target: { value: "9:16" } });
    fireEvent.click(screen.getByTestId("fs-create"));
    expect(screen.getByLabelText(t.create.topicLabel).getAttribute("aria-invalid")).toBe("true");
    expectDraft("Synthetic retained title", "9:16");
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it("keeps title, format and source after a rejected network request, without automatic retry", async () => {
    openForm();
    fireEvent.change(screen.getByLabelText(t.create.topicLabel), { target: { value: "A wholly synthetic topic" } });
    fireEvent.change(screen.getByLabelText(t.create.titleLabel), { target: { value: "Synthetic offline title" } });
    fireEvent.change(screen.getByLabelText(t.create.formatLabel), { target: { value: "9:16" } });
    fireEvent.click(screen.getByTestId("fs-create"));
    await waitFor(() => expect(screen.getByTestId("fs-error-network")).toBeTruthy());
    expectDraft("Synthetic offline title", "9:16");
    expect((screen.getByLabelText(t.create.topicLabel) as HTMLTextAreaElement).value).toBe("A wholly synthetic topic");
    expect((screen.getByTestId("fs-create") as HTMLButtonElement).disabled).toBe(false);
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(offlineFetch.mock.calls[0]).toEqual([
      "/api/films", expect.objectContaining({ method: "POST", body: expect.any(String) }),
    ]);
  });
});
