import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Pins on migration 0031: who may call what, and that every entry point
// starts from the key.

const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0031_public_api.sql"), "utf8");

function functions(): { name: string; body: string; header: string }[] {
  return [...SQL.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\$\$([\s\S]*?)\$\$;/g)].map((m) => ({
    name: m[1],
    header: m[2],
    body: m[3],
  }));
}

const ENTRY = [
  "api_auth",
  "api_balance",
  "api_create_video",
  "api_get_job",
  "api_list_videos",
  "api_get_video",
  "api_request_publish",
  "api_list_channels",
  "api_list_connected_accounts",
  "api_request_download",
  "api_get_download",
];
const CONSOLE = ["api_activate", "api_set_monthly_limit", "create_api_key", "revoke_api_key", "set_api_key_limit", "api_console", "api_usage"];
const SERVICE = ["api_add_topup", "api_refund_topup", "api_hold_start"];

function grantsFor(name: string): string[] {
  return [...SQL.matchAll(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ([a-z_, ]+);`, "g"))].flatMap((m) =>
    m[1].split(",").map((s) => s.trim()),
  );
}

describe("0031 grants", () => {
  it("gives the API entry points to anon only", () => {
    for (const fn of ENTRY) expect(grantsFor(fn), fn).toEqual(["anon"]);
  });

  it("gives the console functions to signed-in users only", () => {
    for (const fn of CONSOLE) expect(grantsFor(fn), fn).toEqual(["authenticated"]);
  });

  it("keeps money-in and the worker's check to the service role", () => {
    for (const fn of SERVICE) expect(grantsFor(fn), fn).toEqual(["service_role"]);
  });

  it("grants nothing on the internal helpers", () => {
    const granted = new Set([...ENTRY, ...CONSOLE, ...SERVICE, "api_adjust_balance"]);
    for (const f of functions()) {
      if (granted.has(f.name)) continue;
      expect(grantsFor(f.name), f.name).toEqual([]);
      expect(SQL, f.name).toMatch(new RegExp(`revoke all on function public\\.${f.name}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
  });

  it("never lets anyone read a key's hash", () => {
    const m = /grant select \(([^)]*)\)\s+on public\.api_keys/.exec(SQL);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("key_hash");
    expect(SQL).not.toMatch(/grant select on public\.api_keys\b/);
  });

  it("turns RLS on for every new table and lets no role write them directly", () => {
    for (const t of ["api_settings", "api_accounts", "api_ledger", "api_holds", "api_prices", "api_keys", "api_rate_counters", "api_requests", "api_idempotency"]) {
      expect(SQL).toContain(`alter table public.${t} enable row level security;`);
      expect(SQL).not.toMatch(new RegExp(`grant (insert|delete)[^;]* on public\\.${t}\\b`));
    }
  });
});

describe("0031 functions", () => {
  const fns = functions();

  it("are all security definer with a pinned search_path (or plain helpers)", () => {
    for (const f of fns) {
      expect(f.header, f.name).toMatch(/set search_path = public, pg_temp/);
    }
  });

  it("start every entry point from the key: api_begin first, and stop when it refuses", () => {
    for (const name of ENTRY) {
      const f = fns.find((x) => x.name === name)!;
      expect(f, name).toBeDefined();
      expect(f.body, name).toMatch(/ctx\s+jsonb := public\.api_begin\(p_key_hash, '[a-z_.]+', p_request_id\);/);
      expect(f.body, name).toMatch(/if not \(ctx ->> 'ok'\)::boolean then\s+return ctx;/);
    }
  });

  it("scope every read to the key's organization", () => {
    for (const name of ["api_get_job", "api_list_videos", "api_get_video", "api_list_channels", "api_list_connected_accounts", "api_get_download"]) {
      expect(fns.find((x) => x.name === name)!.body, name).toContain("(ctx ->> 'org_id')::uuid");
    }
  });

  it("accept only the params 0019 lets a browser queue, through render_job_params_valid", () => {
    const f = fns.find((x) => x.name === "api_create_video")!;
    expect(f.body).toContain("array['topic','niche','duration','language','visual_style',\n                     'video_provider','image_provider']");
    expect(f.body).toContain("public.render_job_params_valid(v_p, 'daily')");
    expect(f.body).not.toMatch(/'privacy'|'resume'|'repair_scenes'/);
  });

  it("publish through 0029's insert trigger, never around it", () => {
    const f = fns.find((x) => x.name === "api_request_publish")!;
    expect(f.body).toContain("insert into public.publish_requests (video_id, account_id)");
    expect(f.body).toContain("insert into public.publish_requests (video_id, target_channel_id)");
    expect(f.body).not.toContain("'queued'");
  });

  it("act as the creator with the claims' role left alone", () => {
    const f = fns.find((x) => x.name === "api_act_as")!;
    expect(f.body).toContain("set_config('request.jwt.claims', v_claims::text, true)");
    expect(f.body).not.toMatch(/'role'/);
  });

  it("never redefine render_job_params_valid (tests/test_queue_worker.py reads the latest definition)", () => {
    expect(SQL).not.toContain("function public.render_job_params_valid");
  });

  it("hold money before queuing and settle it only from the job's own end", () => {
    const f = fns.find((x) => x.name === "api_create_video")!;
    expect(f.body.indexOf("insert into public.api_holds")).toBeLessThan(f.body.indexOf("insert into public.render_jobs"));
    expect(SQL).toContain("create trigger render_jobs_api_settle after update of status on public.render_jobs");
    expect(SQL).toContain("create trigger download_requests_api_settle after update of status on public.download_requests");
  });
});
