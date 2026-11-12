/**
 * Whose address a request came from (docs/GEO_BLOCK.md). Pure.
 *
 * On the self-hosted box nothing is in front of Caddy (the domain's A record points straight at the server), so the visitor is the
 * peer of Caddy's connection, and deploy/Caddyfile writes that address into ONE header on EVERY request it proxies, replacing
 * whatever the client sent: `X-Nightshift-Client-IP {remote_host}`. `web` publishes no port (deploy/docker-compose.yml), so Caddy is
 * the only way in. X-Forwarded-For, X-Real-IP, CF-Connecting-IP and True-Client-IP are NEVER read: a client can send any of them, and
 * Caddy passes them on (ledger BR-L-192).
 *
 * On a Vercel deployment (the platform sets VERCEL=1) there is no Caddy: a client could send our header there, so it is not read,
 * and the platform's own `x-vercel-forwarded-for` is (Vercel sets it and a visitor cannot).
 *
 * Anything that is not exactly one address is null ("unknown"), never a guess.
 */
import { parseIp } from "@/lib/geo/table";

export const CLIENT_IP_HEADER = "x-nightshift-client-ip";
const VERCEL_IP_HEADER = "x-vercel-forwarded-for";

/** True on Vercel's own deploys, never on the self-hosted box (docs/DEPLOY_AX42.md sets no such variable). */
export const ON_VERCEL = process.env.VERCEL === "1";

export function trustedClientIp(headers: Pick<Headers, "get">, onVercel: boolean = ON_VERCEL): string | null {
  const raw = headers.get(onVercel ? VERCEL_IP_HEADER : CLIENT_IP_HEADER);
  if (raw === null) return null;
  const s = raw.trim();
  // One address: a list would mean something other than our proxy wrote it.
  if (!s || s.includes(",") || s.includes(" ")) return null;
  return parseIp(s) ? s : null;
}

/**
 * The same address as a key for a per-address rate limit (never stored, never logged). "unknown" when there is none: every such
 * request then shares one bucket, which is the safe side of a limit (local development, a request that did not come through Caddy).
 */
export function clientAddressKey(headers: Pick<Headers, "get">, onVercel: boolean = ON_VERCEL): string {
  return trustedClientIp(headers, onVercel) ?? "unknown";
}
