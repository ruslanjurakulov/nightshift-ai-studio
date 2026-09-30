/**
 * Which MCP requests must be checked against the key before the transport
 * answers them: anything that is not purely tool calls (initialize,
 * tools/list, ping…). Tool calls are checked — and counted — by the
 * operation they run, so checking them here too would count them twice.
 */
export function needsKeyCheck(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return true;
  return messages.some((m) => {
    const method = m && typeof m === "object" ? (m as { method?: unknown }).method : undefined;
    // Notifications and responses from the client carry no method we answer.
    if (typeof method !== "string") return false;
    return method !== "tools/call" && !method.startsWith("notifications/");
  });
}
