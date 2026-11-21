/**
 * creativeDb (lib/server/creative.ts): a Film Studio take's job (payer 'film', migrations 0171 and 0198) never reaches the Studio's
 * feed, its job page or its duration estimate. What would break without this: a film's takes listed as 0-credit generations (rule 5),
 * each with a Cancel button that is not the person's to press (Sentinel L3 / N1 on #853), and a narration that voiced a whole film
 * read as one generation's time.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null, getUser: async () => null }));
vi.mock("@/lib/server/model-switch", () => ({ readSwitchedOffIds: async () => [] }));
vi.mock("@/lib/server/geo", () => ({ hideBlockedModelsHere: async <T,>(m: T[]) => m }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: async () => ({ supported: true, current: null }) }));

const { creativeDb } = await import("../lib/server/creative");

type Call = [string, ...unknown[]];

/** A PostgREST query builder that records every filter, and answers the rows it is given filtered by eq/neq/in as PostgREST would. */
function fakeSupabase(rows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      let out = rows.slice();
      const q: Record<string, unknown> = {};
      const chain = (name: string, f?: (...a: unknown[]) => void) => (...a: unknown[]) => {
        calls.push([name, ...a]);
        f?.(...a);
        return q;
      };
      q.select = chain("select");
      q.eq = chain("eq", (k, v) => { out = out.filter((r) => r[k as string] === v); });
      q.neq = chain("neq", (k, v) => { out = out.filter((r) => r[k as string] !== v); });
      q.in = chain("in", (k, v) => { out = out.filter((r) => (v as unknown[]).includes(r[k as string])); });
      for (const m of ["not", "or", "order", "limit"]) q[m] = chain(m);
      q.maybeSingle = async () => ({ data: out[0] ?? null, error: null });
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: out, error: null }).then(res, rej);
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, calls };
}

const ORG = "0a000000-0000-4000-8000-00000000000a";
const studio = { id: "j1", org_id: ORG, payer: "credits", capability: "i2v", status: "completed" };
const film = { id: "j2", org_id: ORG, payer: "film", capability: "i2v", status: "completed" };

describe("a film take's job in the Studio's reads", () => {
  it("is left out of the feed, the job page and the duration estimate", async () => {
    const { client, calls } = fakeSupabase([studio, film]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = creativeDb(client as any);
    const feed = await db.listJobs(ORG, 50);
    expect((feed.data as { id: string }[]).map((r) => r.id)).toEqual(["j1"]);
    expect((await db.readJob("j2")).data).toBeNull();
    expect((await db.readJob("j1")).data).toMatchObject({ id: "j1" });
    if (!db.jobDurations) throw new Error("creativeDb has no jobDurations");
    await db.jobDurations(ORG, "vid-clip", 20);
    expect(calls.filter((c) => c[0] === "neq" && c[1] === "payer" && c[2] === "film")).toHaveLength(4);
  });

  it("is left out of a desk's own feed too", async () => {
    const { client } = fakeSupabase([studio, film]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feed = await creativeDb(client as any).listJobs(ORG, 50, ["i2v"]);
    expect((feed.data as { id: string }[]).map((r) => r.id)).toEqual(["j1"]);
  });
});
