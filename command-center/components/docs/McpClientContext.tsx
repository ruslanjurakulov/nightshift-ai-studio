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
};

const Ctx = createContext<Value | null>(null);

export function McpClientProvider({
  initialId,
  names,
  marks,
  children,
}: {
  initialId: string;
  names: Record<string, string>;
  marks: Record<string, React.ReactNode>;
  children: React.ReactNode;
}) {
  const [active, setActive] = useState(initialId in names ? initialId : Object.keys(names)[0]);
  const value = useMemo(() => ({ active, setActive, names, marks }), [active, names, marks]);
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

/** The open assistant's logo, decorative (its name is always in the text beside it). */
export function ClientMark() {
  const { active, marks } = useMcpClient();
  return <span className="ml-client-mark" aria-hidden>{marks[active]}</span>;
}

/** A sentence with `{client}` in it, with the open assistant's name in its place. */
export function ClientText({ template }: { template: string }) {
  const { active, names } = useMcpClient();
  return <>{template.replace("{client}", names[active])}</>;
}
