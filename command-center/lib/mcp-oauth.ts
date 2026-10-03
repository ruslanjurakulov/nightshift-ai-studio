/**
 * Whether the MCP server's sign-in (OAuth) is live, which decides what /mcp
 * promises.
 *
 *  - The flag is `MCP_OAUTH_LIVE=1`, read at request time from the server's
 *    environment (never `NEXT_PUBLIC_`). Anything else, including unset, is OFF.
 *  - OFF: the Claude and ChatGPT tabs say "Coming soon" and name what works
 *    today (an API key from a client that can send a header). Every other tab
 *    shows its API-key steps.
 *  - ON: the Claude and ChatGPT tabs show the real connector steps (the server
 *    URL and a sign-in, no key), and the other primary tabs lead with sign-in
 *    and keep the API key under "Use an API key instead".
 *
 * Switch it on only after the OAuth branch (claude/mcp-oauth) is merged,
 * deployed and tested with a real connector: until then the server accepts API
 * keys only (docs/MCP.md) and a connector cannot connect.
 */
export const MCP_OAUTH_FLAG = "MCP_OAUTH_LIVE";

/** On only for the literal "1". "true", "yes", " 1" and the empty string are off. */
export function mcpOauthLive(env?: Record<string, string | undefined>): boolean {
  // A literal read of the variable's name, because the deploy template test
  // scans for those; an injected map is for tests.
  const value = env ? env[MCP_OAUTH_FLAG] : process.env.MCP_OAUTH_LIVE;
  return value === "1";
}
