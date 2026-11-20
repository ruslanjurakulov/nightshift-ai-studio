/**
 * The automatic choice for a visitor in a country where some model may not be offered (docs/GEO_BLOCK.md).
 *
 * The database picks a model without knowing where the request comes from (route_model, migration 0075), and its failover list
 * (0088) can hold a model the visitor's country forbids. No migration tells it otherwise, so for such a visitor the web does two
 * things and nothing else:
 *
 *   - QUOTE. When the database's pick is one the country forbids, the same choice is made here among the models that remain:
 *     the web surface's sellable models for the capability, each priced by the database's own exact quote (never a number
 *     computed here), ranked by route_model's own rules. The answer has the routed quote's shape, so the page shows it the same way.
 *   - CREATE. The job is started in `exact` mode with the model the quote named. An exact job never fails over (0088), so no
 *     later step can move it onto a model the country forbids, and the database does not refuse a pick that is not its own.
 *
 * A visitor whose country is unknown, or where no model of the capability is forbidden, takes the database's path untouched.
 * tests/geo-route-around.test.ts pins the ranking against the SQL's text.
 */
import type { CreativeDb, CreativeResult, GenerationInput } from "@/lib/creative/operations";
import { quote } from "@/lib/creative/operations";

export type RoutedMode = "auto" | "cheap" | "fast" | "quality";

export interface RouteCandidate {
  model: string;
  credits: number;
  qualityTier: number;
  speedTier: number;
}

const tier = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 5) : 0);

/**
 * route_model's order (0075), key for key: cheap = price, then quality, then speed; fast = speed, then price, then quality;
 * quality = quality, then price, then speed; auto = a model of quality 4 or more first (then the cheapest of them, then the
 * fastest), else the highest quality (then price, then speed). The model id breaks every tie.
 */
export function rankCandidates(cands: readonly RouteCandidate[], mode: RoutedMode): RouteCandidate[] {
  const keys = (c: RouteCandidate): [number, number, number, number] => {
    if (mode === "cheap") return [c.credits, -c.qualityTier, -c.speedTier, 0];
    if (mode === "fast") return [-c.speedTier, c.credits, -c.qualityTier, 0];
    if (mode === "quality") return [-c.qualityTier, c.credits, -c.speedTier, 0];
    return [c.qualityTier >= 4 ? 0 : 1, c.qualityTier >= 4 ? 0 : -c.qualityTier, c.credits, -c.speedTier];
  };
  return [...cands].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}

/** Why the first of `ranked` was picked, in route_model's words. */
export function routeReason(ranked: readonly RouteCandidate[], mode: RoutedMode): string {
  if (ranked.length === 1) return "only_option";
  if (mode === "cheap") return "cheapest";
  if (mode === "fast") return "fastest";
  if (mode === "quality") return "best_quality";
  return ranked[0].qualityTier >= 4 ? "best_value" : "best_available";
}

interface Sellable {
  id: string;
  displayName: string;
  /** Registry inputs.prompt_required: the tools this model needs words for. */
  wordsRequired: string[];
  qualityTier: number;
  speedTier: number;
}

/** The web surface's sellable models for a capability, or null when the list could not be read. */
export async function sellableFor(db: CreativeDb, capability: string): Promise<Sellable[] | null> {
  const { data, error } = await db.rpc("sellable_models", { p_capability: capability, p_surface: "web" });
  if (error || !Array.isArray(data)) return null;
  const out: Sellable[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id) continue;
    const spec = row.spec && typeof row.spec === "object" && !Array.isArray(row.spec) ? (row.spec as Record<string, unknown>) : {};
    out.push({
      id: row.id,
      displayName: typeof row.display_name === "string" && row.display_name ? row.display_name : row.id,
      wordsRequired: wordsRequiredOf(spec),
      qualityTier: tier(spec.quality_tier),
      speedTier: tier(spec.speed_tier),
    });
  }
  return out;
}

function wordsRequiredOf(spec: Record<string, unknown>): string[] {
  const inputs = spec.inputs && typeof spec.inputs === "object" && !Array.isArray(spec.inputs) ? (spec.inputs as Record<string, unknown>) : {};
  return Array.isArray(inputs.prompt_required) ? inputs.prompt_required.filter((c): c is string => typeof c === "string") : [];
}

/**
 * Rule 6, fail early: a model that needs words for this tool (registry inputs.prompt_required, e.g. MiniMax H3's
 * image-to-video) is refused at the quote and at the create when none were sent, with the reason named — not created and
 * then refused by the adapter as "settings were not accepted". Words present: nothing is read. The model list cannot be
 * read: null (the check cannot be made here; the adapter still refuses and the hold is released, so nothing is charged).
 */
export async function missingWords(
  db: CreativeDb,
  capability: string,
  model: string,
  params: Record<string, unknown>,
): Promise<CreativeResult | null> {
  if (!model) return null;
  // Invisible characters (zero-width spaces, BOM) are not words: trim() leaves them, so they are removed first.
  if (typeof params.prompt === "string" && params.prompt.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim() !== "") return null;
  const sellable = await sellableFor(db, capability);
  const m = sellable?.find((x) => x.id === model);
  if (!m || !m.wordsRequired.includes(capability)) return null;
  return { status: 422, body: { error: "prompt_required", detail: `${m.displayName} needs words for ${capability}`, model: m.id } };
}

/**
 * The routed quote among the models `isBlocked` lets through. 451 `country_blocked` when none of them can be priced: the only
 * models that could make this are not offered here. Every price is the database's exact quote for that model.
 */
export async function quoteAround(db: CreativeDb, input: GenerationInput, isBlocked: (model: string) => boolean): Promise<CreativeResult> {
  const mode = input.mode as RoutedMode;
  const sellable = await sellableFor(db, input.capability);
  if (!sellable) return { status: 502, body: { error: "failed" } };
  const open = sellable.filter((m) => !isBlocked(m.id));
  const quotes = new Map<string, Record<string, unknown>>();
  const cands: RouteCandidate[] = [];
  // 0199: the database refuses an adult-only model (and every model for someone who said they are under 18) at the exact quote,
  // which is how route_model excludes them. Those refusals are kept, so the answer names the age, not the country.
  let adultRefusal: CreativeResult | null = null;
  for (const m of open) {
    const out = await quote(db, { ...input, mode: "exact", model: m.id });
    const code = (out.body as { error?: unknown }).error;
    if (code === "adult_only_service") return out;
    if (code === "adult_attestation_required") adultRefusal = out;
    const q = out.status === 200 ? (out.body.quote as Record<string, unknown> | undefined) : undefined;
    // route_model's rule: priced for these settings and this organization, above zero, or not a candidate.
    if (!q || typeof q.credits !== "number" || !(q.credits > 0)) continue;
    quotes.set(m.id, q);
    cands.push({ model: m.id, credits: q.credits, qualityTier: m.qualityTier, speedTier: m.speedTier });
  }
  if (cands.length === 0) return adultRefusal ?? { status: 451, body: { error: "country_blocked" } };
  const ranked = rankCandidates(cands, mode);
  const top = ranked[0];
  const picked = open.find((m) => m.id === top.model)!;
  // The routed quote's shape (creative_route_quote): the price, never the platform's rate behind it.
  const { margin: _margin, credits_per_unit: _rate, ...shown } = quotes.get(top.model)!;
  void _margin;
  void _rate;
  return {
    status: 200,
    body: {
      quote: {
        ...shown,
        mode,
        routed_model: top.model,
        route_reason: routeReason(ranked, mode),
        display_name: picked.displayName,
        quality_tier: top.qualityTier,
        speed_tier: top.speedTier,
      },
    },
  };
}
