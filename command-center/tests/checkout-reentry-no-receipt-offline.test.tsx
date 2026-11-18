// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, type Locale } from "@/lib/i18n";
import type { DodoView } from "@/lib/dodo";

const mock = vi.hoisted(() => ({ refresh: vi.fn(), network: vi.fn(), navigation: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mock.refresh }), usePathname: () => "/synthetic/credits" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (path: string) => `/synthetic${path}` }));
vi.mock("@/components/view-mode/frame-nav", () => ({ assignTop: mock.navigation }));

// No offer, receipt, payment id, account or transaction is created.
const VIEW: DodoView = { environment: "test", amount: null, packs: [], plans: [] };
async function panel(locale: Locale) {
  // Reset modules only when modelling a full browser re-entry, not an ordinary rerender.
  const [{ DodoBuyCredits }, { I18nProvider }] = await Promise.all([
    import("@/components/credits/DodoBuyCredits"), import("@/lib/i18n/context"),
  ]);
  const fixture = (balance: number) => <I18nProvider locale={locale}><DodoBuyCredits view={VIEW} balance={balance} /></I18nProvider>;
  const result = render(fixture(0));
  return { ...result, updateAccount: (balance: number) => result.rerender(fixture(balance)) };
}
function noCalls() {
  expect(mock.network).not.toHaveBeenCalled();
  expect(mock.navigation).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  mock.refresh.mockReset(); mock.network.mockReset(); mock.navigation.mockReset();
  mock.network.mockImplementation(() => { throw new Error("Network forbidden in offline fixture"); });
  mock.navigation.mockImplementation(() => { throw new Error("Checkout navigation forbidden"); });
  vi.stubGlobal("fetch", mock.network);
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/synthetic/credits");
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

for (const locale of ["en", "ru", "uz"] as const) {
  describe(`receipt-free checkout re-entry (${locale})`, () => {
    it("a pending return without receipt must not claim payment received or completed", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=pack&status=pending");
      await panel(locale);
      expect(window.location.search).toBe("");
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      expect(mock.refresh).not.toHaveBeenCalled();
      noCalls();
      // A pending URL is a hint, not a receipt; keep its announcement neutral.
      const confirming = screen.getByText(cp.checkoutConfirming);
      expect(confirming.getAttribute("aria-live")).toBe("polite");
      expect(confirming.style.color).toBe("var(--color-muted)");
      expect(screen.queryByText(cp.packPaid)).toBeNull();
    });

    it("the existing account confirmation signal still reports credits added", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.sessionStorage.setItem("ns:dodo:balance-before", "0");
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=pack&status=succeeded");
      const result = await panel(locale);
      expect(screen.getByText(cp.checkoutConfirming)).toBeTruthy();
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      result.updateAccount(13); // Synthetic account refresh; no ledger or debit is performed.
      expect(screen.getByText(cp.packArrived)).toBeTruthy();
      expect(screen.queryByText(cp.checkoutConfirming)).toBeNull();
      noCalls();
    });

    it("a pending return that times out remains unconfirmed rather than claiming a payment went through", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=pack&status=pending");
      await panel(locale);
      for (let i = 0; i < 20; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(screen.getByText(cp.checkoutUnconfirmed)).toBeTruthy();
      expect(screen.queryByText(cp.packPaid)).toBeNull();
      expect(screen.queryByText(cp.packSlow)).toBeNull();
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      expect(mock.refresh).toHaveBeenCalledTimes(20);
      noCalls();
    });

    it("a pending plan return also waits for confirmation without saying plan active", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=plan&status=pending");
      const [{ PlanPanel }, { I18nProvider }] = await Promise.all([
        import("@/components/credits/PlanPanel"), import("@/lib/i18n/context"),
      ]);
      render(<I18nProvider locale={locale}><PlanPanel summary={null} matrix={null} access="allowed" orgId="synthetic" userId={null} email={null} dodo={VIEW} /></I18nProvider>);
      expect(screen.getByText(cp.checkoutConfirming)).toBeTruthy();
      expect(screen.queryByText(cp.planPaid)).toBeNull();
      expect(screen.queryByText(cp.planArrived)).toBeNull();
      noCalls();
    });

    it("resuming the cleaned page does not replay a pending claim or leave an abandoned poll running", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=pack&status=processing");
      const first = await panel(locale);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(mock.refresh).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe("");
      first.unmount();
      mock.refresh.mockClear();
      vi.resetModules();
      await panel(locale);
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.queryByText(cp.packPaid)).toBeNull();
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      expect(mock.refresh).not.toHaveBeenCalled();
      noCalls();
    });

    it("a failed return and a fresh re-entry never show a received or completed purchase", async () => {
      const cp = dictionaries[locale].creditsPage;
      window.history.replaceState(null, "", "/synthetic/credits?dodo=return&item=pack&status=failed");
      const first = await panel(locale);
      expect(screen.getByText(cp.cancelled)).toBeTruthy();
      expect(screen.queryByText(cp.packPaid)).toBeNull();
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      first.unmount(); vi.resetModules();
      await panel(locale);
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(screen.queryByText(cp.cancelled)).toBeNull();
      expect(screen.queryByText(cp.packPaid)).toBeNull();
      expect(screen.queryByText(cp.packArrived)).toBeNull();
      expect(mock.refresh).not.toHaveBeenCalled();
      noCalls();
    });
  });
}
