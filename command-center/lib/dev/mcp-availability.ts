/**
 * What /mcp (and anything that links into an assistant, such as a "Try in ChatGPT" button) may say about each assistant,
 * in ONE place. Read it with `mcpClientAvailability(id, mcpOauthLive())`; never decide it from a client's label or from the
 * environment flag alone.
 *
 * Two facts decide it:
 *  1. Whether the server's sign-in is switched on for this deployment: MCP_OAUTH_LIVE (lib/mcp-oauth.ts). Off, every
 *     sign-in-only assistant is "soon", whatever is written below: the sign-in it would start does not exist here.
 *  2. How far each assistant's sign-in has been checked, MCP_SIGN_IN below. Three words, and only the first may be read as
 *     "it works":
 *       "confirmed"  — the site's owner connected the product itself (a real ChatGPT / Claude / … account) and it worked.
 *       "ready"      — the server meets the vendor's PUBLISHED requirements for a custom server, and a scripted sign-in
 *                      shaped exactly like that vendor's (its own callback address, its registration, the resource
 *                      parameter, the issuer check, form-encoded token and refresh calls) passed against the real
 *                      Command Center (scripts/oauth-e2e.mjs). Nobody has yet connected the product itself.
 *       "documented" — the steps come from the vendor's documentation and nothing more has been checked here.
 *
 * Evidence for "ready" (read 2026-11-13; docs/MCP.md has the full table):
 *  - ChatGPT: https://developers.openai.com/api/docs/guides/custom-mcp-server and https://developers.openai.com/plugins/build/auth
 *    (streaming HTTP; OAuth with DCR when the server offers no Client ID Metadata Document; S256; `resource` on the
 *    authorization and token requests; `iss` on every authorization response, which makes ChatGPT use its stable callback
 *    https://chatgpt.com/connector_platform_oauth_redirect; the registered client kept while the connection is in use,
 *    migration 0161).
 *  - Claude: https://claude.com/docs/connectors/building/authentication (401 with resource_metadata; `resource` equal to the
 *    URL as entered; DCR, which Claude uses when no CIMD is advertised; S256; callback https://claude.ai/api/mcp/auth_callback;
 *    form-encoded token endpoint; invalid_grant for a dead refresh token; rotation).
 *
 * When the owner has connected one for real, change its word to "confirmed" here (one line, with the date in the commit):
 * the "ready" note on its /mcp tab then goes away by itself.
 */
import { MCP_CLIENTS } from "@/lib/dev/mcp-clients";

export type McpSignInCheck = "confirmed" | "ready" | "documented";

/** How far each assistant's sign-in has been checked. Every id of MCP_CLIENTS, nothing else (tests pin both). */
export const MCP_SIGN_IN: Readonly<Record<string, McpSignInCheck>> = {
  chatgpt: "ready",
  claude: "ready",
  gemini: "documented",
  grok: "documented",
  cursor: "documented",
  vscode: "documented",
};

/**
 * What a page may say about an assistant right now:
 *  - "available":  it connects today and that has been seen (an API key in Cursor / VS Code, or a sign-in the owner confirmed);
 *  - "ready":      sign-in is on and meets the vendor's published requirements; show the steps, do not say "works in …";
 *  - "unverified": sign-in is on and the steps are the vendor's own; nothing more is known;
 *  - "soon":       sign-in is off for this deployment, and this assistant has no other way in.
 */
export type McpAvailability = "available" | "ready" | "unverified" | "soon";

export function mcpClientAvailability(id: string, oauthLive: boolean): McpAvailability {
  const client = MCP_CLIENTS.find((c) => c.id === id);
  if (!client) return "soon";
  const check = Object.hasOwn(MCP_SIGN_IN, id) ? MCP_SIGN_IN[id] : "documented";
  // An assistant that takes an API key connects with one today, sign-in or not.
  if (!client.oauthOnly) return "available";
  if (!oauthLive) return "soon";
  return check === "confirmed" ? "available" : check === "ready" ? "ready" : "unverified";
}

/**
 * Whether a link may send a person into that assistant to connect Nightshift ("Try in ChatGPT", "Add to Claude"): only
 * when connecting can actually work today and has been checked at least as far as "ready". "unverified" and "soon" may not.
 */
export function mcpConnectOffered(id: string, oauthLive: boolean): boolean {
  const a = mcpClientAvailability(id, oauthLive);
  return a === "available" || a === "ready";
}
