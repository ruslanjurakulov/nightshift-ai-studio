/**
 * Whose address a request came from (docs/GEO_BLOCK.md). Pure.
 *
 * The one header read is the one deploy/Caddyfile writes on EVERY request it proxies, replacing whatever the client sent:
 * Cloudflare's CF-Connecting-IP when the connection came from one of Cloudflare's published ranges, else the address of the peer
 * itself. `web` publishes no port (deploy/docker-compose.yml), so Caddy is the only way in. X-Forwarded-For, X-Real-IP and
 * CF-Connecting-IP are NEVER read here: a client can send any of them, and Caddy passes them on.
 *
 * Anything that is not exactly one address is null ("unknown"), never a guess.
 */
import { parseIp } from "@/lib/geo/table";

export const CLIENT_IP_HEADER = "x-nightshift-client-ip";

export function trustedClientIp(headers: Pick<Headers, "get">): string | null {
  const raw = headers.get(CLIENT_IP_HEADER);
  if (raw === null) return null;
  const s = raw.trim();
  // One address: a list would mean something other than Caddy wrote it.
  if (!s || s.includes(",") || s.includes(" ")) return null;
  return parseIp(s) ? s : null;
}
