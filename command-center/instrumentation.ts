/**
 * Runs once when the server starts (Next.js instrumentation). The country table must load when a model has a country list
 * (docs/GEO_BLOCK.md): checkGeoTableAtStartup logs loudly if it does not. Node runtime only: the table is read from disk, and the
 * condition is written inline so the edge build drops the import (Next.js's documented pattern).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
