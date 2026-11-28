/**
 * Breach, PR #958: the PR says no RSC payload sent to a non-operator carries the starter -> model pairs (which registry model
 * each "Start from an example" card was written for, lib/server/creative-examples.ts EXAMPLE_MODELS, server-only because
 * "the pairing is our routing"). The Create page hands them to StudioHome as `exampleModels` with no operator check, and a
 * CUSTOMER reaches StudioHome on the overview through the public home page's file hand-off: `/create?attach=<32 hex>`
 * (drawsCreateScreen is false when a pending file is named). The pairs are then in that customer's flight data.
 *
 * Calls the real page with its data layer scripted (the harness of tests/create-page-no-channel.test.tsx): a customer
 * (isOperator false) in their own organization, offered two of the models the examples were written for.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ selection: "all-channels", channels: [] }) }));
vi.mock("@/lib/server/run-backend", () => ({ isRunNowConfigured: false, runBackend: "none" }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => false, resolveCurrentOrgRole: async () => "owner" }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: { id: "org-customer", is_default: false } }) }));
// Two models a paying customer is offered on the Studio, and that two examples were written for (EXAMPLE_MODELS).
vi.mock("@/lib/server/creative", () => ({
  loadStudioModels: async () => [
    { id: "veo-3.1-fast", name: "Veo 3.1 Fast", capabilities: ["t2v"] },
    { id: "kling-v3", name: "Kling v3", capabilities: ["t2v", "i2v"] },
  ],
  loadSwitchedOffModels: async () => [],
  loadOperatorPreviewModels: async () => [],
}));
vi.mock("@/lib/server/upsell", () => ({ loadUpsellCatalog: async () => null }));
vi.mock("@/lib/server/channel-dna", () => ({ channelDnaForCreate: async () => ({ withStudio: (p: unknown) => p, run: null, studio: null }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null, getUser: async () => null }));
vi.mock("@/lib/server/credits", () => ({ readCreditAccount: async () => null }));
vi.mock("@/lib/server/editor", () => ({ loadEditorProjects: async () => ({ state: "not_available" }) }));

import CreatePage from "@/app/(app)/[channel]/create/page";

function find(node: ReactNode, name: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, name);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode } & Record<string, unknown>>;
    if (typeof el.type === "function" && (el.type as { name?: string }).name === name) return el;
    return find(el.props.children, name);
  }
  return null;
}

describe("breach #958: starter -> model pairs reach a customer's Create page", () => {
  it("a customer opening /create?attach=<nonce> gets StudioHome (the hand-off path) — control", async () => {
    const tree = (await CreatePage({ searchParams: Promise.resolve({ attach: "0123456789abcdef0123456789abcdef" }) })) as ReactElement;
    expect(find(tree, "StudioHome")).not.toBeNull();
  });

  it("and its props carry no example -> model pair (exampleModels is the operator's routing)", async () => {
    const tree = (await CreatePage({ searchParams: Promise.resolve({ attach: "0123456789abcdef0123456789abcdef" }) })) as ReactElement;
    const home = find(tree, "StudioHome");
    // Today: { mountain_drone: "veo-3.1-fast", tea_pour: "kling-v3", city_night: "veo-3.1-fast" } for this customer.
    expect(home?.props.exampleModels ?? {}).toEqual({});
  });
});
