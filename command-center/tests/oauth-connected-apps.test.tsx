// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("@/lib/i18n/en");
  return { useI18n: () => ({ t: en, locale: "en" }) };
});

import { ConnectedApps } from "@/components/developers/ConnectedApps";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Connected apps", () => {
  it("the Disconnect confirmation names the app as cleaned text, never its raw characters", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "oauth_my_grants"
        ? {
            data: [{ id: "g1", client_name: "Evil‮ gnp.exe​ App", redirect_uris: ["https://a.example.com/cb"], scopes: ["videos:read"], created_at: "2026-10-01T00:00:00Z", last_used_at: null, monthly_limit_credits: 100, spent_this_month_credits: 0, status: "active" }],
            error: null,
          }
        : { data: true, error: null },
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConnectedApps />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const shown = String(confirm.mock.calls[0][0]);
    expect(shown).toContain("Evil gnp.exe App");
    expect(shown).not.toMatch(/[‮​]/);
    expect(rpc).not.toHaveBeenCalledWith("oauth_revoke_grant", expect.anything());
  });
});
