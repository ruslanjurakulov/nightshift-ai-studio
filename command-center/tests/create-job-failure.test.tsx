// @vitest-environment jsdom
/**
 * D12 on the Create page: a failed queue job is one plain sentence per code (en/ru/uz), says the credits
 * came back only when the route saw the hold released, and never shows a customer the vendor-named log.
 * The operator additionally keeps the first log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
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
import { CreateStudio } from "@/components/create/CreateStudio";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { toQueueJob } from "@/lib/runBackend";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const priced = { supported: true, enforced: true, exempt: false, estimate: { credits: 120, basis: "per_minute", sample: 0, floorApplied: false, gap: null }, available: 900 };

let jobs: unknown[];

beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).startsWith("/api/credits/estimate")) return json(priced);
      if (String(url).startsWith("/api/agent/run")) return json({ ok: true });
      if (String(url).startsWith("/api/agent/events")) return json({ events: [], backend: "queue", jobs });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAllCreateAttempts();
});

async function startRun(locale: "en" | "ru" | "uz", operator = false) {
  const t = dictionaries[locale];
  render(
    <I18nProvider locale={locale}>
      <CreateStudio channelId="chan-a" githubConfigured agentConfig={null} canRun userId="5b0c2f6e-1d44-4c2e-9b1f-0a7e2d9c3e11" orgId="org-1" backend="queue" operator={operator} />
    </I18nProvider>,
  );
  await screen.findByText(/120/);
  fireEvent.change(screen.getByRole("textbox", { name: t.create.flow.topicTitle }), { target: { value: "Ancient Khiva" } });
  fireEvent.click(screen.getByRole("button", { name: t.create.create }));
  fireEvent.click(await screen.findByRole("button", { name: t.create.confirm }));
  return t;
}

const failedJob = (over: Record<string, unknown> = {}) => ({
  ...toQueueJob({
    id: 5,
    status: "failed",
    attempts: 1,
    error: "[code:provider_quota] main.py exited with code 1\nmodules.minimax_broll.VideoModelUnavailable: top up the Kling account",
  }),
  error: null, // what the events route sends a customer
  ...over,
});

describe("a failed job on the Create page", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    it(`${locale}: the sentence for its code, the refund line, and no log`, async () => {
      jobs = [failedJob({ creditsReturned: true })];
      const t = await startRun(locale);
      await waitFor(() => expect(document.body.textContent).toContain(t.create.jobError.provider_quota));
      expect(document.body.textContent).toContain(t.create.creditsReturned);
      expect(document.body.textContent).not.toMatch(/Kling|top up|exited with code/);
    });
  }

  it("does not claim a refund it did not see", async () => {
    jobs = [failedJob({ creditsReturned: null })];
    const t = await startRun("en");
    await waitFor(() => expect(document.body.textContent).toContain(t.create.jobError.provider_quota));
    expect(document.body.textContent).not.toContain(t.create.creditsReturned);
  });

  it("an old failure without a code reads as unknown", async () => {
    jobs = [failedJob({ errorCode: null })];
    const t = await startRun("en");
    await waitFor(() => expect(document.body.textContent).toContain(t.create.jobError.unknown));
  });

  it("the operator also keeps the first log line", async () => {
    jobs = [failedJob({ error: "main.py exited with code 1\nmodules.minimax_broll.VideoModelUnavailable: top up the Kling account" })];
    const t = await startRun("en", true);
    await waitFor(() => expect(document.body.textContent).toContain(t.create.jobError.provider_quota));
    expect(document.body.textContent).toContain("main.py exited with code 1");
  });
});
