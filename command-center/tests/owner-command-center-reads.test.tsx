import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's glance strip reads provider balances, worker heartbeats, alerts and the held-video count.
 * Those are the platform's own: a customer opening the Command Center must not trigger any of them
 * (nor see the strip). The page is called directly with its data layer replaced by a recorder.
 */
const tables: string[] = [];
let operatorNow = false;

function builder(table: string): unknown {
  const b: unknown = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      // A count-only read (select(..., { count, head: true })) is recorded apart: it is the held-video count.
      if (prop === "select") return (_cols: string, opts?: { head?: boolean }) => (opts?.head && tables.push(`${table}#count`), b);
      return () => b;
    },
    apply: () => b,
  });
  return b;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      tables.push(table);
      return builder(table);
    },
  }),
  getUser: async () => ({ id: "u1" }),
}));
vi.mock("@/lib/i18n/server", async () => {
  const { dictionaries } = await import("@/lib/i18n");
  return { getDictionary: async () => ({ locale: "en", t: dictionaries.en }) };
});
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/channels-server", async () => {
  const { unscopedScope, ALL_CHANNELS } = await import("@/lib/channels");
  return {
    getChannelContext: async () => ({ selection: ALL_CHANNELS, channels: [], scope: unscopedScope() }),
    fetchScopedVideoIds: async () => null,
    fetchTopicScores: async () => [],
  };
});
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: false, orgs: [], current: null }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => operatorNow, resolveCurrentOrgRole: async () => "viewer" }));
vi.mock("@/lib/server/run-backend", () => ({ isRunNowConfigured: false }));

const GLANCE_TABLES = ["provider_balances", "worker_status", "alert_events", "videos#count", "alert_events#count"];

/** Does the returned React element tree contain a component with this name? (Walks children, not rendering.) */
function hasComponent(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((n) => hasComponent(n, name));
  if (!node || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (typeof el.type === "function" && (el.type as { name?: string }).name === name) return true;
  return hasComponent(el.props?.children, name);
}

async function run(operator: boolean) {
  operatorNow = operator;
  tables.length = 0;
  const { default: CommandCenter } = await import("../app/(app)/[channel]/command-center/page");
  const tree = await CommandCenter();
  return { tables: [...tables], hasStrip: hasComponent(tree, "OwnerGlance") };
}

beforeEach(() => {
  tables.length = 0;
});

describe("Command Center reads for the glance strip", () => {
  it("runs them for the operator (positive control: the recorder sees the reads and the strip is rendered)", async () => {
    const { tables: seen, hasStrip } = await run(true);
    for (const t of GLANCE_TABLES) expect(seen, t).toContain(t);
    expect(seen).toContain("videos");
    expect(hasStrip).toBe(true);
  });

  it("runs none of them for a customer, and renders no strip", async () => {
    const { tables: seen, hasStrip } = await run(false);
    for (const t of GLANCE_TABLES) expect(seen, t).not.toContain(t);
    // The page's own reads still happen; the held-video COUNT read is the glance's, the list reads are not.
    expect(seen).toContain("system_events");
    expect(hasStrip).toBe(false);
  });
});
