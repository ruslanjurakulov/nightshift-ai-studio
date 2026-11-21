// @vitest-environment jsdom
/**
 * The Channels page's connected accounts after the move to Instagram API with Unified Login (0205): an Instagram row
 * connected the old way still says "connected" in the table, but its token can never post again, so the panel shows it
 * as "reconnect needed" with the remedy. It is kept, never hidden or deleted. TikTok rows are unaffected.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { SocialAccountsPanel } from "@/components/social/SocialAccountsPanel";
import type { SocialAccount } from "@/lib/social-accounts";

const row = (over: Partial<SocialAccount>): SocialAccount => ({
  id: "a1",
  org_id: "org",
  platform: "instagram",
  external_id: "17841400000000001",
  username: "brand",
  display_name: null,
  avatar_url: null,
  status: "connected",
  scopes: [],
  connected_at: null,
  connected_by_email: null,
  revoked_at: null,
  auth_flow: null,
  ...over,
});

function panel(locale: Locale, accounts: SocialAccount[]) {
  return render(
    <I18nProvider locale={locale}>
      <SocialAccountsPanel
        accounts={accounts}
        available
        hasOrg
        role="editor"
        configured={{ instagram: true, tiktok: true }}
        result={null}
      />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("an old Instagram Login connection", () => {
  it.each(["en", "ru", "uz"] as const)("%s: reads 'reconnect needed' with the remedy, and stays listed", (locale) => {
    const ts = dictionaries[locale].socialAccounts;
    panel(locale, [row({})]);
    expect(screen.getByText("@brand")).toBeTruthy();
    expect(screen.getByText(ts.instagramReconnect)).toBeTruthy();
    expect(screen.getAllByText(ts.expired).length).toBeGreaterThan(0);
    expect(screen.queryByText(ts.connected)).toBeNull();
  });
  it("a Unified Login connection and a TikTok one read connected, with no reconnect note", () => {
    const ts = dictionaries.en.socialAccounts;
    panel("en", [row({ auth_flow: "unified_login" }), row({ id: "t1", platform: "tiktok", external_id: "oid", username: "tt" })]);
    expect(screen.getAllByText(ts.connected)).toHaveLength(2);
    expect(screen.queryByText(ts.instagramReconnect)).toBeNull();
  });
});
