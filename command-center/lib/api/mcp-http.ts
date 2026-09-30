/**
 * Which MCP requests must be checked against the key before the transport
 * answers them: everything that is not purely tool calls — initialize,
 * tools/list, ping, and also notifications and client responses. Tool calls
 * are checked — and counted — by the operation they run, so checking them
 * here too would count them twice.
 *
 * Notifications used to pass unchecked on the reasoning that nothing is
 * answered to them; but the transport still accepts them (202) for any
 * well-formed key, revoked or unknown, which made the endpoint an uncounted
 * oracle and a free request path. Every accepted request now costs one
 * counted key check.
 */
export function needsKeyCheck(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return true;
  return messages.some((m) => {
    const method = m && typeof m === "object" ? (m as { method?: unknown }).method : undefined;
    return method !== "tools/call";
  });
}

/**
 * The HTTP methods the endpoint serves. It is stateless (no session ids, JSON
 * responses): there is no standalone SSE stream to open with GET and no
 * session to end with DELETE, so both are refused with 405 before anything —
 * the SDK would otherwise serve them without the key ever reaching the
 * database. The Streamable HTTP spec allows exactly this for a server that
 * offers no stream.
 */
export const MCP_METHODS = ["POST"] as const;
