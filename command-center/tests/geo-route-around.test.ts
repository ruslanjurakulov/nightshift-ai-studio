/**
 * The automatic choice made again by the web for a visitor whose country forbids the database's pick (lib/creative/route-around.ts,
 * docs/GEO_BLOCK.md).
 *
 * What would break without these: the web ranking models by another rule than route_model (migration 0075), so the same press picks a
 * different model depending on where the visitor is; a later migration changing route_model's order with this port left behind; a
 * candidate the database cannot price, or prices at zero, being offered; and the reason shown not being the one the order used.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rankCandidates, routeReason, type RouteCandidate, type RoutedMode } from "@/lib/creative/route-around";

const c = (model: string, credits: number, qualityTier: number, speedTier: number): RouteCandidate => ({ model, credits, qualityTier, speedTier });
const order = (cands: RouteCandidate[], mode: RoutedMode) => rankCandidates(cands, mode).map((x) => x.model);

describe("the order, mode by mode (route_model's)", () => {
  const cands = [c("a-cheap", 2, 2, 3), c("b-fine", 9, 5, 2), c("c-fast", 5, 3, 5), c("d-good", 6, 4, 4), c("e-good-slow", 6, 4, 1)];

  it("cheap: the lowest price, then the higher quality, then the faster", () => {
    expect(order(cands, "cheap")).toEqual(["a-cheap", "c-fast", "d-good", "e-good-slow", "b-fine"]);
    expect(order([c("x", 3, 2, 1), c("y", 3, 4, 1), c("z", 3, 4, 5)], "cheap")).toEqual(["z", "y", "x"]);
  });

  it("fast: the fastest, then the lower price, then the higher quality", () => {
    expect(order(cands, "fast")).toEqual(["c-fast", "d-good", "a-cheap", "b-fine", "e-good-slow"]);
    expect(order([c("x", 5, 1, 4), c("y", 3, 1, 4), c("z", 3, 3, 4)], "fast")).toEqual(["z", "y", "x"]);
  });

  it("quality: the highest quality, then the lower price, then the faster", () => {
    expect(order(cands, "quality")).toEqual(["b-fine", "d-good", "e-good-slow", "c-fast", "a-cheap"]);
  });

  it("auto: a model of quality 4 or more first (the cheapest of them, then the fastest), else the highest quality", () => {
    expect(order(cands, "auto")).toEqual(["d-good", "e-good-slow", "b-fine", "c-fast", "a-cheap"]);
    // Below 4 everywhere: the highest quality wins, whatever it costs.
    expect(order([c("x", 1, 2, 5), c("y", 8, 3, 1)], "auto")).toEqual(["y", "x"]);
  });

  it("an exact tie is broken by the model id, so the same press always picks the same model", () => {
    for (const mode of ["cheap", "fast", "quality", "auto"] as const) {
      expect(order([c("m-b", 4, 4, 4), c("m-a", 4, 4, 4)], mode)).toEqual(["m-a", "m-b"]);
    }
  });

  it("names the reason the order used", () => {
    expect(routeReason(rankCandidates([cands[0]], "cheap"), "cheap")).toBe("only_option");
    expect(routeReason(rankCandidates(cands, "cheap"), "cheap")).toBe("cheapest");
    expect(routeReason(rankCandidates(cands, "fast"), "fast")).toBe("fastest");
    expect(routeReason(rankCandidates(cands, "quality"), "quality")).toBe("best_quality");
    expect(routeReason(rankCandidates(cands, "auto"), "auto")).toBe("best_value");
    expect(routeReason(rankCandidates([c("x", 1, 2, 5), c("y", 8, 3, 1)], "auto"), "auto")).toBe("best_available");
  });
});

describe("the SQL this is a port of", () => {
  // The latest migration that defines route_model: if a later one changes the order, this fails until the port is read against it.
  const dir = join(__dirname, "..", "..", "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => readFileSync(join(dir, f), "utf8").includes("create or replace function public.route_model(")).at(-1)!;
  const sql = readFileSync(join(dir, latest), "utf8").replace(/\s+/g, " ");

  it("is still migration 0075's route_model (as 0192 re-states it, the 18+ exclusion added), with the order this port copies", () => {
    // 0192 replaced the body with 0075's plus marked blocks that skip an adult-only candidate; the order is unchanged.
    expect(latest).toBe("0192_adult_attestation.sql");
    expect(sql).toContain("if public.adult_attestation_missing(auth.uid(), m) then");
    for (const piece of [
      "order by x.k1, x.k2, x.k3, x.k4, x.e ->> 'model'",
      "case md when 'cheap' then (e ->> 'credits')::numeric when 'fast' then -(e ->> 'speed_tier')::numeric when 'quality' then -(e ->> 'quality_tier')::numeric else case when (e ->> 'quality_tier')::numeric >= 4 then 0 else 1 end end as k1",
      "case md when 'cheap' then -(e ->> 'quality_tier')::numeric when 'fast' then (e ->> 'credits')::numeric when 'quality' then (e ->> 'credits')::numeric else case when (e ->> 'quality_tier')::numeric >= 4 then 0 else -(e ->> 'quality_tier')::numeric end end as k2",
      "case md when 'cheap' then -(e ->> 'speed_tier')::numeric when 'fast' then -(e ->> 'quality_tier')::numeric when 'quality' then -(e ->> 'speed_tier')::numeric else (e ->> 'credits')::numeric end as k3",
      "case md when 'auto' then -(e ->> 'speed_tier')::numeric else 0 end as k4",
      "if c is null or c <= 0 then continue;",
      "when (top ->> 'quality_tier')::numeric >= 4 then 'best_value' else 'best_available' end",
      "least(greatest((sp ->> 'quality_tier')::numeric, 0), 5) else 0 end",
    ]) {
      expect([piece, sql.includes(piece)]).toEqual([piece, true]);
    }
  });

  it("and an exact job still never fails over (the reason a visitor in such a country gets one)", () => {
    const failover = files.filter((f) => readFileSync(join(dir, f), "utf8").includes("create or replace function public.reroute_creative_job(")).at(-1)!;
    const body = readFileSync(join(dir, failover), "utf8").replace(/\s+/g, " ");
    expect(body).toContain("if j.mode = 'exact' or j.routing is null then return null; end if;");
  });
});
