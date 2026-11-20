// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
const h = vi.hoisted(() => ({ pending: false, refresh: vi.fn(), transition: vi.fn((run: () => void) => run()) }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useTransition: () => [h.pending, h.transition] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
import { FilmShelfReadNotice } from "@/components/studio-hub/FilmShelfReadNotice";
beforeEach(() => { h.pending = false; vi.clearAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw Error("No network in recovery fixture"); })); });
afterEach(() => { cleanup(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
it.each(["en", "ru", "uz"] as const)("offers %s read-only recovery outside the status message", (locale) => {
  const s = filmStudioStrings(locale);
  render(<FilmShelfReadNotice message={s.list.loadFailed} retryLabel={s.retry} />);
  expect(screen.getByRole("status").textContent).toBe(s.list.loadFailed);
  expect(screen.getByRole("status").querySelector("button, a")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: s.retry }));
  expect(h.transition).toHaveBeenCalledOnce();
  expect(h.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole("link")).toBeNull();
});
it("marks a pending route read busy and disables repeat activation", () => {
  h.pending = true;
  const s = filmStudioStrings("en");
  render(<FilmShelfReadNotice message={s.list.loadFailed} retryLabel={s.retry} />);
  const button = screen.getByRole("button", { name: s.retry }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.transition).not.toHaveBeenCalled();
});
