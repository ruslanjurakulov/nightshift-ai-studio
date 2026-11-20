// @vitest-environment jsdom
// Breach on the salvage of #803 (the explicit Studio assembly confirmation): BR-803-01 and BR-803-02 were failing PoCs;
// the rest pin what held. Synthetic film/org ids, mocked fetch, no network.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssemblePanel } from "@/components/studio-timeline/AssemblePanel";
import { JobFeed } from "@/components/studio/JobFeed";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { fmt } = await import("@/lib/i18n");
  return { useI18n: () => ({ t: en, fmt, lang: "en" }) };
});
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => p }));
vi.mock("@/lib/credits-live", () => ({ refreshCredits: vi.fn() }));

const q = (v: number, total: number) => ({ priced: true, total, quote_id: `fq-${v}-${String(v).repeat(32).slice(0, 32).replace(/[^0-9a-f]/g, "a")}`, startable: true, may_start: true, blocked_by: [], refusals: [], assembly_minutes: 8, available: 1000, exempt: false });

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void };
let quoteCalls: { version: number; p: Pending }[];
let starts: { quote_id: string; idem: string; p: Pending }[];
let calls: { url: string; method: string }[];
beforeEach(() => {
  quoteCalls = []; starts = []; calls = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return new Promise<Response>((resolve, reject) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/quote")) quoteCalls.push({ version: body.version, p: { resolve, reject } });
      else if (url.endsWith("/start")) starts.push({ ...body, p: { resolve, reject } });
      else reject(new TypeError("synthetic offline"));
    });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const panel = (version: number) => <AssemblePanel filmId="synthetic" orgId="synthetic-org" version={version} editable status="draft" onStarted={() => undefined} />;
const key = () => screen.getByTestId("assemble-key") as HTMLButtonElement;

it("BR-803-01: a quote answered for an older version is discarded, never offered for confirmation", async () => {
  const view = render(panel(3));
  fireEvent.click(key());                       // asks quote_film for v3
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  view.rerender(panel(4));                      // someone saved: the person now looks at v4
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: q(3, 16) }))));
  // Secure behaviour: the v3 price is not on the key and no dialog can confirm it.
  expect.soft(screen.getByTestId("assemble-amount").textContent).not.toMatch(/16/);
  if (!key().disabled) fireEvent.click(key());
  const dialog = screen.queryByRole("dialog");
  if (dialog) fireEvent.click(screen.getByTestId("assemble-confirm-key"));
  for (const s of starts) expect(s.quote_id.startsWith("fq-4-"), `confirmed and sent a v3 quote (${s.quote_id}) while v4 was shown`).toBe(true);
  expect(dialog, "the confirmation dialog offered a price quoted for a version the person is no longer looking at").toBeNull();
});

it("BR-803-02: while a confirmed start is in flight the Assemble key stays locked, even if the project version moves", async () => {
  const view = render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: q(3, 16) }))));
  fireEvent.click(key());
  fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
  await waitFor(() => expect(starts).toHaveLength(1));
  view.rerender(panel(4));                      // a reload lands while start_film is still answering
  expect.soft(key().disabled, "Assemble key re-enabled while a hold of credits is still in flight").toBe(true);
  // Consequence if it is not: a new quote resets the idempotency key under the in-flight start; a lost answer then makes the
  // next confirmation a second start with a different key.
  if (!key().disabled) {
    fireEvent.click(key());
    await waitFor(() => expect(quoteCalls).toHaveLength(2));
    await act(async () => quoteCalls[1].p.resolve(new Response(JSON.stringify({ quote: q(4, 16) }))));
    await act(async () => starts[0].p.reject(new TypeError("synthetic network loss")));
    fireEvent.click(key());
    const c = screen.queryByTestId("assemble-confirm-key");
    if (c) fireEvent.click(c);
    await waitFor(() => expect(starts.length).toBeGreaterThanOrEqual(1));
    expect(new Set(starts.map((s) => s.idem)).size, "two start_film calls with two idempotency keys after one lost answer").toBe(1);
  }
});

it("no confirmation and no start for a quote with an unknown total", async () => {
  render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: { ...q(3, 0), total: null } }))));
  fireEvent.click(key()); fireEvent.click(key());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(starts).toHaveLength(0);
});

it("no confirmation for a quote whose id is forged/malformed even if total is present", async () => {
  render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: { ...q(3, 5), quote_id: "fq-3-../../x" } }))));
  fireEvent.click(key()); fireEvent.click(key());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(starts).toHaveLength(0);
});

it("the network-failure retry reopens the confirmation and replays the same key; it never starts on its own", async () => {
  render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: q(3, 16) }))));
  fireEvent.click(key());
  fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
  await waitFor(() => expect(starts).toHaveLength(1));
  await act(async () => starts[0].p.reject(new TypeError("synthetic network loss")));
  fireEvent.click(key());
  expect(starts).toHaveLength(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByTestId("assemble-confirm-key"));
  await waitFor(() => expect(starts).toHaveLength(2));
  expect(starts[1].idem).toBe(starts[0].idem);
  expect(starts[1].quote_id).toBe(starts[0].quote_id);
});

it("a double click on Confirm sends one start", async () => {
  render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: q(3, 16) }))));
  fireEvent.click(key());
  const c = await screen.findByTestId("assemble-confirm-key");
  fireEvent.click(c); fireEvent.click(c);
  await waitFor(() => expect(starts).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(starts).toHaveLength(1);
});

it("the feed's read recovery only reads: no POST, no create, no prefill", async () => {
  const onRetry = vi.fn();
  render(<JobFeed orgId="synthetic-org" onRetry={onRetry} />);
  const reload = await screen.findByRole("button", { name: /Reload generations/ });
  fireEvent.click(reload); fireEvent.click(reload);
  await new Promise((r) => setTimeout(r, 30));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  for (const c of calls) {
    expect(c.method).toBe("GET");
    expect(c.url.startsWith("/api/creative/jobs?org_id=")).toBe(true);
  }
  expect(onRetry).not.toHaveBeenCalled();
});

it("a start with no answer says the start may have gone through, shows the held quote's credits, and keeps focus on the panel", async () => {
  const { en } = await import("@/lib/i18n/en");
  render(panel(3));
  fireEvent.click(key());
  await waitFor(() => expect(quoteCalls).toHaveLength(1));
  await act(async () => quoteCalls[0].p.resolve(new Response(JSON.stringify({ quote: q(3, 16) }))));
  fireEvent.click(key());
  fireEvent.click(await screen.findByTestId("assemble-confirm-key"));
  await waitFor(() => expect(starts).toHaveLength(1));
  // Pixel M1: the dialog closed while the key is disabled; focus is on the panel, not lost to the page body.
  expect(document.activeElement).toBe(screen.getByTestId("assemble"));
  await act(async () => starts[0].p.reject(new TypeError("synthetic network loss")));
  // Pixel P1 (rule 5): no answer is not "nothing was held".
  const note = screen.getByTestId("assemble-note").textContent ?? "";
  expect(note).toContain(en.studioTimeline.startNoAnswer);
  expect(note).not.toContain(en.studioTimeline.startFailed.other);
  // Pixel M2: the key names the held quote's credits, since pressing it reopens that confirmation.
  expect(screen.getByTestId("assemble-amount").textContent).toMatch(/16/);
});
