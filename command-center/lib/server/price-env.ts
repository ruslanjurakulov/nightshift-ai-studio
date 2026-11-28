import "server-only";

/**
 * Our pipeline's cost and pricing configuration names. Server-only: the names are our infrastructure's, which no customer
 * can set and the site must not show (scripts/vendor-bundle-check.mjs reads them from here and fails a build whose static
 * chunks carry one). The dictionary says only that a price is not set; lib/server/price-config-hints.ts names them to the
 * operator.
 */

/** The prefix of the per-unit cost variables modules/cost_ledger.py reads (price_env_var()). */
export const PRICE_ENV_PREFIX = "CHRONOS_PRICE_";

/** The sponsor CPM in USD that prices a sponsorship slot (modules/sponsorship.py _CPM_ENV). */
export const SPONSORSHIP_CPM_ENV = "CHRONOS_SPONSORSHIP_CPM_USD";

/** The env var modules/cost_ledger.py reads for `unit` — keep in step with price_env_var(). */
export function priceEnvVar(unit: string): string {
  return PRICE_ENV_PREFIX + unit.toUpperCase();
}
