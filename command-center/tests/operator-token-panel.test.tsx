// @vitest-environment jsdom
/**
 * The operator's channel card: Connect YouTube / Reconnect with the status the bot reported (migration 0115).
 *
 * What would break without these: a Disconnect button on the channel the bot publishes with; a dead token shown
 * green; a non-admin offered a button the route would refuse; a customer's panel changing; a page that fails axe
 * or lacks Russian / Uzbek words.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import axe from "axe-core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ChannelTokenPanel, type ChannelTokenPanelProps } from "@/components/channels/ChannelTokenPanel";

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];
const status = (over = {}) => ({
  channel_id: "default",
  connected: true,
  youtube_channel_id: "UCchronos",
  youtube_channel_title: "Chronos",
  google_account_email: null,
  scopes: SCOPES,
  connected_at: "2026-10-21T10:00:00Z",
  connected_by_email: "owner@example.com",
  revoked_at: null,
  ...over,
});
const panel = (over: Partial<ChannelTokenPanelProps> = {}, locale: "en" | "ru" | "uz" = "en"): ReactNode => (
  <I18nProvider locale={locale}>
    <ChannelTokenPanel
      channelId="default"
      status={null}
      available
      role="admin"
      oauthConfigured
      requiredScopes={SCOPES}
      operator
      operatorState="not_connected"
      {...over}
    />
  </I18nProvider>
);
const tt = dictionaries.en.channelTokens;

afterEach(cleanup);

describe("operator channel panel", () => {
  it("offers Connect YouTube, pointing at the existing start route with the channel's own id", () => {
    render(panel());
    const link = screen.getByRole("link", { name: tt.connect });
    expect(link.getAttribute("href")).toBe("/api/oauth/youtube/start?ref=default");
    expect(screen.queryByRole("button", { name: tt.disconnect })).toBeNull();
    expect(screen.getByText(tt.notConnected)).toBeTruthy();
  });

  it("shows connected with Reconnect and no Disconnect", () => {
    render(panel({ status: status(), operatorState: "connected" }));
    expect(screen.getByText(tt.connected)).toBeTruthy();
    expect(screen.getByRole("link", { name: tt.reconnect })).toBeTruthy();
    expect(screen.queryByRole("button", { name: tt.disconnect })).toBeNull();
    expect(screen.getByText(tt.operatorNote)).toBeTruthy();
  });

  it("shows a dead token as expired, with the remedy and Reconnect, even though a connection is on file", () => {
    render(panel({ status: status(), operatorState: "expired" }));
    expect(screen.getByText(tt.expired)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(tt.expiredHint);
    expect(screen.getByRole("link", { name: tt.reconnect })).toBeTruthy();
    expect(screen.queryByText(tt.connected)).toBeNull();
  });

  it("says a refused OAuth client needs a new client, not a Reconnect, as the headline", () => {
    render(panel({ status: status(), operatorState: "needs_client" }));
    expect(screen.getByText(tt.needsClient)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(tt.needsClientHint);
    expect(screen.queryByText(tt.expired)).toBeNull();
  });

  it("tells the old-secret connection how to move, without calling it expired", () => {
    render(panel({ status: null, operatorState: "connected" }));
    expect(screen.getByText(tt.viaSecret)).toBeTruthy();
    expect(screen.getByRole("link", { name: tt.reconnect })).toBeTruthy();
  });

  it("gives a non-admin no button", () => {
    render(panel({ role: "viewer", status: status(), operatorState: "connected" }));
    expect(screen.queryByRole("link", { name: tt.reconnect })).toBeNull();
    expect(screen.getByText(tt.viewerHint)).toBeTruthy();
  });

  it("keeps a customer's panel as it was: Disconnect offered, no operator words", () => {
    render(panel({ operator: false, operatorState: undefined, status: status() }));
    expect(screen.getByRole("button", { name: tt.disconnect })).toBeTruthy();
    expect(screen.getByText(tt.vaultNote)).toBeTruthy();
    expect(screen.queryByText(tt.operatorNote)).toBeNull();
  });

  it("has the new words in all three languages and passes axe in each", async () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const d = dictionaries[locale].channelTokens;
      for (const key of ["expired", "expiredHint", "needsClient", "needsClientHint", "viaSecret", "operatorNote"] as const) {
        expect(d[key].length).toBeGreaterThan(5);
        if (locale !== "en") expect(d[key]).not.toBe(dictionaries.en.channelTokens[key]);
      }
      const { container, unmount } = render(panel({ status: status(), operatorState: "expired" }, locale));
      const results = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
      expect(results.violations.map((v) => v.id)).toEqual([]);
      unmount();
    }
  });
});
