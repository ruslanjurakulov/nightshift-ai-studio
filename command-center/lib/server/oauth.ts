import "server-only";
import type { Rpc } from "@/lib/api/operations";
import { apiRpc } from "@/lib/server/public-api";
import { createClient } from "@/lib/supabase/server";
import { oauthEndpoints, oauthOrigin, resourceUrl } from "@/lib/oauth/config";
import type { OauthDeps } from "@/lib/oauth/endpoints";

/**
 * The server half of MCP over OAuth: the anon-key database call the
 * unauthenticated endpoints run on (no session, no service key — CLAUDE.md #3;
 * every function checks the secret it is handed), and the signed-in person's
 * own client for the consent screen's two functions.
 */

export function oauthDeps(): OauthDeps {
  const origin = oauthOrigin();
  return { rpc: apiRpc, origin, resource: resourceUrl(origin) };
}

export { oauthEndpoints };

export type ConsentView =
  | { ok: false; error: string; redirectOk?: boolean; description?: string }
  | { ok: true; entitled: false; clientName: string; workspaceName: string; plan: string | null }
  | {
      ok: true;
      entitled: true;
      clientName: string;
      redirectUri: string;
      workspaceName: string;
      plan: string | null;
      scopes: string[];
      defaultLimit: number;
      maxLimit: number;
      exempt: boolean;
    };

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The consent screen's data, asked as the signed-in person. */
export async function beginAuthorization(args: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  method: string;
  state: string | null;
  scope: string | null;
  resource: string;
  secretHash: string;
}): Promise<ConsentView | "unavailable"> {
  const supabase = await createClient();
  if (!supabase) return "unavailable";
  const { data, error } = await supabase.rpc("oauth_begin_authorization", {
    p_client_id: args.clientId,
    p_redirect_uri: args.redirectUri,
    p_code_challenge: args.codeChallenge,
    p_method: args.method,
    p_state: args.state,
    p_scope: args.scope,
    p_resource: args.resource,
    p_secret_hash: args.secretHash,
  });
  if (error) return "unavailable";
  const r = obj(data);
  if (r.ok !== true)
    return { ok: false, error: str(r.error, "server_error"), redirectOk: r.redirect_ok === true, description: str(r.description) || undefined };
  if (r.entitled === false)
    return { ok: true, entitled: false, clientName: str(r.client_name), workspaceName: str(r.workspace_name), plan: str(r.plan) || null };
  return {
    ok: true,
    entitled: true,
    clientName: str(r.client_name),
    redirectUri: str(r.redirect_uri),
    workspaceName: str(r.workspace_name),
    plan: str(r.plan) || null,
    scopes: Array.isArray(r.scopes) ? (r.scopes as unknown[]).filter((s): s is string => typeof s === "string") : [],
    defaultLimit: num(r.default_limit_credits, 500),
    maxLimit: num(r.max_limit_credits, 20000),
    exempt: r.exempt === true,
  };
}

export type DecisionResult =
  | { ok: true; allowed: boolean; redirectUri: string; state: string | null }
  | { ok: false; error: string };

/** Allow or deny, as the signed-in person. The code's hash goes in; the code stays here. */
export async function decideAuthorization(args: {
  secretHash: string;
  allow: boolean;
  limit: number | null;
  codeHash: string;
}): Promise<DecisionResult | "unavailable"> {
  const supabase = await createClient();
  if (!supabase) return "unavailable";
  const { data, error } = await supabase.rpc("oauth_decide_authorization", {
    p_secret_hash: args.secretHash,
    p_allow: args.allow,
    p_limit: args.limit,
    p_code_hash: args.codeHash,
  });
  if (error) return "unavailable";
  const r = obj(data);
  if (r.ok === true) return { ok: true, allowed: r.allowed === true, redirectUri: str(r.redirect_uri), state: typeof r.state === "string" ? r.state : null };
  return { ok: false, error: str(r.error, "server_error") };
}

/** Kept for tests that inject their own database. */
export type { Rpc };
