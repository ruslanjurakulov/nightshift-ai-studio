// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssemblePanel } from "../components/studio-timeline/AssemblePanel";
import { studioTimelineEn as c } from "../lib/i18n/studio-timeline/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, fmt }) };
});
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => p }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn() }));
const quote = { priced: true, total: 16, quote_id: `fq-3-${"b".repeat(32)}`, startable: true, may_start: true, blocked_by: [], refusals: [], assembly_minutes: 8, available: 100, exempt: false };
let starts: Record<string, unknown>[];
let fail: boolean;
const started = vi.fn();
beforeEach(() => {
  starts = []; fail = false; started.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/films/synthetic/quote") return new Response(JSON.stringify({ quote }));
    if (url === "/api/films/synthetic/start") {
      starts.push(JSON.parse(String(init?.body)));
      if (fail) throw new TypeError("Synthetic offline response failure");
      return new Response(JSON.stringify({ start: { ok: true, replayed: false } }));
    }
    throw new Error("Unexpected request in local mock");
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(compact = false) {
  render(<AssemblePanel filmId="synthetic" orgId="synthetic-org" version={3} editable status="draft" compact={compact} onStarted={started} />);
  return screen.getByTestId("assemble-key") as HTMLButtonElement;
}
async function dialog(key: HTMLButtonElement) {
  key.focus(); fireEvent.click(key);
  await waitFor(() => expect(screen.getByTestId("assemble-amount").textContent).toMatch(/^16 cr(?:edits)?$/));
  fireEvent.click(key);
  return screen.findByRole("dialog");
}
it("repeated Enter on Assemble prevents its native activation before any quote", () => {
  const key = mount(); key.focus();
  expect(fireEvent.keyDown(key, { key: "Enter", repeat: true })).toBe(false);
  expect(fetch).not.toHaveBeenCalled(); expect(starts).toHaveLength(0);
});
it.each([false, true])("Cancel/Escape and Tab preserve focus in compact=%s", async compact => {
  const key = mount(compact); const box = await dialog(key);
  const cancel = screen.getByRole("button", { name: c.cancel });
  const confirm = screen.getByTestId("assemble-confirm-key");
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(confirm);
  fireEvent.keyDown(confirm, { key: "Tab" }); expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(key);
  fireEvent.click(key); fireEvent.click(screen.getByRole("button", { name: c.cancel }));
  expect(document.activeElement).toBe(key); expect(starts).toHaveLength(0);
});
it("background key is disabled while confirming and held Enter cannot confirm", async () => {
  const key = mount(); await dialog(key); expect(key.disabled).toBe(true);
  fireEvent.click(key); expect(starts).toHaveLength(0);
  const confirm = screen.getByTestId("assemble-confirm-key"); confirm.focus();
  expect(fireEvent.keyDown(confirm, { key: "Enter", repeat: true })).toBe(false);
  expect(starts).toHaveLength(0);
});
it("network retry opens visible confirmation and preserves the original intent", async () => {
  fail = true; const key = mount(); await dialog(key);
  fireEvent.click(screen.getByTestId("assemble-confirm-key"));
  await waitFor(() => expect(screen.getByTestId("assemble-note").textContent).toBe(c.startNoAnswer));
  expect(starts).toHaveLength(1); const first = starts[0];
  fail = false; fireEvent.click(key);
  expect(starts).toHaveLength(1); await screen.findByRole("dialog");
  fireEvent.click(screen.getByTestId("assemble-confirm-key"));
  await waitFor(() => expect(started).toHaveBeenCalledTimes(1));
  expect(starts).toEqual([first, first]);
});
it("only explicit Confirm starts and double activation remains one mocked start", async () => {
  const key = mount(); await dialog(key); expect(starts).toHaveLength(0);
  const confirm = screen.getByTestId("assemble-confirm-key");
  fireEvent.click(confirm); fireEvent.click(confirm);
  await waitFor(() => expect(started).toHaveBeenCalledTimes(1)); expect(starts).toHaveLength(1);
});
