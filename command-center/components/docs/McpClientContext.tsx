"use client";

import { createContext, useContext, useMemo, useState } from "react";

/**
 * Which assistant tab is open on /mcp. The connect card at the top owns the
 * choice (and writes ?tab= to the address); the long page below reads it, so
 * "Brief the work in {client}" and the chat card's header name the assistant the
 * person picked. The server renders the first paint from `?tab=`, so a shared
 * link shows the right name with no flash; every mark is drawn on the server and
 * only picked here (no logo data travels in the client bundle).
 */
type Value = {
  active: string;
  setActive: (id: string) => void;
  names: Record<string, string>;
  marks: Record<string, React.ReactNode>;
  /** True while the open tab is an assistant that cannot connect yet ("coming soon"): the page then speaks of "your assistant". */
  soon: boolean;
};

const Ctx = createContext<Value | null>(null);

export function McpClientProvider({
  initialId,
  names,
  marks,
  soonIds = [],
  children,
}: {
  initialId: string;
  names: Record<string, string>;
  marks: Record<string, React.ReactNode>;
  /** Tabs of assistants that are "coming soon" (MCP_OAUTH_LIVE off: Claude and ChatGPT). */
  soonIds?: readonly string[];
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(Object.hasOwn(names, initialId) ? initialId : Object.keys(names)[0]);
  const soon = soonIds.includes(active);
  const value = useMemo(() => ({ active, setActive, names, marks, soon }), [active, names, marks, soon]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMcpClient(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMcpClient needs <McpClientProvider>");
  return v;
}

/** The open assistant's name. */
export function ClientName() {
  const { active, names } = useMcpClient();
  return <span className="ml-client-name">{names[active]}</span>;
}

/** The open assistant's logo, decorative (its name is always in the text beside it). Nothing while the assistant cannot connect yet. */
export function ClientMark() {
  const { active, marks, soon } = useMcpClient();
  if (soon) return null;
  return <span className="ml-client-mark" aria-hidden>{marks[active]}</span>;
}

/** "Mark + name" beside "Your assistant" in the scripted chat; not shown for an assistant that cannot connect yet. */
export function ClientBadge() {
  const { soon } = useMcpClient();
  if (soon) return null;
  return (
    <span className="ml-msg-client">
      <ClientMark />
      <ClientName />
    </span>
  );
}

/**
 * A sentence with `{client}` in it, with the open assistant's name in its place. `soonTemplate` replaces it while the
 * open assistant cannot connect yet (it may still name the assistant: "{client} will connect with a sign-in soon").
 */
export function ClientText({ template, soonTemplate }: { template: string; soonTemplate?: string }) {
  const { active, names, soon } = useMcpClient();
  return <>{(soon && soonTemplate ? soonTemplate : template).replace("{client}", names[active])}</>;
}
