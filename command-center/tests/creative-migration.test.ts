import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migrations 0036 (creative jobs) and 0037 (provider costs): who may
// call what, that money moves only through 0020's functions, and that the
// model registry is never assumed to exist.

const root = join(__dirname, "..", "..", "supabase/migrations");
const J = readFileSync(join(root, "0036_creative_jobs.sql"), "utf8");
const C = readFileSync(join(root, "0037_provider_costs.sql"), "utf8");

function functions(sql: string): { name: string; header: string; body: string }[] {
  return [...sql.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/g)].map((m) => ({
    name: m[1],
    header: m[2],
    body: m[3],
  }));
}

function grantsFor(sql: string, name: string): string[] {
  return [...sql.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\)\\s+to ([a-z_, ]+);`, "g"))].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()),
  );
}

const USER = ["quote_creative_job", "create_creative_job", "cancel_creative_job"];
const SERVICE = ["claim_creative_job", "heartbeat_creative_job", "advance_creative_job", "finish_creative_job", "expire_creative_jobs"];

describe("0036 grants", () => {
  it("gives the member calls to signed-in users only (never anon)", () => {
    for (const fn of USER) expect(grantsFor(J, fn), fn).toEqual(["authenticated"]);
  });

  it("keeps the worker's calls to the service role", () => {
    for (const fn of SERVICE) expect(grantsFor(J, fn), fn).toEqual(["service_role"]);
  });

  it("grants nothing on the helpers — above all the two that act as the platform", () => {
    const granted = new Set([...USER, ...SERVICE]);
    for (const f of functions(J)) {
      if (granted.has(f.name)) continue;
      expect(grantsFor(J, f.name), f.name).toEqual([]);
      expect(J, f.name).toMatch(new RegExp(`revoke all on function public\\.${f.name}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
    expect(J).toMatch(/revoke all on function public\.creative_platform_reserve\(uuid, text, numeric\) from public, anon, authenticated, service_role;/);
    expect(J).toMatch(/revoke all on function public\.creative_platform_release\(text\) from public, anon, authenticated, service_role;/);
  });

  it("turns RLS on and lets no role write jobs or events directly", () => {
    for (const t of ["creative_jobs", "creative_job_events"]) {
      expect(J).toContain(`alter table public.${t} enable row level security;`);
      expect(J).not.toMatch(new RegExp(`grant (insert|update|delete)[^;]* on public\\.${t}\\b`));
    }
    expect(J).toMatch(/revoke all on public\.creative_jobs, public\.creative_job_events\s+from public, anon, authenticated, service_role;/);
    expect(J).toMatch(/grant select on public\.creative_jobs, public\.creative_job_events to authenticated, service_role;/);
    expect(J).not.toMatch(/to anon/);
  });

  it("scopes reads to members of the job's organization, with no customer role", () => {
    const policies = [...J.matchAll(/create policy (\w+) on public\.(\w+)[\s\S]*?;/g)].map((m) => m[0]);
    expect(policies).toHaveLength(2);
    for (const p of policies) expect(p).toContain("org_id in (select public.accessible_org_ids('viewer'))");
    // Membership checks name no role: is_org_member(org) with its default.
    const calls = [...J.matchAll(/public\.is_org_member\(([^)]*)\)/g)].filter((m) => !m[1].startsWith("uuid"));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const m of calls) expect(m[1], m[0]).not.toContain(",");
  });

  it("keeps the events log append-only", () => {
    expect(J).toMatch(/before update or delete on public\.creative_job_events/);
    expect(J).toMatch(/before truncate on public\.creative_job_events/);
  });
});

describe("0036 functions", () => {
  const fns = functions(J);

  it("are security definer only with a pinned search_path", () => {
    for (const f of fns) {
      if (/security definer/.test(f.header)) expect(f.header, f.name).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("never assume the model registry: every reference sits behind to_regclass", () => {
    // Outside function bodies (DDL the migration runs) there is none at all.
    const outside = J.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/--.*$/gm, "");
    expect(outside).not.toMatch(/model_registry/);
    const users = fns.filter((f) => /from public\.model_registry/.test(f.body));
    expect(users.map((f) => f.name)).toEqual(["creative_price"]);
    const body = users[0].body;
    expect(body.indexOf("to_regclass('public.model_registry') is null")).toBeGreaterThan(-1);
    expect(body.indexOf("to_regclass('public.model_registry') is null")).toBeLessThan(body.indexOf("from public.model_registry"));
    expect(body).toMatch(/creative_refuse\('registry_missing'/);
  });

  it("sells only a verified beta/ga model that lists the capability", () => {
    const body = fns.find((f) => f.name === "creative_price")!.body;
    expect(body).toMatch(/r\.availability in \('beta', 'ga'\)/);
    expect(body).toMatch(/r\.verified_at is not null/);
    expect(body).toMatch(/cap = any \(r\.capabilities\)/);
    expect(body).toMatch(/creative_refuse\('unpriced'/);
  });

  it("prices from credit_prices by the registry's unit — the client sends no number", () => {
    const body = fns.find((f) => f.name === "creative_price")!.body;
    expect(body).toMatch(/from public\.credit_prices where unit = m_unit/);
    const create = fns.find((f) => f.name === "create_creative_job")!;
    expect(create.header).not.toMatch(/p_price|p_credits\b|p_amount/);
    expect(create.body).toMatch(/price := \(q ->> 'credits'\)::numeric/);
  });

  it("create locks the account, then holds exactly the quote through reserve_credits", () => {
    const body = fns.find((f) => f.name === "create_creative_job")!.body;
    const lock = body.indexOf("perform public.credit_account_lock(p_org)");
    const reserve = body.indexOf("public.creative_platform_reserve(p_org, ref, price)");
    const insert = body.indexOf("insert into public.creative_jobs");
    expect(lock).toBeGreaterThan(-1);
    expect(reserve).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(reserve);
    expect(body).toMatch(/if p_max_credits is not null and price > p_max_credits then/);
    // The platform pays in the exempt org, and every pre-0018 account is a member of it.
    expect(body).toMatch(/if public\.credits_exempt\(p_org\) and not public\.is_platform_admin\(\) then/);
    const helper = fns.find((f) => f.name === "creative_platform_reserve")!.body;
    expect(helper).toMatch(/public\.reserve_credits\(p_org, p_ref, p_amount\)/);
    // The caller's claims are put back before anything else runs as them.
    expect(helper.indexOf("set_config('request.jwt.claims', coalesce(saved, ''), true)")).toBeGreaterThan(helper.indexOf("reserve_credits("));
  });

  it("settles through 0020 only: capture on success (never above the quote), release otherwise", () => {
    const finish = fns.find((f) => f.name === "finish_creative_job")!.body;
    expect(finish).toMatch(/public\.capture_credits\(j\.credit_ref, charge, false\)/);
    expect(finish).toMatch(/charge > j\.quoted_credits/);
    const end = fns.find((f) => f.name === "creative_end_locked")!.body;
    expect(end).toMatch(/public\.creative_platform_release\(j\.credit_ref\)/);
    expect(fns.find((f) => f.name === "creative_platform_release")!.body).toMatch(/public\.release_credits\(p_ref\)/);
    // Nothing in 0036 moves a balance itself.
    expect(J).not.toMatch(/update public\.credit_accounts/);
    expect(J).not.toMatch(/insert into public\.credit_(transactions|reservations)/);
  });

  it("never lets a resumed job be submitted twice", () => {
    const adv = fns.find((f) => f.name === "advance_creative_job")!.body;
    expect(adv).toMatch(/j\.submit_started_at is not null or j\.provider_task_id is not null then\s+return false/);
    const claim = fns.find((f) => f.name === "claim_creative_job")!.body;
    expect(claim).toMatch(/when j\.provider_task_id is not null then 'provider_pending'/);
    expect(claim).toMatch(/'submit_interrupted'/);
  });

  it("cross-org ids read as missing, not forbidden, on cancel", () => {
    const body = fns.find((f) => f.name === "cancel_creative_job")!.body;
    expect(body).toMatch(/if not found or not public\.is_org_member\(j\.org_id\) then\s+raise exception 'not_found' using errcode = 'P0002'/);
  });
});

describe("0037 provider costs", () => {
  it("is platform-admin only: the policy, the view's own filter, and security_invoker", () => {
    expect(C).toContain("alter table public.creative_job_costs enable row level security;");
    expect(C).toMatch(/create policy creative_job_costs_select on public\.creative_job_costs\s+for select to authenticated\s+using \(\(select public\.is_platform_admin\(\)\)\);/);
    expect(C).toMatch(/create or replace view public\.creative_economics\s+with \(security_invoker = true\)/);
    expect(C).toMatch(/where public\.is_platform_admin\(\);/);
    expect(C).not.toMatch(/accessible_org_ids|is_org_member/);
    expect(C).not.toMatch(/to anon/);
  });

  it("is written only by the worker, and never rewritten", () => {
    expect(grantsFor(C, "record_creative_job_cost")).toEqual(["service_role"]);
    expect(C).not.toMatch(/grant (insert|update|delete)[^;]* on public\.creative_job_costs/);
    expect(C).toMatch(/before update or delete on public\.creative_job_costs/);
  });

  it("never turns an unpriced cost into a number", () => {
    expect(C).toMatch(/usd_estimate is null or price_source is not null/);
    expect(C).toMatch(/when coalesce\(costs\.cost_rows, 0\) > 0 and costs\.unpriced_cost_rows = 0\s+then costs\.usd_priced end/);
  });
});
