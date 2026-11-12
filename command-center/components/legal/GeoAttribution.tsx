import { BLOCKED_COUNTRIES } from "@/lib/geo/blocked";

/**
 * The DB-IP credit (docs/GEO_BLOCK.md). DB-IP's licence (CC BY 4.0) asks a web application to link back to db-ip.com on pages that
 * use results from its database, so every page whose model picker is filtered by the request's country carries this line: the
 * Studio, Home (its assistant), Workflows and the region editor. Nothing is shown while no model has a country list, because
 * nothing is looked up then.
 */
export function GeoAttribution({ label }: { label: string }) {
  if (Object.keys(BLOCKED_COUNTRIES).length === 0) return null;
  return (
    <p className="text-xs text-[var(--color-muted)]" data-testid="geo-attribution">
      <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        {label}
      </a>
    </p>
  );
}
