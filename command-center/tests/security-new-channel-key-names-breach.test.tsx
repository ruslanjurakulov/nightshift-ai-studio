/**
 * Breach, PR #958: the PR says no RSC payload sent to a non-operator carries a secret NAME (GEMINI_API_KEY, …). The
 * new-channel page now hands the wizard `keyNames` = { GEMINI_API_KEY, PEXELS_API_KEY, ELEVENLABS_API_KEY } from
 * lib/providers.ts (server-only) — for EVERY signed-in viewer, with no operator check. A customer opening
 * /{channel}/channels/new gets the three names in the page's flight data (they were in a static chunk before; now they are
 * in the customer's props). A customer can never use them: the only consumer, POST /api/setup/secrets, refuses anyone but a
 * platform admin (requireRole("admin") is the PLATFORM role).
 *
 * The YouTube secret names in the wizard are out of scope (the caller's brief); these three vendor keys are not.
 * Calls the real page with its data layer scripted: a customer, admin of their own (non-default) organization.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/qa${p}` }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-customer", is_default: false } }) }));
vi.mock("@/lib/auth/org-roles", () => ({ resolveCurrentOrgRole: async () => "owner", isOperator: async () => false }));
// No platform role: a customer.
vi.mock("@/lib/auth/roles", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/roles")>()), requireRole: async () => null }));
vi.mock("@/lib/server/google-oauth", () => ({ isGoogleOAuthConfigured: true }));
vi.mock("@/lib/server/social-oauth", () => ({ socialConnectOpen: () => false }));

import NewChannelPage from "@/app/(app)/[channel]/channels/new/page";

const VENDOR_KEY_NAME = /\b(GEMINI_API_KEY|PEXELS_API_KEY|ELEVENLABS_API_KEY)\b/;

function propsOf(node: ReactNode, name: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = propsOf(n, name);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode } & Record<string, unknown>>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === name) return el.props;
    return propsOf(el.props.children, name);
  }
  return null;
}

describe("breach #958: vendor secret names reach a customer's new-channel page", () => {
  it("the wizard is drawn for a customer — control", async () => {
    const tree = (await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    expect(propsOf(tree, "AddChannelWizard")).not.toBeNull();
  });

  it("and nothing in its props names a vendor key's GitHub secret", async () => {
    const tree = (await NewChannelPage({ searchParams: Promise.resolve({}) })) as ReactElement;
    const props = propsOf(tree, "AddChannelWizard") ?? {};
    // Today: keyNames = { gemini: "GEMINI_API_KEY", pexels: "PEXELS_API_KEY", eleven: "ELEVENLABS_API_KEY" }.
    expect(JSON.stringify(props)).not.toMatch(VENDOR_KEY_NAME);
  });
});
