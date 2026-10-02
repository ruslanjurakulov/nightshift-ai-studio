import { notFound } from "next/navigation";
import { isOperator } from "@/lib/auth/org-roles";
import { StyleGuide } from "@/components/design/StyleGuide";

export const dynamic = "force-dynamic";

/**
 * The living style guide (docs/design/IDENTITY.md): every token and primitive,
 * dark and light side by side. Platform admins only — the same operator gate
 * the operator-only sections use (lib/auth/org-roles isOperator: fail closed on
 * a failed lookup). Anyone else gets a plain 404, not a hint that it exists.
 * It reads no data and spends nothing.
 */
export default async function DesignPage() {
  if (!(await isOperator())) notFound();
  return <StyleGuide />;
}
