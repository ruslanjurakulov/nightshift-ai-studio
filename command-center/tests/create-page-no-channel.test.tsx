/**
 * /create for an account with an organization and no channel at all: the
 * picture, clip and voice desks still render their composer (the link /welcome
 * and an empty Home offer them as "no channel needed"), and only the YouTube
 * desk is channel-bound. Calls the real page with its data layer scripted, so
 * a future change that gates a media desk on a channel fails here.
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});

const org = vi.hoisted(() => ({ current: { id: "org-1", is_default: false } as { id: string; is_default: boolean } | null }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: async () => ({ selection: "all-channels", channels: [] }) }));
vi.mock("@/lib/server/run-backend", () => ({ isRunNowConfigured: false, runBackend: "none" }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => false, resolveCurrentOrgRole: async () => "owner" }));
vi.mock("@/lib/connectedAccounts", () => ({ readConnectedAccounts: async () => [] }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: org.current }) }));
vi.mock("@/lib/server/creative", () => ({ loadStudioModels: async () => [] }));
vi.mock("@/lib/server/upsell", () => ({ loadUpsellCatalog: async () => null }));
vi.mock("@/lib/server/channel-dna", () => ({ channelDnaForCreate: async () => ({ withStudio: (p: unknown) => p, run: null, studio: null }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null }));
vi.mock("@/lib/server/credits", () => ({ readCreditAccount: async () => null }));
vi.mock("@/lib/server/editor", () => ({ loadEditorProjects: async () => ({ state: "not_available" }) }));

import CreatePage from "@/app/(app)/[channel]/create/page";

function names(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => names(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function") out.push((el.type as { name?: string }).name ?? "");
    names(el.props.children, out);
  }
  return out;
}

async function desks(query: Record<string, string>) {
  return names((await CreatePage({ searchParams: Promise.resolve(query) })) as ReactElement);
}

describe("/create with no channel", () => {
  for (const desk of ["image", "video", "voice"]) {
    it(`the ${desk} desk renders its composer, not a connect-a-channel wall`, async () => {
      const found = await desks({ desk });
      expect(found).toContain("GenerateSection");
      expect(found).not.toContain("YouTubeDesk");
    });
  }

  it("only the YouTube desk is the channel-bound one", async () => {
    const found = await desks({ desk: "youtube" });
    expect(found).toContain("YouTubeDesk");
    expect(found).not.toContain("GenerateSection");
  });

  it("without an open organization the media desk says so instead of rendering a composer nobody can bill", async () => {
    org.current = null;
    const found = await desks({ desk: "image" });
    expect(found).not.toContain("GenerateSection");
    org.current = { id: "org-1", is_default: false };
  });
});
