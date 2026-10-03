// @vitest-environment jsdom
/**
 * The estimate line under Run now / Create (components/credits/CreditEstimateLine.tsx)
 * with the workspace's extra-credits switch off (migration 0094): it compares the
 * run with what the run can actually use, says the switch is off, and — only when
 * that is why the run is short — links to the switch. With it on, the line is
 * exactly what it was.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/chronos/create" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { CreditEstimateLine } from "@/components/credits/CreditEstimateLine";

const estimate = { credits: 120, basis: "unknown", sample: 0, floorApplied: false, gap: null };
const answer = (body: Record<string, unknown>) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ supported: true, enforced: true, exempt: false, estimate, ...body }), { status: 200 })));

const show = () =>
  render(
    <I18nProvider locale="en">
      <CreditEstimateLine channelId="ch-a" durationS={120} />
    </I18nProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("estimate line, extra credits off", () => {
  it("short because of the switch: what a run can use, the reason, and the link", async () => {
    answer({ available: 400, extraOff: true, spendable: 50 });
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("50 available · extra credits off"));
    expect(container.textContent).not.toContain("400");
    const link = container.querySelector("[data-extra-off-link]") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/chronos/usage#extra");
  });

  it("covered by what can be used: says the switch is off, no link to push", async () => {
    answer({ available: 400, extraOff: true, spendable: 300 });
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("300 available · extra credits off"));
    expect(container.querySelector("[data-extra-off-link]")).toBeNull();
  });

  it("switch on: the balance, as before, and no mention", async () => {
    answer({ available: 400 });
    const { container } = show();
    await waitFor(() => expect(container.textContent).toContain("400 available"));
    expect(container.textContent).not.toContain("extra credits off");
    expect(container.querySelector("[data-extra-off-link]")).toBeNull();
    expect(screen.getByRole("link", { name: /credits/i }).getAttribute("href")).toBe("/chronos/credits");
  });
});
